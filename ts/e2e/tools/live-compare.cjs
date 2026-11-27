// Direct vs through-cyrano, in the same browser: what page code and the upstream
// observe. Start the proxy (go/scripts/run.sh), then from ts/e2e:
//   node tools/live-compare.cjs https://example.com/ https://httpbin.org/headers
// SHOWTEXT=1 prints both pages' text (httpbin shows what the upstream received).
const { chromium } = require("playwright");
const PROXY = process.env.PROXY || "http://localhost:9081"; // PROXY=https://localhost:9443 for a TLS instance
const PROXY_HOST = PROXY.replace(/^https?:\/\//, "");
const REFUSED = "https://cyrano-refused.invalid/"; // the proxy's CSP refusal redirect (Go urlrewrite.CSPRefusalLocation)
const sites = process.argv.slice(2);
// Real Chrome with a window, by default. Playwright's headless shell says
// "HeadlessChrome" in its user agent, has navigator.webdriver true and no
// plugins: Cloudflare and Akamai refuse it on both sides, so a page is never
// judged (11% of a 2026-11-26 walk; 1% headed). HEADLESS=1 only on purpose.
// The window goes on the nested display (CRN_DISPLAY, default :97, a Xephyr
// window), never the desktop's.
const HEADED = process.env.HEADLESS !== "1";
const DISPLAY_ = process.env.CRN_DISPLAY || ":97";
if (HEADED) {
  const r = require("node:child_process").spawnSync("xdpyinfo", [], { env: { ...process.env, DISPLAY: DISPLAY_ }, stdio: "ignore" });
  if (r.status !== 0) { console.error(`live-compare: display ${DISPLAY_} is not up (start: Xephyr ${DISPLAY_} -screen 1600x1000 &), or HEADLESS=1 on purpose`); process.exit(2); }
} else console.error("live-compare: HEADLESS=1 — bot-protected sites refuse this browser on both sides");
const assist = require("./assist.cjs");
const ads = require("./ads.cjs");
const prox = (u) => assist.proxify(PROXY, u);

const probe = () => {
  const txt = (document.body && document.body.innerText) || "";
  return {
    title: document.title, URL: document.URL, baseURI: document.baseURI, domain: document.domain, origin: window.origin,
    referrer: document.referrer, cookieNames: document.cookie.split("; ").map((c) => c.split("=")[0]).filter(Boolean).sort().join(","),
    // Ads left out (ads.cjs MASK marked them; innerText skips hidden ones).
    elements: [...document.getElementsByTagName("*")].filter((e) => !e.closest("[data-crn-mask]")).length, textLen: txt.length, text: txt.slice(0, 4000),
    scripts: [...document.scripts].filter((e) => !e.closest("[data-crn-mask]")).length, links: [...document.querySelectorAll("a[href]")].filter((a) => !a.closest("[data-crn-mask]")).slice(0, 300).map((a) => a.href),
    imgs: [...document.images].slice(0, 100).map((i) => i.src), fetchStr: Function.prototype.toString.call(fetch),
    globals: Object.getOwnPropertyNames(window).filter((n) => /rewriter|crn|cyrano/i.test(n)).join(","),
  };
};

// The share of pixels that differ between two screenshots of the viewport
// (decoded and compared by the browser itself: no image library here).
// Ads, carousels and video differ run to run; a page that renders
// differently differs by much more.
async function pixelDiff(browser, a, b) {
  if (!a || !b) return null;
  const ctx = await browser.newContext(); const page = await ctx.newPage();
  try {
    return await page.evaluate(async ([x, y]) => {
      const load = (src) => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = src; });
      const [ia, ib] = await Promise.all([load(x), load(y)]);
      const w = Math.min(ia.width, ib.width), h = Math.min(ia.height, ib.height);
      const px = (img) => { const c = document.createElement("canvas"); c.width = w; c.height = h; const g = c.getContext("2d"); g.drawImage(img, 0, 0); return g.getImageData(0, 0, w, h).data; };
      const da = px(ia), db = px(ib); let n = 0;
      for (let i = 0; i < da.length; i += 4) if (Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]) > 48) n++;
      return n / (w * h);
    }, ["data:image/png;base64," + a.toString("base64"), "data:image/png;base64," + b.toString("base64")]);
  } catch { return null; } finally { await ctx.close(); }
}

