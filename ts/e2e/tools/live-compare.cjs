// Direct vs through-cyrano, in the same browser: what page code and the upstream
// observe. Start the proxy (go/scripts/run.sh), then from ts/e2e:
//   node tools/live-compare.cjs https://example.com/ https://httpbin.org/headers
// SHOWTEXT=1 prints both pages' text (httpbin shows what the upstream received).
const { chromium } = require("playwright");
const PROXY = process.env.PROXY || "http://localhost:9081"; // PROXY=https://localhost:9443 for a TLS instance
const PROXY_HOST = PROXY.replace(/^https?:\/\//, "");
const sites = process.argv.slice(2);
const prox = (u) => { const x = new URL(u); return `${PROXY}/cyrano/${x.protocol.slice(0, -1)}/${x.host}${x.pathname}${x.search}`; };

const probe = () => {
  const txt = (document.body && document.body.innerText) || "";
  return {
    title: document.title, URL: document.URL, baseURI: document.baseURI, domain: document.domain, origin: window.origin,
    referrer: document.referrer, cookieNames: document.cookie.split("; ").map((c) => c.split("=")[0]).filter(Boolean).sort().join(","),
    elements: document.getElementsByTagName("*").length, textLen: txt.length, text: txt.slice(0, 4000),
    scripts: document.scripts.length, links: [...document.querySelectorAll("a[href]")].slice(0, 300).map((a) => a.href),
    imgs: [...document.images].slice(0, 100).map((i) => i.src), fetchStr: Function.prototype.toString.call(fetch),
    globals: Object.getOwnPropertyNames(window).filter((n) => /rewriter|crn|cyrano/i.test(n)).join(","),
  };
};

async function visit(browser, url, viaProxy) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  const errors = [], failed = [], escaped = [];
  page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 160)));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text().slice(0, 160)); });
  page.on("requestfailed", (r) => failed.push(`${r.failure()?.errorText} ${r.url().slice(0, 120)}`));
  page.on("request", (r) => { const u = r.url(); if (viaProxy && /^https?:/.test(u) && !u.startsWith(PROXY)) escaped.push(u.slice(0, 140)); });
  let status = 0, navErr = "";
  try {
    const resp = await page.goto(viaProxy ? prox(url) : url, { waitUntil: "load", timeout: 45000 });
    status = resp ? resp.status() : 0;
    await page.waitForTimeout(2500);
    // A challenge page: give it time to pass and reload.
    for (let i = 0; i < 24 && /just a moment|attention required/i.test(await page.title().catch(() => "")); i++) await page.waitForTimeout(500);
    if (process.env.HEADED === "1") await page.waitForTimeout(1500);
  } catch (e) { navErr = String(e.message).split("\n")[0].slice(0, 160); }
  let p = null;
  try { p = await page.evaluate(probe); } catch (e) { navErr += " | probe: " + String(e.message).slice(0, 120); }
  await ctx.close();
  return { status, navErr, p, errors, failed, escaped };
}

(async () => {
  // HEADED=1: real Chrome with a window — sites behind an anti-bot challenge
  // refuse a headless browser even direct, so there is nothing to compare.
  const headed = process.env.HEADED === "1";
  const browser = await chromium.launch(headed
    ? { channel: "chrome", headless: false, args: ["--disable-blink-features=AutomationControlled"] }
    : {});
  for (const url of sites) {
    const [d, v] = [await visit(browser, url, false), await visit(browser, url, true)];
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
    out.push(`  errors ${d.errors.length} | ${v.errors.length}   failed requests ${d.failed.length} | ${v.failed.length}   escaped the proxy: ${v.escaped.length}`);
    // Errors compared with proxied URLs read as the originals (marks and
    // policy taken out) and blob: origins dropped, so a message naming a URL
    // matches its direct twin. (Which blob: is not compared.)
    const plain = (e) => String(e)
      .replace(/https?:\/\/localhost:\d+\/cyrano\/(https?)(?:![a-z-]+)*\//g, "$1://")
      .replace(/blob:[^\s'")]+/g, "blob:");
    const de = new Set(d.errors.map(plain));
    for (const e of [...new Set(v.errors)].filter((e) => !de.has(plain(e))).slice(0, 5)) out.push(`    cyrano-only error: ${e}`);
    for (const e of [...new Set(v.escaped)].slice(0, 4)) out.push(`    escaped: ${e}`);
    for (const e of [...new Set(v.failed)].slice(0, 3)) out.push(`    cyrano failed: ${e}`);
    console.log(out.join("\n"));
  }
  await browser.close();
})();
