package urlrewrite

import (
	"testing"

	"github.com/yovico/cyrano/internal/specoracle"
)

// The import map's "integrity" section as the proxy keeps it (spec
// ImportMap.integrityEntries, integrityFor, mergeIntegrity).
func TestSpecConformance_ImportMapIntegrity(t *testing.T) {
	oracle := specoracle.Need(t)
	base := "https://a.example/app/page.html"
	maps := []string{
		`{"integrity": {"./m.js": "sha384-AAA", "/x.js": "sha256-BBB"}}`,
		`{"imports": {"a": "./a.js"}, "integrity": {"https://cdn.example/l.js": "sha512-CCC", "bare": "sha256-D", "../up.js": 7, "./m.js": "sha256-E"}}`,
		`{"integrity": {"./m.js": "sha256-1"}, "integrity": {"./n.js": "sha256-2"}}`,
		`{"integrity": "nope"}`,
		`{"integrity": {"./m.js": "sha256-1", "./m.js": "sha256-last"}}`,
		`{"integrity": {"./q.js": {"x": 1}, "./r.js": "sha256-R"}}`,
		`not json`,
		`["integrity"]`,
		`{"scopes": {"/": {"integrity": "x"}}, "integrity": {"data:text/javascript,1": "sha256-Z", "./s.js": "sha256-S"}}`,
	}
	urls := []string{
		"https://a.example/app/m.js", "https://a.example/x.js", "https://cdn.example/l.js",
		"https://a.example/app/n.js", "https://a.example/up.js", "https://a.example/app/r.js",
		"https://a.example/app/q.js", "https://a.example/app/s.js", "https://a.example/app/bare",
	}
	cases := [][]string{}
	for _, m := range maps {
		cases = append(cases, []string{m})
	}
	cases = append(cases, []string{maps[0], maps[1]}, []string{maps[1], maps[0]}, []string{maps[3], maps[4]})
	for _, ms := range cases {
		for _, u := range urls {
			want, _, err := oracle.Ask("importmapintegrity", append([]string{base, u}, ms...)...)
			if err != nil {
				t.Fatal(err)
			}
			var merged []IntegrityEntry
			for _, m := range ms {
				merged = MergeIntegrity(merged, ImportMapIntegrity(m, base))
			}
			got, ok := IntegrityFor(merged, u)
			if !ok {
				got = "-"
			}
			if got != want {
				t.Errorf("maps %q, %s: %q, spec %q", ms, u, got, want)
			}
		}
	}
}
