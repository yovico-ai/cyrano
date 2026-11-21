// Ads (and the trackers and telemetry around them) differ from one load to
// the next — another auction, another creative, another beacon — so a
// comparison of direct and proxied skips them at every level: their slots
// are hidden on both sides before a screenshot (visibility, so the layout
// stays), their elements and text are left out of the counts, their
// requests and the messages naming them out of the failures and errors.
// Not out of the escapes: an ad that leaves the proxy is still a leak.

// Hosts (registrable domain or a name under it) that serve ads, measure
// them, or collect telemetry.
const HOSTS = [
  "doubleclick.net", "googlesyndication.com", "googleadservices.com", "googletagservices.com", "google-analytics.com",
  "googletagmanager.com", "analytics.google.com", "adservice.google.com", "imasdk.googleapis.com", "2mdn.net", "gstatic.com/ads",
  "adnxs.com", "rubiconproject.com", "pubmatic.com", "openx.net", "criteo.com", "criteo.net", "casalemedia.com",
  "amazon-adsystem.com", "taboola.com", "outbrain.com", "3lift.com", "adsrvr.org", "id5-sync.com", "yieldmo.com",
  "sharethrough.com", "teads.tv", "smartadserver.com", "indexww.com", "moatads.com", "doubleverify.com",
  "adsafeprotected.com", "scorecardresearch.com", "quantserve.com", "quantcount.com", "facebook.net", "connect.facebook.net",
  "bat.bing.com", "clarity.ms", "hotjar.com", "hotjar.io", "media.net", "adform.net", "ads.yahoo.com", "analytics.yahoo.com",
  "ads-twitter.com", "ads.linkedin.com", "px.ads.linkedin.com", "connatix.com", "primis.tech", "gumgum.com", "kargo.com",
  "lijit.com", "sovrn.com", "33across.com", "crwdcntrl.net", "bluekai.com", "rlcdn.com", "demdex.net", "everesttech.net",
  "omtrdc.net", "confiant-integrations.net", "confiant.com", "adlightning.com", "ad-delivery.net", "adsco.re",
  "browser-intake-datadoghq.com", "nr-data.net", "sentry.io", "events.launchdarkly.com", "tiktok.com/api/v2/pixel",
  "analytics.tiktok.com", "ct.pinterest.com", "sc-static.net", "snapchat.com/p", "zemanta.com", "mgid.com", "revcontent.com",
  "adthrive.com", "raptive.com", "mediavine.com", "ezoic.net", "ezodn.com", "privacymanager.io", "liadm.com",
  "agkn.com", "tapad.com", "mathtag.com", "bidswitch.net", "contextweb.com", "lkqd.net", "spotxchange.com", "springserve.com",
  "a-mo.net", "adition.com", "seedtag.com", "onetag-sys.com", "nativo.com", "flashtalking.com", "serving-sys.com",
  "permutive.com", "permutive.app", "chartbeat.com", "chartbeat.net", "parsely.com", "segment.io", "segment.com/v1",
  "mixpanel.com", "amplitude.com", "newrelic.com", "stats.wp.com", "pixel.wp.com", "trustarc.com", "cdn-cgi/rum",
];
// Paths that are beacons or ad calls wherever they are served from.
const PATHS = /\/(pagead|ccm\/collect|g\/collect|rmkt\/collect|j\/collect|collect\?|gampad|adx?\/|ads?\?|prebid|hb\/|bid\?|beacon|pixel|tr\?|track|impression|rum\?|rum\/)/i;

const hostRe = new RegExp("(^|[./])(" + HOSTS.map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")", "i");

