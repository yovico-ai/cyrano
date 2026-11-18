# spec/ — URL containment, in Agda

**Why this exists:** to prove cyrano's fundamental principle
(REQUIREMENTS.md): the page's own JS cannot tell it runs through the
proxy. The central theorem is that what page code is shown equals what
the browser shows for the original. Every other rule here serves that
theorem. Byte-compatibility between the Go and TS runtimes follows from
it, because both are checked against the same oracle.

The rules both runtimes must follow byte for byte, written once:

| Module | Decides | Implemented by |
|---|---|---|
| `Scheme.agda` | the proxified schemes (http, https, ws, wss) | `PROXIFIABLE_SCHEMES` in both runtimes |
| `Url.agda` | how a URL string is read (WHATWG basic URL parser, Node 22 flavour) | `go/src/internal/urlrewrite/whatwg.go`; the browser's `URL` in TS |
| `Containment.agda` | rewrite (proxify, remap, keep) and unwrap | `urlrewrite.Rewrite`/`Unwrap`; `rewriteUrl`/`unwrapProxiedUrl` in `ts/client/src/url/containment.ts` |
| `Srcset.agda` | where each srcset candidate's URL starts and ends | `htmlrewrite/srcset.go`; `ts/client/src/patches/srcset.ts` |
| `Referrer.agda` | Referer, Origin and Sec-Fetch-Site as a direct browser sends them (Referrer Policy, Fetch, Fetch Metadata) | `urlrewrite/referrer.go`, applied in `proxy/fetch_headers.go` |
| `Cookies.agda` | reading Set-Cookie, storing, choosing cookies for a URL, SameSite, and the wire form of a cookie in the browser's jar (RFC 6265bis) | `urlrewrite/cookies.go`, `proxy/cookies.go`; `ts/client/src/cookies/rfc.ts` |
| `Oracle.agda` | wire format only (one request line → one JSON line) | — |
| `Main.agda` | the IO loop (spec-oracle skill's file, unchanged) | — |

Owner decisions are dated in each module's header comment, and so are
the readings still awaiting confirmation ("Ours, to confirm"). Edit the
spec first, then the runtimes.

## Proved, not tested

In `Containment.agda`:

- **The law, on parsed URLs** (`unwrap-proxify`): unwrapping a proxified
  URL gives back exactly the original. Its one hypothesis, `canonical`,
  says a parsed authority reads back as itself. That's true of everything
  the parser produces, but it isn't proved yet; the oracle properties
  check it. Proving it is the next step.
- **Reading back undoes escaping, for every string** (`decode-escape`).
  Every `%` of the target is written `%25` in a proxified path, so the
  path is always valid percent-encoding, and decoding returns the
  target's text exactly.
- A proxified URL is never wrapped again; a URL that is kept comes back
  byte for byte.
- Adding a constructor to `Scheme` or `Kind` fails type checking until
  every rule handles it.

The law is about parsed values. The step from a proxified URL as *text*
back to its parsed form (that the browser's parser reads what proxify
wrote) is tested, not proved. That gap is where both holes found so far
sat: `.`/`..` hosts collapsing as dot segments, and `{`/`}` in hosts
being percent-encoded by the path parser.

## Tested against the oracle

`spec/build/Main` is the compiled spec. The Go (`internal/specoracle`,
rapid) and TS (`ts/client/tests/spec`, fast-check) conformance tests
generate inputs, ask the oracle, and compare. **The reference browser is Chromium**, not Node and not the written
standards, where they differ (`^` and `|` in paths, a space or `*` in a
host, IDNA, an invalid last `Max-Age`): a URL or cookie the user's browser
accepts and cyrano does not would escape containment. `make browser-check`
runs the spec against real Chromium (URLs: `spec-vs-chromium`, cookies:
`cookies-vs-chromium`) and the runtime's native surface, `postMessage` and
workers in it (`tests/native`). IDNA, outside the spec, is checked by a
fixture recorded from Chromium (`urlrewrite/fixtures/idna.json`).

The main properties are:

- **the page cannot tell**: `unwrap(rewrite(raw))` equals `direct(raw)`.
  It's checked against the spec in both runtimes, and in TS also against
  Node's real URL parser, with no oracle involved
  (`page-cannot-tell.test.ts`);
- **the spec is the browser**: the spec's `direct` equals Node's
  `new URL(raw, base).href`;
- **the upstream cannot tell**: the request the server forwards equals
  what the browser would send directly (Go,
  `TestSpecConformance_UpstreamCannotTell`). An answer of `silent`
(IPv6, IDNA, percent-encoded or unusual IPv4 hosts) means the spec does
not decide that input, and it is skipped.

```bash
# from the repo root; builds the oracle and runs both suites with it required
env -u LD_LIBRARY_PATH nix develop --command make spec-check
```

Plain `go test ./...` and `npx vitest run` use `spec/build/Main` when it
exists (or `CYRANO_ORACLE`), and skip the conformance tests with a note
when it is missing or older than any `spec/*.agda` — so they still work
without Nix, and a stale oracle never passes silently.
