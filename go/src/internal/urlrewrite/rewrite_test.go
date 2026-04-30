package urlrewrite

import (
	"net/url"
	"strings"
	"testing"
)

func mustURL(t *testing.T, s string) *url.URL {
	t.Helper()
	u, err := url.Parse(s)
	if err != nil {
		t.Fatalf("parse %q: %v", s, err)
	}
	return u
}

// devCfg models a typical dev deploy: single public origin
// `http://localhost:9081`. Every rewritten URL lands there regardless of
// the target's scheme.
var devCfg = ProxyConfig{
	PublicURL: &url.URL{Scheme: "http", Host: "localhost:9081"},
}

// prodCfg models a production deploy: single public origin
// `https://proxy.example.com`, TLS terminated upstream at a load balancer.
var prodCfg = ProxyConfig{
	PublicURL: &url.URL{Scheme: "https", Host: "proxy.example.com"},
}

func TestRewrite_AnchorOnly(t *testing.T) {
	got := Rewrite("#top", mustURL(t, "https://example.com/"), devCfg)
	if got != "#top" {
		t.Errorf("anchor: got %q want %q", got, "#top")
	}
}

func TestRewrite_PassthroughSchemes(t *testing.T) {
	cases := []string{
		"javascript:void(0)",
		"data:image/png;base64,abc",
		"blob:https://example.com/uuid",
		"mailto:hi@example.com",
		"tel:+15551234",
	}
	for _, in := range cases {
		got := Rewrite(in, mustURL(t, "https://example.com/"), devCfg)
		if got != in {
			t.Errorf("passthrough %q: got %q", in, got)
		}
	}
}

// ── dev: HTTP-only public URL ────────────────────────────────────────────

func TestRewrite_Dev_AbsoluteHTTPSTarget(t *testing.T) {
	// HTTPS upstream lands on the HTTP dev origin — single-public-URL
	// invariant; the target's scheme is preserved inside the b64 payload.
	got := Rewrite("https://example.com/foo",
		mustURL(t, "https://example.com/"), devCfg)
	want := "http://localhost:9081/?goto=aHR0cHM6Ly9leGFtcGxlLmNvbS9mb28"
	if got != want {
		t.Errorf("got %q\nwant %q", got, want)
	}
}

func TestRewrite_Dev_AbsoluteHTTPTarget(t *testing.T) {
	got := Rewrite("http://example.com/foo",
		mustURL(t, "http://example.com/"), devCfg)
	want := "http://localhost:9081/?goto=aHR0cDovL2V4YW1wbGUuY29tL2Zvbw"
	if got != want {
		t.Errorf("got %q\nwant %q", got, want)
	}
}

func TestRewrite_Dev_RelativePath(t *testing.T) {
	got := Rewrite("/about",
		mustURL(t, "https://example.com/"), devCfg)
	want := "http://localhost:9081/?goto=aHR0cHM6Ly9leGFtcGxlLmNvbS9hYm91dA"
	if got != want {
		t.Errorf("got %q\nwant %q", got, want)
	}
}

func TestRewrite_Dev_ProtocolRelative(t *testing.T) {
	got := Rewrite("//cdn.example.com/script.js",
		mustURL(t, "https://example.com/"), devCfg)
	want := "http://localhost:9081/?goto=aHR0cHM6Ly9jZG4uZXhhbXBsZS5jb20vc2NyaXB0Lmpz"
	if got != want {
		t.Errorf("got %q\nwant %q", got, want)
	}
}

func TestRewrite_Dev_FragmentPreserved(t *testing.T) {
	got := Rewrite("https://example.com/page#section",
		mustURL(t, "https://example.com/"), devCfg)
	want := "http://localhost:9081/?goto=aHR0cHM6Ly9leGFtcGxlLmNvbS9wYWdl#section"
	if got != want {
		t.Errorf("got %q\nwant %q", got, want)
	}
}

// Regression for the bug we just fixed: an HTTPS subresource on a proxified
// page used to rewrite to an unreachable HTTPS:port URL. Single-PublicURL
// design fixes this by construction.
func TestRewrite_Dev_HTTPSSubresourceOnHTTPSPage(t *testing.T) {
	got := Rewrite(
		"https://upload.wikimedia.org/wikipedia/en/foo.png",
		mustURL(t, "https://wikipedia.org/"),
		devCfg,
	)
	want := "http://localhost:9081/?goto=aHR0cHM6Ly91cGxvYWQud2lraW1lZGlhLm9yZy93aWtpcGVkaWEvZW4vZm9vLnBuZw"
	if got != want {
		t.Errorf("got %q\nwant %q", got, want)
	}
}

// ── prod: HTTPS public URL behind a load balancer ───────────────────────

