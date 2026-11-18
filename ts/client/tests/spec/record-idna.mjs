// Records what a real browser's URL parser (headless Chromium, via the
// Playwright install in ts/e2e) makes of hosts the Agda spec leaves outside
// its model — IDNA (UTS #46) — so the Go runtime, which cannot ask a
// browser, is checked against the real thing. Node's answer is recorded
// alongside: Node 22 parses with Ada, whose IDNA is its own, not Chrome's ICU.
//   node ts/client/tests/spec/record-idna.mjs > go/src/internal/urlrewrite/fixtures/idna.json
// Regenerate when the browser (or this list) changes.
import { createRequire } from "node:module";
const require = createRequire(new URL("../../../e2e/package.json", import.meta.url));
const { chromium } = require("playwright");
const hosts = [
    "exämple.com", "EXÄMPLE.com", "%C3%A9.com", "xn--9ca.com", "xn--a.com", "xn--", "xn--ab-.com",
    "ＥＸＡＭＰＬＥ.com", "a­b.com", "faß.de", "ß.com", "日本.jp", "日本。jp", "Ω.com", "😀.com",
    "-a.com", "a-.com", "ab--c.com", "‍.com", "a‌b.com", "١٢٣.com", "a.١٢٣", "‮.com",
    "%E2%80%8D.com", "%FF.com", "%C3.com", "é.1", "é.0x1", "１.２.３.４", "０ｘ７ｆ.１", "ﬁ.com",
    "xn--zca.com", "XN--ZCA.com", "a.xn--zca", "ⓐ.com", "́a.com", "á.com", "�.com",
    "é:8080", "u:p@é.com", "é.com.", "é..com", "%20é.com", "é%2F.com", "é|.com", "é^.com",
];
const inputs = hosts.map((h) => `http://${h}/`);
const parse = (xs) => xs.map((x) => { try { return new URL(x).href; } catch { return null; } });
const browser = await chromium.launch();
const page = await browser.newPage();
const inBrowser = await page.evaluate(parse, inputs);
const version = browser.version();
await browser.close();
const inNode = parse(inputs);
const cases = inputs.map((input, i) => ({ input, href: inBrowser[i], ...(inNode[i] !== inBrowser[i] ? { node: inNode[i] } : {}) }));
process.stdout.write(JSON.stringify({ browser: `chromium ${version}`, node: process.version, cases }, null, 1) + "\n");
