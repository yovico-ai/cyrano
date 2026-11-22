package sitehost

// Conformance with spec/SiteHost.agda and its SHA-256 (spec/Sha256.agda),
// asked live (TS: tests/spec/sitehost-conformance.test.ts).

import (
	"crypto/sha256"
	"encoding/hex"
	"testing"

	"github.com/yovico/cyrano/internal/specoracle"
	"pgregory.net/rapid"
)

func TestMain(m *testing.M) {
	specoracle.Main(m, []string{"http", "https", "ws", "wss"})
}

func TestSpecConformance_Sha256(t *testing.T) {
	oracle := specoracle.Need(t)
	// FIPS 180-4's examples (one and two blocks), the padding edges, and non-ASCII.
	fixed := []string{"", "abc", "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
		string(make([]byte, 55)), string(make([]byte, 56)), string(make([]byte, 64)), "héllo 😀"}
	check := func(t interface{ Fatalf(string, ...any) }, s string) {
		want := sha256.Sum256([]byte(s))
		got, _, err := oracle.Ask("sha256", s)
		if err != nil {
			t.Fatalf("oracle: %v", err)
		}
		if got != hex.EncodeToString(want[:]) {
			t.Fatalf("sha256(%q): spec %s, Go %x", s, got, want)
		}
	}
	for _, s := range fixed {
		check(t, s)
	}
	rapid.Check(t, func(rt *rapid.T) { check(rt, rapid.StringN(0, 130, -1).Draw(rt, "s")) })
}

func TestSpecConformance_SiteLabel(t *testing.T) {
	oracle := specoracle.Need(t)
	schemes := []string{"http", "https", "ws", "wss"}
	hosts := []string{"www.example.com", "a.b.example.co.uk", "127.0.0.1", "[::1]", "xn--bcher-kva.example", "localhost", "6093eccf-6734-4877-ac8b-83d6d0e27b46.edgeoptimize.net"}
	regs := []string{"", "example.com", "example.co.uk", "edgeoptimize.net"}
	for _, sc := range schemes {
		for _, h := range hosts {
			for _, r := range regs {
				key, _, err := oracle.Ask("sitekey", sc, h, r)
				if err != nil {
					t.Fatalf("oracle: %v", err)
				}
				if got := Key(sc, h, r); got != key {
					t.Fatalf("Key(%s, %s, %s) = %s, spec %s", sc, h, r, got, key)
				}
				label, _, err := oracle.Ask("sitelabel", key)
				if err != nil {
					t.Fatalf("oracle: %v", err)
				}
				if got := Label(key); got != label {
					t.Fatalf("Label(%s) = %s, spec %s", key, got, label)
				}
			}
		}
	}
}

func TestSpecConformance_SiteAdmits(t *testing.T) {
	oracle := specoracle.Need(t)
	key := "https://example.com"
	good := Host("proxy.test", key)
	for _, c := range []struct{ domain, host string }{
		{"proxy.test", good}, {"proxy.test", "x" + good}, {"proxy.test", "proxy.test"}, {"proxy.test", "a." + good},
		{"proxy.test", Label(key) + ".other.test"}, {"localhost", Label(key) + ".localhost"}, {"proxy.test", ".proxy.test"},
		{"proxy.test", Label("https://other.com") + ".proxy.test"},
	} {
		want, _, err := oracle.Ask("siteadmits", c.domain, c.host, key)
		if err != nil {
			t.Fatalf("oracle: %v", err)
		}
		if got := map[bool]string{true: "yes", false: "no"}[Admits(c.domain, c.host, key)]; got != want {
			t.Errorf("Admits(%s, %s) = %s, spec %s", c.domain, c.host, got, want)
		}
	}
}