// The original URL a proxied one stands for (the path's %25 read back).
function unprox(u) {
  const m = /^https?:\/\/[^/]+\/cyrano\/(https?)(?:![a-z-]+)*\/([^/]+)(\/[^?#]*)?(.*)$/.exec(u);
  return m ? `${m[1]}://${m[2]}${(m[3] || "/").replace(/%25/g, "%")}${m[4]}` : null;
}
const siteOf = (h) => { const p = h.toLowerCase().split("."); return p.length > 2 && p[p.length - 2].length <= 3 && p[p.length - 1].length === 2 ? p.slice(-3).join(".") : p.slice(-2).join("."); };

// Waits until the page's title, URL and element count are unchanged for
// `still` ms (at most `max`).
async function settle(page, still = 1500, max = 10000) {
  // A navigation a click starts late (a page transition first) destroys
  // the context mid-wait: a failed read is a change, and the document must
  // have finished loading.
  const t0 = Date.now(); let last = "", since = Date.now();
  while (Date.now() - t0 < max) {
    const now = await page.evaluate(() => document.readyState === "complete" ? document.title + "|" + location.href + "|" + document.getElementsByTagName("*").length : "loading " + Math.random()).catch(() => "failed " + Math.random());
    if (now !== last) { last = now; since = Date.now(); } else if (Date.now() - since >= still) return;
    await page.waitForTimeout(250);
  }
}

// Clicks around the proxied page as a person would: CLICKS times, a random
// visible link of the same site, by a real click. Each step must stay on
// the proxy and load; its destination is then loaded direct and compared.
async function clickAround(browser, url, n) {
  const out = [];
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  const escaped = [], errors = [];
  page.on("request", (r) => { const u = r.url(); if (/^https?:/.test(u) && !u.startsWith(PROXY) && !u.startsWith(REFUSED)) escaped.push(u.slice(0, 140)); });
  page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 300)));
  ctx.on("page", (p) => p.on("request", (r) => { const u = r.url(); if (/^https?:/.test(u) && !u.startsWith(PROXY) && !u.startsWith(REFUSED)) escaped.push("(new tab) " + u.slice(0, 130)); }));
  const site = siteOf(new URL(url).hostname);
  try {
    await page.goto(prox(url), { waitUntil: "load", timeout: 45000 });
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    const tried = new Set();
    for (let i = 0; i < n; i++) {
      try { await page.evaluate(ads.MASK); } catch {}
      // The links a person could click: visible, on screen after scrolling, of this site.
      const links = await page.evaluate(() => [...document.querySelectorAll("a[href]")].map((a, k) => { a.setAttribute("data-crn-k", String(k)); const r = a.getBoundingClientRect(); const cs = getComputedStyle(a);
        return { k, href: a.href, raw: a.getAttribute("href") || "", ok: r.width > 4 && r.height > 4 && cs.visibility === "visible" && cs.display !== "none" && !a.closest("[data-crn-mask]") }; })).catch(() => []);
      const cand = links.filter((l) => l.ok && !tried.has(l.href) && /^https?:/.test(l.href) && !/^(#|javascript:|mailto:|tel:)/i.test(l.raw) && !/log(out|off)|sign.?out|delete|unsubscribe/i.test(l.href) && (() => { try { return siteOf(new URL(l.href).hostname) === site; } catch { return false; } })());
      if (!cand.length) { out.push(`  click ${i + 1}: no same-site link to click`); break; }
      const pick = cand[Math.floor(Math.random() * cand.length)]; tried.add(pick.href);
      const from = page.url(); const esc0 = escaped.length, err0 = errors.length;
      let status = 0;
      const onResp = (r) => { if (r.request().isNavigationRequest() && r.frame() === page.mainFrame()) status = r.status(); };
      page.on("response", onResp);
      // A link that would open a new tab is followed in this one: the click is what is tested.
      await page.evaluate((k) => { const a = document.querySelector(`[data-crn-k="${k}"]`); if (a) a.removeAttribute("target"); }, pick.k).catch(() => {});
      let how = "click";
      try { await page.locator(`[data-crn-k="${pick.k}"]`).first().click({ timeout: 6000 }); }
      catch {
        // Something covers it (a consent banner): the link is followed by a
        // programmatic click, which still goes through the proxy's page.
        how = "js click";
        try { await page.evaluate((k) => document.querySelector(`[data-crn-k="${k}"]`).click(), pick.k); } catch { how = "click failed"; }
      }
      await page.waitForLoadState("load", { timeout: 30000 }).catch(() => {});
      await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
      // An in-app navigation (pushState) has no load to wait for: the app
      // renders after it. Counted once title, URL and element count have
      // stood still for 1.5 s (at most 10 s), as the direct load is complete.
      await settle(page);
      page.off("response", onResp);
      const now = page.url(), orig = unprox(now);
      const title = await page.title().catch(() => "");
      const els = await page.evaluate(() => document.getElementsByTagName("*").length).catch(() => 0);
      const moved = now !== from;
      let line = `  click ${i + 1} (${how}): ${pick.href.slice(0, 110)}`;
      const bad = [];
      if (!now.startsWith(PROXY)) bad.push(`LEFT THE PROXY: ${now.slice(0, 120)}`);
      if (how === "click failed") bad.push("could not click");
      else if (!moved) line += " (stayed on the page: in-page link or script)";
      if (status >= 400) bad.push(`status ${status}`);
      if (escaped.length > esc0) bad.push(`${escaped.length - esc0} requests escaped, e.g. ${escaped[esc0]}`);
      if (errors.length > err0) line += `  [page errors: ${errors.slice(err0, err0 + 2).join(" | ").slice(0, 200)}]`;
      // The same destination, direct.
      if (moved && orig) {
        const dctx = await browser.newContext(); const dp = await dctx.newPage(); let dstatus = 0;
        try { const r = await dp.goto(orig, { waitUntil: "load", timeout: 45000 }); dstatus = r ? r.status() : 0; await dp.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {}); await settle(dp); } catch {}
        const dtitle = await dp.title().catch(() => ""), dels = await dp.evaluate(() => document.getElementsByTagName("*").length).catch(() => 0);
        await dctx.close();
        line += `\n      proxied ${status || "-"} "${title.slice(0, 60)}" ${els} el | direct ${dstatus || "-"} "${dtitle.slice(0, 60)}" ${dels} el`;
        if (dtitle !== title) bad.push("title differs from direct");
        if (dels && els < 0.7 * dels) bad.push(`renders ${dels - els} fewer elements than direct`);
        const ch = assist.challenged({ status: dstatus, title: dtitle, elements: dels });
        if (ch) line += ` (direct: ${ch})`;
      }
      out.push(line + (bad.length ? `\n      CLICK PROBLEM: ${bad.join("; ")}` : ""));
    }
  } catch (e) { out.push(`  click-around: ${String(e.message).split("\n")[0].slice(0, 160)}`); }
  await ctx.close();
  return out;
}

