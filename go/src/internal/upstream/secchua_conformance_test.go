package upstream

// Conformance of SecChUa with spec/Hints.agda secChUa (the spec against
// Chromium: ts/client/tests/spec/hints-vs-chromium).

import (
	"net/http/httptest"
	"strconv"
	"testing"

	fhttp "github.com/bogdanfinn/fhttp"
	"github.com/yovico/cyrano/internal/urlrewrite"

	"github.com/yovico/cyrano/internal/specoracle"
	"pgregory.net/rapid"
)

func TestMain(m *testing.M) {
	specoracle.Main(m, []string{"http", "https", "ws", "wss"})
}

func TestSpecConformance_SecChUa(t *testing.T) {
	oracle := specoracle.Need(t)
	rapid.Check(t, func(rt *rapid.T) {
		major := rapid.IntRange(100, 200).Draw(rt, "major")
		product := rapid.SampledFrom([]string{"Google Chrome", "HeadlessChrome", "Microsoft Edge"}).Draw(rt, "product")
		want, _, err := oracle.Ask("secchua", strconv.Itoa(major), product)
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		if got := SecChUa(major, product); got != want {
			rt.Fatalf("SecChUa(%d, %s)\n got  %s\n spec %s", major, product, got, want)
		}
	})
}

// Chrome 139 sends this (recorded); the fixed GREASE brand did not.
func TestSecChUa_Chrome139(t *testing.T) {
	if got := SecChUa(139, "Google Chrome"); got != `"Not;A=Brand";v="99", "Google Chrome";v="139", "Chromium";v="139"` {
		t.Errorf("SecChUa(139) = %s", got)
	}
}

// To an http name a direct browser sends no fetch metadata and no client
// hints (spec/Metadata.agda; recorded in Chromium). The browser sent them
// to the proxy, and the transport also synthesized Sec-CH-UA.
func TestCopyHeaders_NoMetadataToHTTPNames(t *testing.T) {
	ua := "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36"
	for target, want := range map[string]bool{"http://u.example/p": false, "https://u.example/p": true, "http://localhost:8080/": true, "http://127.0.0.1/": true} {
		req := httptest.NewRequest("GET", target, nil)
		req.Header.Set("User-Agent", ua)
		req.Header.Set("Sec-Fetch-Mode", "navigate")
		req.Header.Set("Upgrade-Insecure-Requests", "1")
		out := fhttp.Header{}
		copyHeaders(out, req)
		if got := out.Get("Sec-Fetch-Mode") != "" && out.Get("Sec-Ch-Ua") != ""; got != want {
			t.Errorf("%s: metadata sent %v, want %v (%v)", target, got, want, out)
		}
		if out.Get("Upgrade-Insecure-Requests") != "1" {
			t.Errorf("%s: Upgrade-Insecure-Requests dropped", target)
		}
	}
}

func TestSpecConformance_SecureOnlyHeaders(t *testing.T) {
	oracle := specoracle.Need(t)
	rapid.Check(t, func(rt *rapid.T) {
		name := rapid.SampledFrom([]string{"Sec-Fetch-Mode", "sec-fetch-storage-access", "Sec-CH-UA", "sec-ch-ua-arch", "DPR", "Device-Memory", "Viewport-Width",
			"Width", "RTT", "Downlink", "ECT", "Save-Data", "Upgrade-Insecure-Requests", "Sec-WebSocket-Key", "Sec-Purpose", "Accept", "Sec-GPC", "sec-fetch", "sec-ch"}).Draw(rt, "name")
		tw := rapid.Bool().Draw(rt, "trustworthy")
		b := "0"
		if tw {
			b = "1"
		}
		want, _, err := oracle.Ask("metadatasent", name, b)
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		if got := tw || !urlrewrite.SecureOnlyHeader(name); got != (want == "yes") {
			rt.Fatalf("%s to trustworthy=%v: sent %v, spec %s", name, tw, got, want)
		}
	})
}
