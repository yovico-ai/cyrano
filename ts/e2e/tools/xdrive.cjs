// Drives a stock Chrome from outside: no DevTools protocol, no automation
// flags, no extension. The browser is started as a person starts it, on a
// hidden X display, and is given keyboard and pointer input through X
// (XTEST, by xdotool). What it did is read from outside too: the window's
// title (the document's), a screenshot of the display, and — for the
// proxied side — cyrano's own log.
//
// For the sites that refuse an automated browser direct as well
// (regression-sites.json, "chrome"): a Playwright-driven Chrome tells
// nothing about the proxy there.
//
//   DISPLAY=:98 node tools/xdrive.cjs [site-filter…]
//   PROXY=http://localhost:9081   the instance under test
//   PROFILE=<dir>                 Chrome profile, kept between runs (a
//                                 session that passed a challenge or signed
//                                 in stays so); default: a new one per run
//   OUT=<dir>                     screenshots and the report
//   SIDES=direct,proxied          which sides to run
//   LIST=human-assist.json        run the human-assist queue (assist.cjs)
//                                 instead of the regression list's "chrome"
//                                 sites; with HANDOFF_WAIT=<s> on a display
//                                 a person watches, it waits for them
//
// A challenge page or a sign-in form is not this tool's to answer. It
// stops there and hands over, to a command when one is configured:
//   XDRIVE_ON_CHALLENGE=<cmd>     run when a page stays a challenge
//   XDRIVE_ON_LOGIN=<cmd>         run at a step {"handoff":"login"}
// The command gets XDRIVE_DISPLAY, XDRIVE_WINDOW (X window id),
// XDRIVE_SHOT (a screenshot), XDRIVE_URL and XDRIVE_SIDE in its
// environment and drives the same display; when it exits, the run goes on.
// With no command the run waits HANDOFF_WAIT seconds (default 0) for a
// person, then records the page as it stands.
//
// Steps (a site's "x" in regression-sites.json; all optional):
//   {"wait": ms} {"key": "ctrl+l"} {"type": "text"} {"click": [x, y]}
//   {"go": "https://…"} {"shot": "name"} {"handoff": "login"}
//   {"expectTitle": "regexp"} {"refuseTitle": "regexp"}