async function visit(browser, url, viaProxy) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  const errors = [], failed = [], escaped = [], refusedFollowed = [];
  page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 600)));
  page.on("console", (m) => { if (m.type() === "error" && !ads.namesAd(m.text()) && !ads.namesAd(m.location()?.url || "")) errors.push("console: " + m.text().slice(0, 600)); }); // cut on output: a proxied URL is longer
  page.on("requestfailed", (r) => ads.isAd(r.url()) || failed.push(`${r.failure()?.errorText} ${r.url().slice(0, 120)}`));
  // The proxy's CSP refusal redirect (spec Csp.refusalLocation), followed
  // where the browser's policy admitted it: no escape (it resolves
  // nowhere, carries nothing), counted apart.
  page.on("request", (r) => { const u = r.url(); if (viaProxy && /^https?:/.test(u) && !u.startsWith(PROXY)) (u.startsWith(REFUSED) ? refusedFollowed : escaped).push(u.slice(0, 140)); });
  let status = 0, navErr = "";
  try {
    const resp = await page.goto(viaProxy ? prox(url) : url, { waitUntil: "load", timeout: 45000 });
    status = resp ? resp.status() : 0;
    await page.waitForTimeout(2500);
    // A challenge page: give it time to pass and reload.
    for (let i = 0; i < 24 && /just a moment|attention required/i.test(await page.title().catch(() => "")); i++) await page.waitForTimeout(500);
    if (HEADED) await page.waitForTimeout(1500);
    // A challenge that passes reloads the page (an AWS WAF 202, Cloudflare):
    // read it once its network has settled, on both sides alike.
    await page.waitForLoadState("networkidle", { timeout: 12000 }).catch(() => {});
  } catch (e) { navErr = String(e.message).split("\n")[0].slice(0, 160); }
  let p = null, shot = null, dom = null, masked = 0;
  try { masked = await page.evaluate(ads.MASK); } catch { /* a page that went away */ }
  try { shot = await page.screenshot({ timeout: 8000 }); } catch { /* none */ }
  try { dom = await page.evaluate(ads.DOM); } catch { /* none */ }
  try { p = await page.evaluate(probe); } catch (e) { navErr += " | probe: " + String(e.message).slice(0, 120); }
  await ctx.close();
  return { status, navErr, p, errors, failed, escaped, refusedFollowed, shot, dom, masked };
}

