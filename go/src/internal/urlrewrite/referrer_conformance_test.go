package urlrewrite

// Conformance of referrer.go with spec/Referrer.agda, asked live.

import (
	"errors"
	"strings"
	"testing"

	"github.com/yovico/cyrano/internal/specoracle"
	"pgregory.net/rapid"
)

var (
	policyNames = []string{
		"no-referrer", "no-referrer-when-downgrade", "same-origin", "origin", "strict-origin",
		"origin-when-cross-origin", "strict-origin-when-cross-origin", "unsafe-url",
	}
	refURLs = []string{
		"https://a.example/x/y?q=1#frag", "https://u:p@a.example/x", "https://A.example:443/", "http://a.example/x",
		"https://b.example/", "https://sub.a.example/p?", "http://localhost:8080/x", "http://127.0.0.1/x",
		"http://[::1]:9/x", "https://a.example:8443/x", "http://b.example/y", "https://1.2.3.4/", "http://1.2.3.4:81/",
		"https://a.example/" + strings.Repeat("p", 4100), "wss://a.example/s", "ws://b.example/s",
	}
)

func ask(rt *rapid.T, oracle *specoracle.Client, op string, args ...string) (string, bool) {
	out, ok, err := oracle.Ask(op, args...)
	if errors.Is(err, specoracle.ErrOutOfModel) {
		rt.Skip("outside the spec's model")
	}
	if err != nil {
		rt.Fatalf("oracle: %v", err)
	}
	return out, ok
}

func TestSpecConformance_HeaderPolicy(t *testing.T) {
	oracle := specoracle.Need(t)
	toks := append([]string{"", " ", "bogus", "ORIGIN", " Strict-Origin\t", "unsafe-url ", "no-referrer\n"}, policyNames...)
	rapid.Check(t, func(rt *rapid.T) {
		v := strings.Join(rapid.SliceOfN(rapid.SampledFrom(toks), 0, 4).Draw(rt, "tokens"), ",")
		want, _ := ask(rt, oracle, "policy", v)
		if got := string(HeaderPolicy(v)); got != want {
			rt.Fatalf("HeaderPolicy(%q) = %q, spec says %q", v, got, want)
		}
	})
}

func TestSpecConformance_Referrer(t *testing.T) {
	oracle := specoracle.Need(t)
	rapid.Check(t, func(rt *rapid.T) {
		p := rapid.SampledFrom(policyNames).Draw(rt, "policy")
		from := rapid.SampledFrom(refURLs).Draw(rt, "from")
		to := rapid.SampledFrom(refURLs).Draw(rt, "to")
		want, wantOK := ask(rt, oracle, "referrer", p, from, to)
		got, ok := Referrer(Policy(p), from, to)
		if ok != wantOK || (ok && got != want) {
			rt.Fatalf("Referrer(%s, %q → %q) = %q,%v; spec says %q,%v", p, from, to, got, ok, want, wantOK)
		}
	})
}

func TestSpecConformance_OriginHeader(t *testing.T) {
	oracle := specoracle.Need(t)
	rapid.Check(t, func(rt *rapid.T) {
		mode := rapid.SampledFrom([]string{"navigate", "same-origin", "no-cors", "cors", "websocket"}).Draw(rt, "mode")
		safe := rapid.Bool().Draw(rt, "safe")
		p := rapid.SampledFrom(policyNames).Draw(rt, "policy")
		from := rapid.SampledFrom(append([]string{"null"}, refURLs...)).Draw(rt, "from") // "null": an opaque origin
		to := rapid.SampledFrom(refURLs).Draw(rt, "to")
		sm := "unsafe"
		if safe {
			sm = "safe"
		}
		want, wantOK := ask(rt, oracle, "origin", mode, sm, p, from, to)
		got, ok := OriginHeader(mode, safe, Policy(p), from, to)
		if ok != wantOK || (ok && got != want) {
			rt.Fatalf("OriginHeader(%s, safe=%v, %s, %q → %q) = %q,%v; spec says %q,%v", mode, safe, p, from, to, got, ok, want, wantOK)
		}
	})
}

func TestSpecConformance_SecFetchSite(t *testing.T) {
	oracle := specoracle.Need(t)
	site := func(u string) (absURL, string, string) {
		a, _ := parseRef(nil, u)
		s := registrable(hostOf(a))
		if s == "" {
			return a, s, "-"
		}
		return a, s, s
	}
	rapid.Check(t, func(rt *rapid.T) {
		from := rapid.SampledFrom(append([]string{"null"}, refURLs...)).Draw(rt, "from") // "null": an opaque origin
		to := rapid.SampledFrom(refURLs).Draw(rt, "to")
		_, _, fs := site(from)
		_, _, ts := site(to)
		want, _ := ask(rt, oracle, "site", from, fs, to, ts)
		if got := SecFetchSite(from, to); got != want {
			rt.Fatalf("SecFetchSite(%q → %q) = %q, spec says %q", from, to, got, want)
		}
	})
}