func TestRewrite_Prod_HTTPSTarget(t *testing.T) {
	got := Rewrite("https://cdn.target.com/a.js",
		mustURL(t, "https://target.com/"), prodCfg)
	want := "https://proxy.example.com/?goto=aHR0cHM6Ly9jZG4udGFyZ2V0LmNvbS9hLmpz"
	if got != want {
		t.Errorf("got %q\nwant %q", got, want)
	}
}

func TestRewrite_Prod_HTTPTarget(t *testing.T) {
	got := Rewrite("http://target.com/foo",
		mustURL(t, "http://target.com/"), prodCfg)
	want := "https://proxy.example.com/?goto=aHR0cDovL3RhcmdldC5jb20vZm9v"
	if got != want {
		t.Errorf("got %q\nwant %q", got, want)
	}
}

// ── already-proxified detection + on-proxy bare URLs ────────────────────

func TestRewrite_AlreadyProxified(t *testing.T) {
	in := "http://localhost:9081/?goto=aHR0cHM6Ly9leGFtcGxlLmNvbS8"
	got := Rewrite(in, mustURL(t, "http://localhost:9081/"), devCfg)
	if got != in {
		t.Errorf("already-proxified mutated: got %q", got)
	}
}

func TestRewrite_OnProxyHostNoLoad(t *testing.T) {
	// A request to the proxy origin without ?goto= — leave it alone (it's
	// hitting a static endpoint or the landing page).
	in := "http://localhost:9081/rewriter.js"
	got := Rewrite(in, mustURL(t, "http://localhost:9081/"), devCfg)
	if got != in {
		t.Errorf("on-proxy bare URL mutated: got %q want %q", got, in)
	}
}

// Default-port equivalence: prod public URL has no explicit port; an
// explicit :443 form pointing at the same origin is the same place.
func TestRewrite_Prod_DefaultPortMatchesExplicit(t *testing.T) {
	in := "https://proxy.example.com:443/?goto=aHR0cHM6Ly9leGFtcGxlLmNvbS8"
	got := Rewrite(in, mustURL(t, "https://target.com/"), prodCfg)
	if got != in {
		t.Errorf("explicit :443 against implicit-port public URL should be unchanged: got %q", got)
	}
}

// ── unwrap ──────────────────────────────────────────────────────────────

func TestUnwrap(t *testing.T) {
	cases := []struct{ proxied, want string }{
		{"http://localhost:9081/?goto=aHR0cHM6Ly9leGFtcGxlLmNvbS9mb28", "https://example.com/foo"},
		{"http://localhost:9081/?goto=aHR0cHM6Ly9leGFtcGxlLmNvbS9wYWdl#section", "https://example.com/page#section"},
		{"https://example.com/", "https://example.com/"},                                // not on proxy → unchanged
		{"http://localhost:9081/rewriter.js", "http://localhost:9081/rewriter.js"},         // on proxy without load → unchanged
	}
	for _, c := range cases {
		got := Unwrap(c.proxied, devCfg)
		if got != c.want {
			t.Errorf("Unwrap(%q) = %q, want %q", c.proxied, got, c.want)
		}
	}
}

// ── APIBase ─────────────────────────────────────────────────────────────

func TestAPIBase_Dev(t *testing.T) {
	if got := APIBase(devCfg); got != "http://localhost:9081" {
		t.Errorf("APIBase dev: got %q", got)
	}
}

func TestAPIBase_Prod(t *testing.T) {
	if got := APIBase(prodCfg); got != "https://proxy.example.com" {
		t.Errorf("APIBase prod: got %q", got)
	}
}

// ── default-port normalization in IsProxyHost ───────────────────────────

func TestIsProxyHost_DefaultPortNormalized(t *testing.T) {
	cases := []struct {
		in   string
		want bool
	}{
		{"https://proxy.example.com/", true},
		{"https://proxy.example.com:443/", true}, // explicit default
		{"https://proxy.example.com:8443/", false},
		{"http://proxy.example.com/", false}, // wrong scheme
	}
	for _, c := range cases {
		got := IsProxyHost(mustURL(t, c.in), prodCfg)
		if got != c.want {
			t.Errorf("IsProxyHost(%q) = %v, want %v", c.in, got, c.want)
		}
	}
}

// ── whitespace stripping ──────────────────────────────────────────────────

func TestRewrite_StripsNewlineFromURL(t *testing.T) {
	base := mustURL(t, "https://example.com/")
	raw := "http://www.google.com/maps/place/34.20275,-83.45582\n"
	got := Rewrite(raw, base, devCfg)
	if got == raw {
		t.Errorf("URL with newline was not rewritten: %q", got)
	}
	if strings.Contains(got, "\n") {
		t.Errorf("rewritten URL still contains newline: %q", got)
	}
}

func TestRewrite_StripsTabAndCRFromURL(t *testing.T) {
	base := mustURL(t, "https://example.com/")
	raw := "https://cdn.example.com/path\t/file\r.js"
	got := Rewrite(raw, base, devCfg)
	if got == raw {
		t.Errorf("URL with tab/CR was not rewritten: %q", got)
	}
}
