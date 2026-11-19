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

R1…R13, stated in `ts/client/src/js/rewriter.ts` (class `Splicer`). Each is
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
that the original comes back byte for byte. Last run (2026-11-18, R13): 1,342 scripts,
172.9 MB — identical.

## Known limits

- A script containing the sequence `/*␡` or `*␡/` is rewritten without
  markers (none seen); its source then reads back rewritten.
- Columns in stack traces are those of the rewritten text.
- `a?.b.location` with `b` undefined yields undefined where the native
  throws.
