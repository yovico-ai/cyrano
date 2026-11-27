#!/usr/bin/env node
// The site regression list (regression-sites.json): every site a fix was
// made for, with what was fixed. Run before a commit that touches
// rewriting, against the build about to be committed:
//
//   PROXY=https://localhost:9443 node tools/site-regress.cjs   (real Chrome on :97 by default; HEADLESS=1 only on purpose)
//
// "auto" sites are compared direct vs proxied here (live-compare.cjs).
// "chrome" sites refuse an automated browser on both sides (bot
// protection): they are listed for a check in a real Chrome. A site's
// difference is not a failure by itself — ads and A/B content vary run to
// run — but a new proxied-only error, an escape, or a count far from
// direct's is to be looked at before committing.
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const sites = require("./regression-sites.json");
const only = process.argv.slice(2);
const pick = (s) => only.length === 0 || only.some((o) => s.url.includes(o));
const auto = sites.filter((s) => s.how === "auto" && pick(s));
for (const s of auto) console.log(`# ${s.url} — ${s.fixed}`);
if (auto.length) {
  const r = spawnSync(process.execPath, [path.join(__dirname, "live-compare.cjs"), ...auto.map((s) => s.url)], { stdio: "inherit", env: process.env });
  if (r.status) process.exitCode = r.status;
}
const manual = sites.filter((s) => s.how === "chrome" && pick(s));
if (manual.length) {
  console.log("\nIn a real Chrome (bot-protected: an automated browser is refused direct as well):");
  for (const s of manual) console.log(`  ${s.url} — ${s.fixed}`);
}
