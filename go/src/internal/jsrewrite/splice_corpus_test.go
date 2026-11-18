package jsrewrite

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"
)

// The recognizer against the TS reference rewriter, edit for edit, on a
// corpus of real scripts. CYRANO_JS_CORPUS names a directory of *.js files,
// each with the reference's edits beside it (<file>.edits.json, written by
// ts/client/tools/js-edits.ts). Skipped when it is not set.
func TestSplice_Corpus(t *testing.T) {
	dir := os.Getenv("CYRANO_JS_CORPUS")
	if dir == "" {
		t.Skip("CYRANO_JS_CORPUS not set")
	}
	files, _ := filepath.Glob(filepath.Join(dir, "*.js"))
	sort.Strings(files)
	base, _ := url.Parse("https://corpus.example/dir/script.js")
	opts := DefaultOptions()
	opts.BaseURL = base
	opts.ProxifyURL = func(s string, b *url.URL) string {
		if !(strings.HasPrefix(s, "/") || strings.HasPrefix(s, "./") || strings.HasPrefix(s, "../") || strings.HasPrefix(s, "http:") || strings.HasPrefix(s, "https:")) {
			return s
		}
		u, err := b.Parse(s)
		if err != nil {
			return s
		}
		return "https://proxy.example/cyrano/" + u.String()
	}
	var bytesDone, same, differ, noParse, refNoParse int
	var spent time.Duration
	shown := 0
	for _, f := range files {
		src, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		var ref struct {
			OK    bool                 `json:"ok"`
			Edits [][3]json.RawMessage `json:"edits"`
		}
		raw, err := os.ReadFile(f + ".edits.json")
		if err != nil {
			continue
		}
		if err := json.Unmarshal(raw, &ref); err != nil {
			t.Fatalf("%s: %v", f, err)
		}
		start := time.Now()
		got, ok := Edits(src, opts)
		spent += time.Since(start)
		bytesDone += len(src)
		name := filepath.Base(f)
		if !ref.OK {
			refNoParse++
			continue
		}
		if !ok {
			noParse++
			if shown < 12 {
				shown++
				t.Errorf("%s: the recognizer does not parse it (%s)", name, whyNot(src, opts))
			}
			continue
		}
		want := make([]Edit, len(ref.Edits))
		for i, e := range ref.Edits {
			json.Unmarshal(e[0], &want[i].Pos)
			json.Unmarshal(e[1], &want[i].Del)
			json.Unmarshal(e[2], &want[i].Ins)
		}
		if d := firstDifference(src, got, want); d != "" {
			differ++
			if shown < 12 {
				shown++
				t.Errorf("%s: %s", name, d)
			}
			continue
		}
		// What is served must itself be a script: the markers are comments
		// spliced between the page's own characters, and must not combine
		// with them (a division before one once made `//`).
		es, _ := jsEdits(src, &opts)
		served := applyEdits(src, es)
		none := Options{}
		if _, ok := jsEdits(served, &none); !ok {
			differ++
			if shown < 12 {
				shown++
				t.Errorf("%s: the rewritten script does not parse (%s)", name, whyNot(served, none))
			}
			continue
		}
		if !bytes.Equal(Original(served), src) {
			differ++
			if shown < 12 {
				shown++
				t.Errorf("%s: the original does not come back", name)
			}
			continue
		}
		same++
	}
	t.Logf("%d scripts, %.1f MB: %d identical, %d differ, %d not parsed (reference failed on %d); %.1f MB/s",
		len(files), float64(bytesDone)/1e6, same, differ, noParse, refNoParse, float64(bytesDone)/1e6/spent.Seconds())
	if differ+noParse > 0 {
		t.Errorf("%d scripts differ, %d not parsed", differ, noParse)
	}
}

func firstDifference(src []byte, got, want []Edit) string {
	for i := 0; i < len(got) || i < len(want); i++ {
		var g, w *Edit
		if i < len(got) {
			g = &got[i]
		}
		if i < len(want) {
			w = &want[i]
		}
		if g != nil && w != nil && *g == *w {
			continue
		}
		at := 0
		if g != nil {
			at = g.Pos
		}
		if w != nil && (g == nil || w.Pos < at) {
			at = w.Pos
		}
		lo, hi := at-70, at+70
		if lo < 0 {
			lo = 0
		}
		if hi > len(src) {
			hi = len(src)
		}
		show := func(e *Edit) string {
			if e == nil {
				return "none"
			}
			return fmt.Sprintf("@%d del %d ins %q", e.Pos, e.Del, e.Ins)
		}
		return fmt.Sprintf("edit %d of %d|%d: got %s, want %s\n      source: …%s⟦HERE⟧%s…", i, len(got), len(want), show(g), show(w), src[lo:at], src[at:hi])
	}
	return ""
}

// whyNot reports where the recognizer gave up.
func whyNot(src []byte, opts Options) (why string) {
	p := &parser{o: &opts}
	p.src = src
	defer func() {
		r := recover()
		at := -1
		switch e := r.(type) {
		case parseError:
			at = e.at
		case scanError:
			at = e.at
		default:
			why = fmt.Sprint(r)
			return
		}
		lo, hi := at-70, at+50
		if lo < 0 {
			lo = 0
		}
		if hi > len(src) {
			hi = len(src)
		}
		why = fmt.Sprintf("at %d: …%s⟦HERE⟧%s…", at, src[lo:at], src[at:hi])
	}()
	p.program()
	return "parsed?"
}
