package proxy

// Conformance with spec/Dictionary.agda (the spec against Chromium:
// ts/client/tests/spec/dictionary-vs-chromium).

import (
	"net/http"
	"strings"
	"testing"

	"github.com/yovico/cyrano/internal/specoracle"
	"pgregory.net/rapid"
)

func TestSpecConformance_DictionaryAcceptEncoding(t *testing.T) {
	oracle := specoracle.Need(t)
	member := rapid.SampledFrom([]string{"gzip", "deflate", "br", "zstd", "dcb", "dcz", "DCB", "Dcz", "identity", "*", "dc", "dcbx", "x-dcb", "gzip;q=1.0", "dcb;q=0.5", "dcz ;q=0", "", " dcb", "\vdcz"})
	sep := rapid.SampledFrom([]string{",", ", ", " , ", ",\t", "\t,", ",  "})
	rapid.Check(t, func(rt *rapid.T) {
		ms := rapid.SliceOfN(member, 0, 6).Draw(rt, "members")
		var b strings.Builder
		b.WriteString(rapid.SampledFrom([]string{"", " ", "\t"}).Draw(rt, "lead"))
		for i, m := range ms {
			if i > 0 {
				b.WriteString(sep.Draw(rt, "sep"))
			}
			b.WriteString(m)
		}
		ae := b.String()
		want, _, err := oracle.Ask("dictae", ae)
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		r := &http.Request{Header: http.Header{"Accept-Encoding": {ae}}}
		noDictionaryOffer(r)
		if got := r.Header.Get("Accept-Encoding"); got != want {
			rt.Fatalf("Accept-Encoding %q\n got  %q\n spec %q", ae, got, want)
		}
	})
}

func TestSpecConformance_DictionaryHeaders(t *testing.T) {
	oracle := specoracle.Need(t)
	rapid.Check(t, func(rt *rapid.T) {
		v := rapid.SampledFrom([]string{`match="/*"`, `match="/d/*", type=raw`, `id="x", match="/a"`, ``, `(`, `match="/a",`}).Draw(rt, "value")
		want, _, err := oracle.Ask("dictreg", v)
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		resp := &http.Response{Header: http.Header{"Use-As-Dictionary": {v}}}
		noDictionaryRegistration(resp)
		if got := resp.Header.Get("Use-As-Dictionary"); got != want {
			rt.Fatalf("Use-As-Dictionary %q\n got  %q\n spec %q", v, got, want)
		}
		name := rapid.SampledFrom([]string{"Available-Dictionary", "Dictionary-ID", "Accept-Encoding", "Accept", "Use-As-Dictionary"}).Draw(rt, "name")
		offer, _, err := oracle.Ask("dictoffer", strings.ToLower(name))
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		r := &http.Request{Header: http.Header{}}
		r.Header.Set(name, "x")
		noDictionaryOffer(r)
		if removed := r.Header.Get(name) == ""; removed != (offer == "yes") {
			rt.Fatalf("%s: removed %v, spec %s", name, removed, offer)
		}
	})
}
