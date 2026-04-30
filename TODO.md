# Known issues / deferred work

## booking.com — AWS WAF challenge loop

**Symptom**: Page loops on the AWS WAF JS challenge interstitial; console shows
"Max challenge attempts exceeded". The PoW solution in `POST /mp_verify` is all
zeros (`solution_data: AAAA...==`), so the server always returns "retry".

**Root cause (confirmed)**:
- `window.location` is `[LegacyUnforgeable]` — `Object.defineProperty(window, 'location', ...)` throws and is silently caught. Our patch does nothing.
- challenge.js reads `window.location.href` → gets the proxy URL (`http://localhost:9081/?goto=...`) instead of `https://www.booking.com/`.
- This proxy URL is baked into fingerprint/PoW data sent to AWS WAF, which rejects it because the domain doesn't match.
- A JSON parse error in the challenge boot sequence (response from `/inputs?client=browser` or similar) further breaks PoW computation.

**What was tried**:
- `patchWindowLocation` in `ts/client/src/patches/location.ts` — silently fails for `window.location` in Chrome/Firefox (non-configurable own property per Web IDL `[LegacyUnforgeable]`).
- Skipping bootstrap injection on challenge pages (`InjectBootstrap: !isChallenge`) — challenge.js still sees proxy URL from `window.location.href`.
- Forwarding extra query params (`chal_t`, `force_referer`) from proxy URL to upstream — no effect on the PoW failure.

**What's needed**:
- The PoW and fingerprinting code in challenge.js MUST see the real upstream URL in `window.location`. Since we cannot patch `window.location` itself, the only options are:
  1. **Service Worker** intercepts challenge.js's `location` reads at the network level — complex, requires SW registration before challenge page loads.
  2. **`<base href="...">` injection** into the challenge page — changes relative URL resolution but not `window.location.href`.
  3. **Full transparent proxy** (same domain, TLS MITM) — then `window.location` is naturally correct. Big architectural change.
  4. **Decode and re-serve challenge from upstream domain via DNS/SNI spoofing** — outside scope.
- Booking.com also uses TLS fingerprinting (JA3/JA4). A Go HTTP client presents a different TLS ClientHello than Chrome; AWS WAF may block purely on that basis regardless of JS challenge outcome. Would need `utls` with a Chrome preset to spoof the TLS fingerprint.

**Status**: Deferred. Booking.com requires solving both `window.location` (unforgeable) and TLS fingerprint issues. Focus on sites that don't use AWS WAF JS challenge.
