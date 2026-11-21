// The human-assist queue: sites an automated run could not judge because a
// challenge or a bot refusal stood in the way (on either side). They are
// done later with a person at hand: `LIST=human-assist.json node
// tools/xdrive.cjs` on a display the person watches, which waits at each
// challenge (HANDOFF_WAIT) or hands it to XDRIVE_ON_CHALLENGE.
//
// Also the one place the tools proxify a URL: as the spec does
// (spec/Containment.agda escapePct — every '%' of the target's path written
// %25; the query as written),
// or a %20 in the target reaches cyrano as a literal space.

const fs = require("node:fs");
const path = require("node:path");

const FILE = process.env.ASSIST_LIST || path.join(__dirname, "human-assist.json");
const CHALLENGE = /just a moment|attention required|access denied|verify you are human|are you a robot|pardon our interruption|security check|captcha|unusual traffic|request blocked|please verify|one more step/i;

/** A page that is a challenge or a refusal, not the site: by status, title and how little it holds. */
function challenged({ status, title, text, elements }) {
  if (CHALLENGE.test(title || "")) return "challenge page: " + JSON.stringify(title);
  if ((status === 403 || status === 429 || status === 405) && (elements ?? 0) < 60) return `refused (${status})`;
  if (status === 202 && (elements ?? 0) < 40 && (text || "").trim().length < 40) return "empty 202 (an interstitial)";
  return null;
}

/** Records `url` in the queue (once; the reason and time updated). */
function record(url, reason, from) {
  let list = [];
  try { list = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { /* new list */ }
  const at = new Date().toISOString().slice(0, 16);
  const hit = list.find((e) => e.url === url);
  if (hit) Object.assign(hit, { why: reason, seen: at, times: (hit.times || 1) + 1 });
  else list.push({ url, why: reason, from, seen: at, how: "assist" });
  fs.writeFileSync(FILE, JSON.stringify(list, null, 1) + "\n");
}

function proxify(proxy, u) {
  const x = new URL(u);
  return `${proxy.replace(/\/$/, "")}/cyrano/${x.protocol.slice(0, -1)}/${x.host}${x.pathname.replace(/%/g, "%25")}${x.search}`; // the query goes as written
}

module.exports = { challenged, record, proxify, CHALLENGE, FILE };
