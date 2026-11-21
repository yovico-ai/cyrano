package jsrewrite

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"
)

// mayEdit must say yes for every source a rule edits — each shared case
// that changes — and a source it refuses is given back as it is, unparsed:
// Turnstile's timing probe (1.3 MB of spaces around a few tokens).
func TestMayEdit(t *testing.T) {
	raw, err := os.ReadFile("../../../../spec/js-rewrite/cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases [][3]string
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	edited := 0
	for _, c := range cases {
		if c[1] == c[2] {
			continue
		}
		edited++
		if !mayEdit([]byte(c[1])) {
			t.Errorf("mayEdit is false for a case a rule edits: %s: %s", c[0], c[1])
		}
	}
	if edited < 30 {
		t.Fatalf("only %d edited cases read", edited)
	}
	for _, src := range []string{"x[k]", `a.location`, `a["\x74op"]`, "location", "f(top)", "w.parent", "eval(s)", "d.write(h)", "w.postMessage(m)", `import("m")`, `export * from "m"`, "new Worker(u)", "debugger;"} {
		if !mayEdit([]byte(src)) {
			t.Errorf("mayEdit(%q) = false", src)
		}
	}
	for _, src := range []string{"var a = b + c;", "f(1, 2); g.h.i = j;", "0, /.*honk.*/, 1", "x => x * 2"} {
		if mayEdit([]byte(src)) {
			t.Errorf("mayEdit(%q) = true", src)
		}
		if got := string(Rewrite([]byte(src), DefaultOptions())); got != src {
			t.Errorf("Rewrite(%q) = %q", src, got)
		}
	}
	probe := []byte(strings.Repeat(" ", 1_337_331) + "0, /.*honk.*/, 1795223596708")
	start := time.Now()
	if got := Rewrite(probe, DefaultOptions()); string(got) != string(probe) {
		t.Error("the probe was changed")
	}
	if d := time.Since(start); d > 20*time.Millisecond {
		t.Errorf("the probe took %v", d)
	}
}
