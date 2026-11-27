package dnscache

import (
	"context"
	"os"
	"testing"
)

// CYRANO_LIVE_DNS=1: real lookups (not in the default run).
func TestHTTPSLookup_Live(t *testing.T) {
	if os.Getenv("CYRANO_LIVE_DNS") == "" {
		t.Skip("CYRANO_LIVE_DNS unset")
	}
	l := NewHTTPSLookup()
	for _, h := range []string{"www.napaonline.com", "codepen.io", "example.com", "127.0.0.1"} {
		alpn, found := l.Alpn(context.Background(), h)
		t.Logf("%s: found=%v alpn=%v", h, found, alpn)
	}
}