const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DISPLAY = process.env.DISPLAY;
if (!DISPLAY || DISPLAY === ":0") { console.error("xdrive: run on a hidden display (DISPLAY=:98), never the desktop's"); process.exit(2); }
const PROXY = (process.env.PROXY || "http://localhost:9081").replace(/\/$/, "");
const OUT = process.env.OUT || fs.mkdtempSync(path.join(os.tmpdir(), "xdrive-"));
const SIDES = (process.env.SIDES || "direct,proxied").split(",");
const HANDOFF_WAIT = Number(process.env.HANDOFF_WAIT || 0) * 1000;
const { CHALLENGE } = require("./assist.cjs");
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);
const x = (...args) => { try { return execFileSync("xdotool", args, { env: { ...process.env, DISPLAY }, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return ""; } };

const assist = require("./assist.cjs");
const proxied = (url) => assist.proxify(PROXY, url);

// The pointer goes where a hand would take it: along a curve, in steps.
let at = [800, 500];
async function moveTo(tx, ty) {
  const [sx, sy] = at; const n = 14 + Math.floor(rand(0, 10));
  const cx = (sx + tx) / 2 + rand(-120, 120), cy = (sy + ty) / 2 + rand(-80, 80);
  for (let i = 1; i <= n; i++) {
    const t = i / n, e = t * t * (3 - 2 * t);
    const px = (1 - e) * (1 - e) * sx + 2 * (1 - e) * e * cx + e * e * tx;
    const py = (1 - e) * (1 - e) * sy + 2 * (1 - e) * e * cy + e * e * ty;
    x("mousemove", String(Math.round(px)), String(Math.round(py)));
    await sleep(rand(6, 22));
  }
  at = [tx, ty];
}
async function click(px, py) { await moveTo(px + rand(-3, 3), py + rand(-3, 3)); await sleep(rand(60, 180)); x("mousedown", "1"); await sleep(rand(40, 110)); x("mouseup", "1"); }
async function type(text) { for (const ch of text) { x("type", "--delay", "0", "--", ch); await sleep(rand(45, 160)); } }
const key = (k) => x("key", "--clearmodifiers", k);

function shot(name) {
  const file = path.join(OUT, name + ".png");
  try { execFileSync("import", ["-window", "root", file], { env: { ...process.env, DISPLAY }, stdio: "ignore" }); } catch { return null; }
  return file;
}

async function browserWindow(pid) {
  for (let i = 0; i < 60; i++) {
    const ids = x("search", "--onlyvisible", "--pid", String(pid), "--class", "chrome").split("\n").filter(Boolean);
    // The browser's own window is the titled one (helpers have none).
    for (const id of ids) if (x("getwindowname", id)) return id;
    await sleep(250);
  }
  return null;
}
const title = (win) => x("getwindowname", win).replace(/ - Google Chrome$/, "");

async function handoff(kind, win, url, side) {
  const cmd = process.env[kind === "login" ? "XDRIVE_ON_LOGIN" : "XDRIVE_ON_CHALLENGE"];
  const file = shot(`handoff-${kind}-${Date.now()}`);
  if (cmd) {
    await new Promise((done) => {
      const c = spawn(cmd, { shell: true, stdio: "inherit", env: { ...process.env, XDRIVE_DISPLAY: DISPLAY, XDRIVE_WINDOW: win, XDRIVE_SHOT: file || "", XDRIVE_URL: url, XDRIVE_SIDE: side } });
      c.on("exit", done); c.on("error", done);
    });
    return "handed to " + cmd.split(/\s+/)[0];
  }
  if (HANDOFF_WAIT > 0) {
    const was = title(win);
    for (let t = 0; t < HANDOFF_WAIT && title(win) === was; t += 500) await sleep(500);
    return title(win) === was ? "nobody answered" : "answered by hand";
  }
  return "no hook configured";
}

async function settle(win, ms) {
  // A page is taken as loaded when its title has stood still for a while.
  let last = title(win), still = 0;
  for (let t = 0; t < ms; t += 400) { await sleep(400); const now = title(win); if (now === last) { still += 400; if (still >= 2400 && t >= 3000) return; } else { last = now; still = 0; } }
}

async function goto(win, url) {
  // The display may have no window manager: keys go to the window the
  // pointer is in, and the address bar takes them once clicked.
  const g = x("getwindowgeometry", "--shell", win); const gx = Number(/X=(-?\d+)/.exec(g)?.[1] ?? 0), gy = Number(/Y=(-?\d+)/.exec(g)?.[1] ?? 0);
  await click(gx + 620 + rand(-80, 80), gy + 66);
  await sleep(rand(150, 300)); key("ctrl+a"); await sleep(rand(80, 160));
  await type(url); await sleep(rand(80, 200)); key("Return");
  await settle(win, 25000);
}

async function runSide(site, side) {
  const url = side === "proxied" ? proxied(site.url) : site.url;
  const name = new URL(site.url).host.replace(/^www\./, "") + "-" + side;
  const profile = process.env.PROFILE ? path.join(process.env.PROFILE, side) : fs.mkdtempSync(path.join(os.tmpdir(), "xdrive-profile-"));
  const args = [`--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--window-position=0,0", "--window-size=1500,950", "--password-store=basic"];
  if (/^https:\/\/(localhost|127\.0\.0\.1)/.test(PROXY) && side === "proxied") args.push("--ignore-certificate-errors"); // the test instance's own certificate
  const chrome = spawn("google-chrome", [...args, "about:blank"], { env: { ...process.env, DISPLAY }, stdio: "ignore", detached: true });
  const res = { side, url, notes: [], ok: true };
  try {
    const win = await browserWindow(chrome.pid);
    if (!win) { res.ok = false; res.notes.push("no browser window"); return res; }
    if (process.env.XDEBUG) console.log("window", win, JSON.stringify(title(win)), x("getwindowgeometry", "--shell", win).replace(/\n/g, " "), shot("debug-start"));
    await sleep(4000); await settle(win, 6000); // a new profile opens a tab of its own first
    await goto(win, url);
    if (CHALLENGE.test(title(win))) {
      await sleep(6000); // a silent challenge passes by itself
      if (CHALLENGE.test(title(win))) { res.notes.push(`challenge "${title(win)}": ${await handoff("challenge", win, url, side)}`); await settle(win, 15000); }
    }
    for (const step of site.x || []) {
      if (step.wait) await sleep(step.wait);
      else if (step.key) { key(step.key); await sleep(rand(150, 400)); }
      else if (step.type) await type(step.type);
      else if (step.click) { await click(step.click[0], step.click[1]); await sleep(rand(200, 500)); }
      else if (step.go) await goto(win, side === "proxied" ? proxied(step.go) : step.go);
      else if (step.shot) res.notes.push("shot " + shot(`${name}-${step.shot}`));
      else if (step.handoff) { res.notes.push(`${step.handoff}: ${await handoff(step.handoff, win, url, side)}`); await settle(win, 15000); }
      else if (step.expectTitle) { await settle(win, 12000); if (!new RegExp(step.expectTitle, "i").test(title(win))) { res.ok = false; res.notes.push(`title "${title(win)}" is not /${step.expectTitle}/`); } }
      else if (step.refuseTitle) { await settle(win, 12000); if (new RegExp(step.refuseTitle, "i").test(title(win))) { res.ok = false; res.notes.push(`title is "${title(win)}"`); } }
    }
    res.title = title(win);
    if (CHALLENGE.test(res.title)) res.ok = false;
    res.shot = shot(name);
    key("ctrl+w");
  } finally {
    try { process.kill(-chrome.pid, "SIGTERM"); } catch { /* gone */ }
    await sleep(700);
    if (!process.env.PROFILE) fs.rmSync(profile, { recursive: true, force: true });
  }
  return res;
}

(async () => {
  // LIST=human-assist.json: the sites runs recorded as needing a person.
  const list = process.env.LIST ? path.resolve(__dirname, process.env.LIST) : path.join(__dirname, "regression-sites.json");
  const sites = JSON.parse(fs.readFileSync(list, "utf8")).filter((s) => s.how === "chrome" || s.how === "assist");
  const only = process.argv.slice(2);
  let bad = 0;
  for (const site of sites) {
    if (only.length && !only.some((o) => site.url.includes(o))) continue;
    console.log(`=== ${site.url}`);
    const got = {};
    for (const side of SIDES) {
      const r = (got[side] = await runSide(site, side));
      console.log(`  ${side.padEnd(8)} ${r.ok ? "ok  " : "FAIL"} "${r.title ?? ""}"${r.notes.length ? "  [" + r.notes.join("; ") + "]" : ""}\n           ${r.shot ?? ""}`);
    }
    const d = got.direct, p = got.proxied;
    if (p && !p.ok && (!d || d.ok)) { bad++; console.log("  DIFF: refused or wrong through the proxy only"); }
    else if (d && p && d.title !== p.title) console.log("  note: titles differ");
    else if (d && !d.ok) console.log("  (direct fails as well: this run tells nothing about the proxy)");
  }
  console.log(`\nscreenshots: ${OUT}`);
  process.exit(bad ? 1 : 0);
})();
