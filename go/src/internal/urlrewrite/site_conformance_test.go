package urlrewrite

// Conformance of host mode (ProxyConfig.Sites) with
// spec/SiteContainment.agda, asked live, with the oracle's stand-in
// registrable domain (spec Oracle regStandIn) given to the runtime.

import (
	"errors"
	"net/url"
	"strings"
	"testing"

	"github.com/yovico/cyrano/internal/specoracle"
	"pgregory.net/rapid"
)

// regStandIn is spec Oracle regStandIn: the last two labels; "" for an IP
// address (bracketed, or digits and dots only) or a single label.
func regStandIn(h string) string {
	if h == "" || h[0] == '[' || strings.Trim(h, "0123456789.") == "" {
		return ""
	}
	ls := strings.Split(h, ".")
	if len(ls) < 2 {
		return ""
	}
	return ls[len(ls)-2] + "." + ls[len(ls)-1]
}

func siteConfig(t *rapid.T, proxy string) ProxyConfig {
	c := proxyConfig(t, proxy)
	c.Sites = true
	return c
}

func TestSpecConformance_SiteRewrite(t *testing.T) {
	oracle := specoracle.Need(t)
	rapid.Check(t, func(rt *rapid.T) {
		proxy := rapid.SampledFrom(specoracle.Proxies).Draw(rt, "proxy")
		base := rapid.SampledFrom(specoracle.Bases).Draw(rt, "base")
		raw := specoracle.URL(rt, proxy)
		pol := rapid.SampledFrom(append([]string{"-", "-"}, specoracle.Policies...)).Draw(rt, "policy")
		dest := rapid.SampledFrom([]string{"-", "-", "js", "css", "frame", "inert"}).Draw(rt, "dest")
		want, _, err := oracle.Ask("siterewrite", proxy, base, pol, dest, raw)
		if errors.Is(err, specoracle.ErrOutOfModel) {
			rt.Skip("outside the spec's model")
		}
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		baseURL, _ := url.Parse(base)
		m := Mark{}
		if pol != "-" {
			m.Policy = Policy(pol)
		}
		if dest != "-" {
			m.Dest = Dest(dest)
		}
		if got := RewriteMarked(raw, baseURL, siteConfig(rt, proxy), m); got != want {
			rt.Fatalf("host mode RewriteMarked(%q, %+v) on %s = %q, spec says %q", raw, m, base, got, want)
		}
	})
}

// Hrefs on the proxy's hosts: rewritten URLs, the same moved to another
// site's host, to the apex, and arbitrary proxied hrefs.
func TestSpecConformance_SiteUnwrap(t *testing.T) {
	oracle := specoracle.Need(t)
	rapid.Check(t, func(rt *rapid.T) {
		proxy := rapid.SampledFrom(specoracle.Proxies).Draw(rt, "proxy")
		cfg := siteConfig(rt, proxy)
		base, _ := url.Parse(rapid.SampledFrom(specoracle.Bases).Draw(rt, "base"))
		var href string
		switch rapid.IntRange(0, 2).Draw(rt, "kind") {
		case 0:
			href = Rewrite(specoracle.URL(rt, proxy), base, cfg)
		case 1:
			href = strings.Replace(Rewrite(specoracle.URL(rt, proxy), base, cfg), "://", "://"+rapid.SampledFrom([]string{"x.", "aaaa.", "user@"}).Draw(rt, "prefix"), 1)
		default:
			href = specoracle.ProxiedHref(rt, proxy)
		}
		want, _, err := oracle.Ask("siteunwrap", proxy, href)
		if errors.Is(err, specoracle.ErrOutOfModel) {
			rt.Skip("outside the spec's model")
		}
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		if got := Unwrap(href, cfg); got != want {
			rt.Fatalf("host mode Unwrap(%q) = %q, spec says %q", href, got, want)
		}
	})
}

// The fundamental principle in host mode: Unwrap(Rewrite(raw)) is the
// browser's own href, whichever site's host the URL is put on (spec
// unwrap-site, here for the runtime).
func TestSpecConformance_SitePageCannotTell(t *testing.T) {
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
		baseURL, _ := url.Parse(base)
		cfg := siteConfig(rt, proxy)
		if got := Unwrap(Rewrite(raw, baseURL, cfg), cfg); got != want.Out {
			rt.Fatalf("host mode Unwrap(Rewrite(%q)) on %s = %q, the browser shows %q", raw, base, got, want.Out)
		}
	})
}
