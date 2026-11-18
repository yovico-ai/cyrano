package urlrewrite

// Conformance with the Agda spec (spec/Containment.agda), asked live:
// the generators draw URLs, the compiled spec says what each must
// become, and Rewrite / Unwrap must agree byte for byte. `make
// spec-check` runs these with the oracle required; plain `go test`
// skips them, with a note, when it has not been built.

import (
	"errors"
	"net/url"
	"strings"
	"testing"

	"github.com/yovico/cyrano/internal/specoracle"
	"pgregory.net/rapid"
)

func TestMain(m *testing.M) {
	schemes := make([]string, 0, len(resolvableSchemes))
	for s := range resolvableSchemes {
		schemes = append(schemes, strings.TrimSuffix(s, ":"))
	}
	specoracle.Main(m, schemes)
}

func proxyConfig(t *rapid.T, proxy string) ProxyConfig {
	u, err := url.Parse(proxy)
	if err != nil {
		t.Fatalf("proxy %q: %v", proxy, err)
	}
	return ProxyConfig{PublicURL: u}
}

func TestSpecConformance_Rewrite(t *testing.T) {
	oracle := specoracle.Need(t)
	rapid.Check(t, func(rt *rapid.T) {
		proxy := rapid.SampledFrom(specoracle.Proxies).Draw(rt, "proxy")
		base := rapid.SampledFrom(specoracle.Bases).Draw(rt, "base")
		raw := specoracle.URL(rt, proxy)

		want, err := oracle.Rewrite(proxy, base, raw)
		if errors.Is(err, specoracle.ErrOutOfModel) {
			rt.Skip("outside the spec's model")
		}
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		baseURL, err := url.Parse(base)
		if err != nil {
			rt.Fatalf("base %q: %v", base, err)
		}
		if got := Rewrite(raw, baseURL, proxyConfig(rt, proxy)); got != want.Out {
			rt.Fatalf("Rewrite(%q) on %s = %q, spec says %q (%s)", raw, base, got, want.Out, want.Kind)
		}
	})
}

func TestSpecConformance_Unwrap(t *testing.T) {
	oracle := specoracle.Need(t)
	rapid.Check(t, func(rt *rapid.T) {
		proxy := rapid.SampledFrom(specoracle.Proxies).Draw(rt, "proxy")
		href := specoracle.ProxiedHref(rt, proxy)

		want, err := oracle.Unwrap(proxy, href)
		if errors.Is(err, specoracle.ErrOutOfModel) {
			rt.Skip("outside the spec's model")
		}
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		if got := Unwrap(href, proxyConfig(rt, proxy)); got != want.Out {
			rt.Fatalf("Unwrap(%q) = %q, spec says %q (%s)", href, got, want.Out, want.Kind)
		}
	})
}

// The fundamental principle (REQUIREMENTS.md), for URLs: what page code
// reads back for a URL it wrote is what it would be shown without
// cyrano — Unwrap(Rewrite(raw)) is the browser's own href.
func TestSpecConformance_PageCannotTell(t *testing.T) {
	oracle := specoracle.Need(t)
	rapid.Check(t, func(rt *rapid.T) {
		proxy := rapid.SampledFrom(specoracle.Proxies).Draw(rt, "proxy")
		base := rapid.SampledFrom(specoracle.Bases).Draw(rt, "base")
		raw := specoracle.URL(rt, proxy)

		rw, err := oracle.Rewrite(proxy, base, raw)
		if errors.Is(err, specoracle.ErrOutOfModel) {
			rt.Skip("outside the spec's model")
		}
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		if rw.Kind != "proxified" {
			rt.Skip("not proxified")
		}
		want, err := oracle.Direct(base, raw)
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		baseURL, err := url.Parse(base)
		if err != nil {
			rt.Fatalf("base %q: %v", base, err)
		}
		cfg := proxyConfig(rt, proxy)
		if got := Unwrap(Rewrite(raw, baseURL, cfg), cfg); got != want.Out {
			rt.Fatalf("Unwrap(Rewrite(%q)) on %s = %q, the browser shows %q", raw, base, got, want.Out)
		}
	})
}

// The same principle seen from the upstream: the request the server
// forwards for a proxified URL is the one the browser would send
// directly — scheme, host, escaped path and query byte for byte (a bare
// "?" included), and neither userinfo nor fragment, which a browser never
// puts on the wire.
func TestSpecConformance_UpstreamCannotTell(t *testing.T) {
	oracle := specoracle.Need(t)
	rapid.Check(t, func(rt *rapid.T) {
		proxy := rapid.SampledFrom(specoracle.Proxies).Draw(rt, "proxy")
		base := rapid.SampledFrom(specoracle.Bases).Draw(rt, "base")
		raw := specoracle.URL(rt, proxy)

		rw, err := oracle.Rewrite(proxy, base, raw)
		if errors.Is(err, specoracle.ErrOutOfModel) {
			rt.Skip("outside the spec's model")
		}
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		if rw.Kind != "proxified" {
			rt.Skip("not proxified")
		}
		want, err := oracle.Direct(base, raw)
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		wire := onTheWire(want.Out)

		// What the server receives: the proxified URL as an HTTP request.
		req, err := url.Parse(rw.Out)
		if err != nil {
			rt.Fatalf("proxified %q does not parse: %v", rw.Out, err)
		}
		target, ok := ParseCyranoURL(req)
		if !ok {
			rt.Fatalf("ParseCyranoURL(%q) rejected a proxified URL", rw.Out)
		}
		// Known gap (CLAUDE.md): a path starting "//" cannot go on the wire as
		// URL.Opaque, so net/url re-escapes it ("^" as %5E).
		if UpstreamPath(target) == "" && target.EscapedPath() != target.RawPath {
			rt.Skip("known gap: //-path re-escaped by net/url")
		}
		// As the proxy Director writes it (proxy/handler.go makeDirector).
		out := *target
		out.User = nil
		if p := UpstreamPath(target); p != "" {
			out.Opaque = p
		}
		if got := out.Scheme + "://" + out.Host + out.RequestURI(); got != wire {
			rt.Fatalf("raw %q on %s: upstream gets %q, the browser would send %q", raw, base, got, wire)
		}
	})
}

// onTheWire is what a browser sends for an href: no userinfo, no fragment.
func onTheWire(href string) string {
	if i := strings.IndexByte(href, '#'); i >= 0 {
		href = href[:i]
	}
	scheme, rest, _ := strings.Cut(href, "://")
	end := strings.IndexByte(rest, '/')
	if end < 0 {
		end = len(rest)
	}
	return scheme + "://" + hostPort(rest[:end]) + rest[end:]
}
