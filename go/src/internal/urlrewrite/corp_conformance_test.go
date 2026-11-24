package urlrewrite

import (
	"testing"

	"github.com/yovico/cyrano/internal/specoracle"
	"pgregory.net/rapid"
)

func TestSpecConformance_CORP(t *testing.T) {
	oracle := specoracle.Need(t)
	urls := []string{"https://a.example/p", "http://a.example/p", "https://www.a.example/x", "https://b.example/y", "http://127.0.0.1:8/z", "http://127.0.0.1:9/z", "http://localhost:8/q"}
	rapid.Check(t, func(rt *rapid.T) {
		h := rapid.SampledFrom([]string{"-", "same-origin", "same-site", "cross-origin", " same-site ", "Same-Origin", "same-origin, x", "", "\tsame-origin", "cross-origin\t", "same-sitet", "tsame-origin"}).Draw(rt, "header")
		emb := rapid.SampledFrom([]string{"none", "require-corp", "credentialless"}).Draw(rt, "embedder")
		cred := rapid.Bool().Draw(rt, "credentialed")
		o := rapid.SampledFrom(urls).Draw(rt, "origin")
		tg := rapid.SampledFrom(urls).Draw(rt, "target")
		site := func(u string) string {
			a, res := parseRef(nil, preprocess(u))
			if res != parsedURL {
				return "-"
			}
			if s := registrable(hostOf(a)); s != "" {
				return s
			}
			return "-"
		}
		want, _, err := oracle.Ask("corp", h, emb, map[bool]string{true: "yes", false: "no"}[cred], o, site(o), tg, site(tg))
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		e := map[string]string{"none": EmbedderNone, "require-corp": EmbedderRequireCorp, "credentialless": EmbedderCredentialless}[emb]
		got := "allow"
		if CORPBlocks(h, h != "-", e, cred, o, tg) {
			got = "block"
		}
		if got != want {
			rt.Fatalf("CORPBlocks(%q, %s, cred %v, %s → %s) = %s, spec %s", h, emb, cred, o, tg, got, want)
		}
	})
}