(async () => {
  const browser = await chromium.launch(HEADED
    ? { channel: "chrome", headless: false, env: { ...process.env, DISPLAY: DISPLAY_ }, args: ["--disable-blink-features=AutomationControlled", "--mute-audio"] }
    : { args: ["--mute-audio"] });
  for (const url of sites) {
    const [d, v] = [await visit(browser, url, false), await visit(browser, url, true)];
    // A challenge or bot refusal on either side: the comparison tells
    // nothing; the site goes on the human-assist list (assist.cjs).
    const why = [["direct", d], ["proxied", v]].map(([side, r]) => { const c = r.p ? assist.challenged({ status: r.status, title: r.p.title, text: r.p.text, elements: r.p.elements }) : null; return c && `${side}: ${c}`; }).filter(Boolean).join("; ");
    if (why && process.env.NO_ASSIST !== "1") assist.record(url, why, process.env.ASSIST_FROM || "live-compare");
    const out = [`\n=== ${url}`, `  status: direct ${d.status}${d.navErr ? " (" + d.navErr + ")" : ""} | cyrano ${v.status}${v.navErr ? " (" + v.navErr + ")" : ""}`];
    if (d.p && v.p) {
      for (const k of ["title", "URL", "baseURI", "domain", "origin", "referrer", "cookieNames", "fetchStr"]) {
        if (d.p[k] !== v.p[k]) out.push(`  DIFF ${k}: direct ${JSON.stringify(d.p[k])} | cyrano ${JSON.stringify(v.p[k])}`);
      }
      out.push(`  elements ${d.p.elements} | ${v.p.elements}   text ${d.p.textLen} | ${v.p.textLen}   scripts ${d.p.scripts} | ${v.p.scripts}`);
      const leak = (xs) => xs.filter((x) => x.includes(PROXY_HOST) || x.includes("/cyrano/"));
      const ll = leak(v.p.links), li = leak(v.p.imgs);
      if (ll.length) out.push(`  LEAK a.href shows proxy URLs: ${ll.length} e.g. ${ll[0]}`);
      if (li.length) out.push(`  LEAK img.src shows proxy URLs: ${li.length} e.g. ${li[0]}`);
      const dl = new Set(d.p.links), miss = v.p.links.filter((x) => !dl.has(x));
      if (miss.length && !ll.length) out.push(`  links differ: ${miss.length} of ${v.p.links.length} not in direct, e.g. ${miss[0]}`);
      if (v.p.globals) out.push(`  globals visible: ${v.p.globals}`);
      if (/localhost:\d+|\/cyrano\//.test(v.p.text)) out.push(`  LEAK proxy URL in page text: ${(v.p.text.match(/.{0,60}(localhost:\d+|\/cyrano\/).{0,60}/) || [""])[0].replace(/\n/g, " ")}`);
      if (process.env.SHOWTEXT) out.push(`  --- direct text:\n${d.p.text.slice(0, 1500)}\n  --- cyrano text:\n${v.p.text.slice(0, 1500)}`);
    }
    if (why) out.push(`  HUMAN ASSIST (${why})${process.env.NO_ASSIST === "1" ? "" : ": recorded in " + assist.FILE.replace(/^.*\//, "")}`);
    if (d.dom && v.dom) {
      const x = ads.domDiff(d.dom, v.dom);
      const flag = x.onlyDirect + x.onlyProxied > Math.max(10, 0.02 * Math.max(...x.total)) || x.styles.length > Math.max(5, 0.02 * x.compared);
      out.push(`  ${flag ? "DOM DIFF" : "dom"}: ${x.total[0]} | ${x.total[1]} elements outside ads (${d.masked} | ${v.masked} ad slots hidden); only direct ${x.onlyDirect}, only proxied ${x.onlyProxied}; styles differ on ${x.styles.length} of ${x.compared}`);
      if (flag) {
        for (const [k, n] of x.exD) out.push(`    only direct ×${n}: ${k}`);
        for (const [k, n] of x.exV) out.push(`    only proxied ×${n}: ${k}`);
        for (const [k, w] of x.styles.slice(0, 5)) out.push(`    style: ${k}: ${w}`);
      }
    }
    const vis = await pixelDiff(browser, d.shot, v.shot);
    if (vis !== null) {
      const pct = (100 * vis).toFixed(1);
      if (vis >= 0.15 && process.env.SHOTS) {
        const fs = require("node:fs"), path = require("node:path"); fs.mkdirSync(process.env.SHOTS, { recursive: true });
        const base = path.join(process.env.SHOTS, new URL(url).host.replace(/^www\./, "") + "-" + Date.now());
        fs.writeFileSync(base + "-direct.png", d.shot); fs.writeFileSync(base + "-proxied.png", v.shot);
        out.push(`  VISUAL ${pct}% of pixels differ: ${base}-{direct,proxied}.png`);
      } else out.push(`  visual: ${pct}% of pixels differ`);
    }
    out.push(`  errors ${d.errors.length} | ${v.errors.length}   failed requests ${d.failed.length} | ${v.failed.length}   escaped the proxy: ${v.escaped.length}`);
    // Errors compared with proxied URLs read as the originals (marks and
    // policy taken out) and blob: origins dropped, so a message naming a URL
    // matches its direct twin. (Which blob: is not compared.)
    const plain = (e) => String(e)
      // (a proxied URL's path writes '%' as %25: read back)
      .replace(/https?:\/\/localhost:\d+\/cyrano\/(https?)(?:![a-z-]+)*\/([^\s'")?#]*)/g, (_m, sch, rest) => `${sch}://${rest.replace(/%25/g, "%")}`)
      .replace(/blob:[^\s'")]+/g, "blob:")
      // A request that fails upstream (no such host, refused, CORS, ORB) is
      // a closed connection through the proxy (ERR_EMPTY_RESPONSE) and its
      // own net error direct: page code sees the same failure.
      .replace(/net::ERR_[A-Z_]+/g, "net::ERR")
      // A CSP message quotes the policy, which proxied also admits the proxy.
      .replace(/(Content Security Policy directive:? )"[^"]*"/g, '$1"…"')
      .replace(/(the following Content Security Policy directive: )"[^"]*"/g, '$1"…"');
    const de = new Set(d.errors.map(plain));
    for (const e of [...new Set(v.errors)].filter((e) => !de.has(plain(e))).slice(0, 5)) out.push(`    cyrano-only error: ${e.slice(0, 200)}`);
    for (const e of [...new Set(v.escaped)].slice(0, 4)) out.push(`    escaped: ${e}`);
    if (v.refusedFollowed.length) out.push(`    CSP refusal redirect followed by the browser: ${v.refusedFollowed.length} (no violation event)`);
    for (const e of [...new Set(v.failed)].slice(0, 3)) out.push(`    cyrano failed: ${e}`);
    const clicks = Number(process.env.CLICKS || 0);
    if (clicks > 0 && v.status && v.status < 400 && !why) out.push(...await clickAround(browser, url, clicks));
    console.log(out.join("\n"));
  }
  await browser.close();
})();
