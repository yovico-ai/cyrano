# bug-miner

Random-walk DOM-diff harness for the rewriter. Picks 3 random English words,
runs them through DuckDuckGo, opens the first hit both directly and through
the proxy, and compares the two renderings (excluding ad slots) to surface
regressions.

A discrepancy in the comparison is a candidate bug.

## Setup

```bash
npm install
npm run install-browsers   # one-time: downloads Chromium for Playwright
```

`words.txt` is the standard 10K English word list (no swears) from
`first20hours/google-10000-english`. ~10K lines, ~75 KB.

## Run

```bash
# Make sure the proxy is up first.
( cd ../../go/src && go build -o /tmp/cyrano ./cmd/cyrano )
/tmp/cyrano --config ../../dev.json --assets ../../go/assets &

# Default: real Chrome, headed (visible window), 1 run
npm run mine

# Five runs
npm run mine -- --runs 5

# Specific query (skip random word + search)
npm run mine -- --query "github actions tutorial"

# Different proxy
npm run mine -- --proxy http://localhost:9080

# Headless for CI / batch
npm run mine -- --headless --runs 20

# Bundled Chromium instead of system Chrome
npm run mine -- --browser chromium

# Custom user-agent (applies to search engine + both snapshot contexts)
npm run mine -- --user-agent "Mozilla/5.0 (custom)"

# Slow-mo for visual debugging — Playwright pauses N ms between actions
npm run mine -- --slow-mo 250
```

### CLI flags

| flag | default | meaning |
|---|---|---|
| `--runs N` | 1 | how many query/diff iterations |
| `--query "..."` | (random) | skip random words; force this exact search |
| `--proxy URL` | `http://localhost:9081` | rewriter origin |
| `--browser chrome\|chromium` | `chrome` | system Chrome (real) or Playwright's bundled Chromium |
| `--headless` | off (headed) | run without a visible window |
| `--user-agent "..."` | desktop Chrome 120 | UA applied to search engine + both snapshot contexts |
| `--slow-mo N` | 0 | ms between Playwright actions; useful with `--headed` |

Reports land in `reports/<session>/`:
- `summary.md` — table of verdicts across the session
- `<runid>-<query-slug>/` — one directory per run, each containing:
  - `run.json` — URL, verdict, console errors with stack traces, signals
  - `direct.html` — post-execution DOM as the browser rendered it (no proxy)
  - `proxied.html` — post-execution DOM rendered through the rewriter

Drop a single run directory into a Claude Code session and it has everything
needed to investigate: the URL, both DOMs, and the JS errors.

## Verdicts

| Verdict | Meaning |
|---|---|
| `ok` | Proxied render matches direct closely enough |
| `suspicious` | Within tolerance but signals are off — worth eyeballing |
| `broken` | Clear regression: proxy leak, big content drop, multiple console errors |

The thresholds are tuned conservatively to flag false positives over false
negatives. See `src/compare.ts:verdict()` for the rules.

## What gets compared

After ad-slot removal (selectors in `src/browser.ts:domExtractor`):

- Page title equality
- Headings (h1-h6) — exact text match, in document order
- Visible text length — ratio proxied/direct
- Anchor and image counts — ratios
- Console errors on the proxied side
- **Proxy leaks** — any non-data: HTTP request from the proxied page that
  doesn't go through the proxy origin. This is the single most useful signal
  for catching URL-containment bugs.

## Why DuckDuckGo and not Google

Google aggressively blocks Playwright. DuckDuckGo's HTML endpoint
(`html.duckduckgo.com/html/`) is JS-free, friendly to scrapers, and good
enough for "give me a popular page about these three words."
