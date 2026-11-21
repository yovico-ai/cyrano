# JavaScript rewriting

How cyrano changes a script, and how it shows the page that it did not.

## Invertible edits

A script is never re-printed. The rewriters splice their changes into its
own text, each written as a marked fragment:

    /*␡ORIGINAL*/NEW/*␡*/

`␡` is U+007F (one ASCII byte), `NEW` the inserted code, `ORIGINAL` the
text it replaces (empty for an insertion; a `*/` inside it is written
`*␡/`). After a `/` in the source the fragment starts with a space and a
doubled marker (` /*␡␡…`), or the two would read as `//`.

Everything outside the fragments is the origin's bytes. Removing them, and
putting each `ORIGINAL` back, gives the script exactly as the origin sent
it. The client does that wherever the page can see source —
`Function.prototype.toString`, a script element's text, serialization — and
since a fragment never adds a line, line numbers in stack traces are true.

Formats and inverse: `ts/client/src/js/marks.ts`,
`go/src/internal/jsrewrite/marks.go`.

## The rules

R1…R15, stated in `ts/client/src/js/rewriter.ts` (class `Splicer`). Each is
a small edit at a position the grammar gives: where a member access's
object starts and ends, whether an identifier is read, assigned or
declared.

## Two implementations, one behaviour

- **TS** (client: eval, `new Function`, scripts inserted as markup, Blob
  workers): acorn's tree, walked once. This is the reference.
- **Go** (server: every script response and inline script):
  `go/src/internal/jsrewrite/recognizer.go` — our own recursive-descent
  recognizer for the whole language. It builds no tree; it emits the edits
  directly, at about 60 MB/s.

They are held together by:

- `cases.json` — `[rule, source, code that must run]`, run by both test
  suites (`tests/js/rewriter.test.ts`, `splice_test.go`);
- the corpus comparison: every edit, by offset and text, on real scripts.

```bash
# harvest scripts, write the reference's edits beside them, compare
( cd ts/client && npx vite-node tools/js-edits.ts -- /path/to/corpus/*.js )
( cd go/src && CYRANO_JS_CORPUS=/path/to/corpus go test ./internal/jsrewrite -run TestSplice_Corpus -v )
```

The corpus test also checks that what would be served still parses and
that the original comes back byte for byte. R15 (import.meta.resolve, 2026-11-19) was checked on a small corpus with a Vite module that uses it (IKEA): identical. Last full run (2026-11-20, R15, R3 / R5 leaving written members as written, R5 leaving keys that are certainly numbers): 1,342 scripts,
172.9 MB — identical. (Pass the corpus to js-edits.ts in batches — `xargs -n 200` — or the shell's argument limit cuts the run short.)

## Known limits

- A script containing the sequence `/*␡` or `*␡/` is rewritten without
  markers (none seen); its source then reads back rewritten.
- Columns in stack traces are those of the rewritten text.
- `a?.b.location` with `b` undefined yields undefined where the native
  throws.

## What costs nothing natively must cost little here

Code that is an interpreter (a challenge's bytecode loop) runs unoptimized
and makes a computed access per operation; code that probes timing
compiles strings the browser all but skips. Three things keep the
rewriting out of their way, in both runtimes:

- **R5 is not applied to a key that is certainly a number** — parentheses
  aside, a unary `-` `+` `~`, a `++` / `--`, or a binary arithmetic or
  bitwise operation other than `+`. Such a key names no member the rules
  know. (`window[i - 1]` then reads the frame natively, as `window[0]`
  always did; `window[i]` goes through the runtime.)
- **A source no rule could touch is not parsed** (`mayEdit`: no `[`, no
  backslash, none of the names the rules know). Every rule's needle is in
  that list; the tests hold each shared case that changes to it.
- The client keeps the rewriting of a source it compiles again (a memo by
  text and options; not for modules, whose result depends on their URL).

Found on techcrunch.com (2026-11-20): Cloudflare's Turnstile evaluates
1.3 MB of spaces around a regular expression and the time, twice a second,
and its interpreter ran three times slower under R5; the page froze.
