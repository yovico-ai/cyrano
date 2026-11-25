package jsrewrite

import (
	"strings"
	"bytes"
	"encoding/json"
	"os"
	"regexp"
	"testing"
)

// The rule cases shared with the TS rewriter (spec/js-rewrite/cases.json):
// [rule, source, the code that must run]. Both runtimes must produce the
// same code, and the original must come back byte for byte.
func TestSplice_SharedCases(t *testing.T) {
	raw, err := os.ReadFile("../../../../spec/js-rewrite/cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases [][3]string
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		rule, src, want := c[0], c[1], c[2]
		opts := DefaultOptions()
		opts.JSURL = strings.HasPrefix(rule, "jsUrl") // a javascript: URL's code
		edits, ok := jsEdits([]byte(src), &opts)
		if !ok {
			t.Errorf("%s: does not parse: %s", rule, src)
			continue
		}
		out := applyEdits([]byte(src), edits)
		if got := string(Unmarked(out)); got != want {
			t.Errorf("%s\n  in:   %s\n  got:  %s\n  want: %s", rule, src, got, want)
		}
		if back := Original(out); !bytes.Equal(back, []byte(src)) {
			t.Errorf("%s: original does not come back\n  in:   %s\n  back: %s", rule, src, back)
		}
		if bytes.Count(out, []byte("\n")) != bytes.Count([]byte(src), []byte("\n")) {
			t.Errorf("%s: a line was added", rule)
		}
	}
}

var _ = regexp.MustCompile

// A script that itself contains the marker character is edited without
// markers; then nothing separates an insertion from a keyword before it.
func TestSplice_UnmarkedInsertionsDoNotFuseWithKeywords(t *testing.T) {
	src := "x = '/*\x7f'; function f(a, k) { return[a][k] } function g(o) { return top }"
	opts := DefaultOptions()
	got := string(Rewrite([]byte(src), opts))
	want := "x = '/*\x7f'; function f(a, k) { return $rewriter.wrap_member_expression([a],$__crn_key__=(k))[$__crn_key__] } function g(o) { return $rewriter.wrap_get_top_window(top) }"
	if got != want {
		t.Errorf("got:  %q\nwant: %q", got, want)
	}
}

// The marker byte alone, in a script's own strings, does not prevent
// marking (Akamai's sensor script holds every byte in its string tables):
// the original still comes back.
func TestSplice_MarkerByteInSourceIsFine(t *testing.T) {
	src := "var s = 'a\x7fb*\x7f'; function f(o, k) { return o[k] + top }"
	out := Rewrite([]byte(src), DefaultOptions())
	if !bytes.Contains(out, markOpen) {
		t.Fatalf("not marked: %q", out)
	}
	if back := Original(out); string(back) != src {
		t.Errorf("original does not come back:\n got  %q\n want %q", back, src)
	}
}