/** The URL with a proxied form read as the original. */
function original(u) {
  return String(u).replace(/^https?:\/\/[^/]+\/cyrano\/(https?)(?:![a-z-]+)*\//, "$1://");
}

/** True for an ad, tracker or telemetry URL (proxied or not). */
function isAd(u) {
  const o = original(u).replace(/^[a-z]+:\/\//, "");
  return hostRe.test(o) || PATHS.test(o.slice(o.indexOf("/")));
}

/** A message that names an ad URL. */
function namesAd(msg) {
  return (String(msg).match(/(https?:\/\/|\/\/)[^\s'")]+/g) || []).some(isAd);
}

// Runs in the page: hides ad slots and frames and marks them, so the probe
// can leave them out. Returns how many it hid.
const MASK = `(() => {
  const hostRe = new RegExp(${JSON.stringify(hostRe.source)}, "i");
  const orig = (u) => String(u || "").replace(/^https?:\\/\\/[^/]+\\/cyrano\\/(https?)(?:![a-z-]+)*\\//, "$1://");
  const sizes = new Set(["300x250","728x90","320x50","160x600","300x600","970x250","970x90","336x280","320x100","468x60","300x50","120x600","250x250","200x200","300x1050","980x120","1x1"]);
  const sel = ["ins.adsbygoogle", "[id^='google_ads']", "[id^='div-gpt-ad']", "[id*='taboola']", "[class*='taboola']", "[id*='outbrain']", "[class*='OUTBRAIN']",
    "[data-ad]", "[data-ad-slot]", "[data-ad-unit]", "[data-google-query-id]", "[data-ad-unit-path]", "[aria-label='Advertisement']", "[aria-label='advertisement']",
    "[id*='-ad-']", "[id^='ad-']", "[id$='-ad']", "[class~='ad']", "[class~='ads']", "[class*='ad-slot']", "[class*='ad-container']", "[class*='ad-wrapper']",
    "[class*='AdSlot']", "[class*='adSlot']", "[class*='advert']", "[id*='advert']", "[class*='sponsor']", "[class*='dfp']", "[id*='dfp']", "[class*='gpt-ad']", "[class*='ad-unit']"];
  const hide = (el) => { if (el.closest("[data-crn-mask]")) return 0; el.setAttribute("data-crn-mask", ""); el.style.setProperty("visibility", "hidden", "important"); return 1; };
  let n = 0;
  for (const s of sel) { try { for (const el of document.querySelectorAll(s)) n += hide(el); } catch {} }
  for (const f of document.querySelectorAll("iframe, embed, object")) {
    const src = orig(f.getAttribute("src") || f.getAttribute("data") || "");
    const r = f.getBoundingClientRect();
    if (hostRe.test(src) || sizes.has(Math.round(r.width) + "x" + Math.round(r.height)) || (!src && r.width > 0 && r.height > 0) || /ad|google_ads|safeframe/i.test(f.id + " " + f.name + " " + f.title)) n += hide(f);
  }
  for (const s of document.querySelectorAll("script[src]")) if (hostRe.test(orig(s.getAttribute("src")))) s.setAttribute("data-crn-mask", "");
  return n;
})()`;

module.exports = { isAd, namesAd, original, MASK, HOSTS };

// Runs in the page after MASK: the DOM outside ads as signatures — an
// element's tag, id and first classes under its three nearest ancestors' —
// with the computed style that shows how CSS laid it out.
const DOM = `(() => {
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "LINK", "META", "TEMPLATE", "BR"]);
  const name = (e) => e.tagName.toLowerCase() + (e.id && !/\\d{4,}|[0-9a-f]{8,}/i.test(e.id) ? "#" + e.id : "") +
    [...e.classList].filter((c) => !/\\d{3,}|^[a-z0-9_-]{0,3}$|[A-Za-z0-9]{6,}_[A-Za-z0-9]{4,}|^css-|^sc-|^jsx-/.test(c)).sort().slice(0, 2).map((c) => "." + c).join("");
  const out = []; const walk = (el, path, depth) => {
    for (const c of el.children) {
      if (SKIP.has(c.tagName) || c.hasAttribute("data-crn-mask")) continue;
      const n = name(c), key = path.slice(-3).concat(n).join(">");
      let st = null;
      if (out.length < 4000) {
        const cs = getComputedStyle(c), r = c.getBoundingClientRect();
        const q = (v) => Math.round(v / 8) * 8;
        st = [cs.display, cs.position, cs.visibility, q(r.width), q(r.height), q(r.left), cs.color, cs.fontSize, cs.fontFamily.split(",")[0].trim(), cs.backgroundColor, cs.backgroundImage === "none" ? "none" : "img"].join("|");
      }
      out.push([key, st]);
      if (depth < 40) walk(c, path.concat(n), depth + 1);
    }
  };
  if (document.body) walk(document.body, ["body"], 0);
  return out;
})()`;

const STYLE_FIELDS = ["display", "position", "visibility", "width", "height", "left", "color", "font-size", "font", "background-color", "background"];

/** Differences between two DOM signature lists: elements one side lacks, and styles of elements both have (once each). */
function domDiff(d, v) {
  const count = (xs) => { const m = new Map(); for (const [k] of xs) m.set(k, (m.get(k) || 0) + 1); return m; };
  const cd = count(d), cv = count(v);
  const onlyD = [], onlyV = [];
  for (const [k, n] of cd) { const m = cv.get(k) || 0; if (n > m) onlyD.push([k, n - m]); }
  for (const [k, n] of cv) { const m = cd.get(k) || 0; if (n > m) onlyV.push([k, n - m]); }
  const styleOf = (xs, c) => { const m = new Map(); for (const [k, s] of xs) if (c.get(k) === 1 && s) m.set(k, s); return m; };
  const sd = styleOf(d, cd), sv = styleOf(v, cv);
  const styles = []; let compared = 0;
  for (const [k, s] of sd) {
    const t = sv.get(k); if (!t) continue; compared++;
    if (s === t) continue;
    const a = s.split("|"), b = t.split("|");
    const what = STYLE_FIELDS.filter((_, i) => a[i] !== b[i]).map((f) => `${f} ${a[STYLE_FIELDS.indexOf(f)]} → ${b[STYLE_FIELDS.indexOf(f)]}`);
    styles.push([k, what.join(", ")]);
  }
  const sum = (xs) => xs.reduce((a, [, n]) => a + n, 0);
  return { total: [d.length, v.length], onlyDirect: sum(onlyD), onlyProxied: sum(onlyV), exD: onlyD.sort((a, b) => b[1] - a[1]).slice(0, 4), exV: onlyV.sort((a, b) => b[1] - a[1]).slice(0, 4), compared, styles };
}

module.exports.DOM = DOM;
module.exports.domDiff = domDiff;
