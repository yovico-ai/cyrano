package urlrewrite

// IDNA (UTS #46) is the one part of the host parser outside the Agda
// spec's model. Instead of the oracle, a real browser is the reference:
// fixtures/idna.json holds what headless Chromium's URL parser makes of
// each host (regenerate with ts/client/tests/spec/record-idna.mjs).

import (
	"encoding/json"
	"os"
	"testing"
)

// knownDifferences are inputs where Go deliberately does not follow
// Chromium, each with the reason.
var knownDifferences = map[string]string{
	// Chromium percent-escapes a space inside an IDNA label and accepts the
	// unresolvable host "xn--%20-dma.com"; Go rejects it, leaving the URL as
	// written, which the browser cannot resolve either — nothing escapes.
	"http://%20é.com/": "chromium escapes invalid IDNA input",
}

func TestIDNAMatchesBrowser(t *testing.T) {
	raw, err := os.ReadFile("fixtures/idna.json")
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Node  string `json:"browser"`
		Cases []struct {
			Input string  `json:"input"`
			Href  *string `json:"href"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	for _, c := range f.Cases {
		if _, known := knownDifferences[c.Input]; known {
			continue
		}
		a, res := parseRef(nil, preprocess(c.Input))
		switch {
		case c.Href == nil && res == parsedURL:
			t.Errorf("%q: browser (%s) rejects it, Go reads %q", c.Input, f.Node, a.href())
		case c.Href != nil && res != parsedURL:
			t.Errorf("%q: browser (%s) reads %q, Go rejects it", c.Input, f.Node, *c.Href)
		case c.Href != nil && a.href() != *c.Href:
			t.Errorf("%q: browser (%s) reads %q, Go reads %q", c.Input, f.Node, *c.Href, a.href())
		}
	}
}
