package proxy

// Conformance of HTTPS-Upgrades with spec/Upgrades.agda: which hosts,
// the scheme swap, and the per-host state over a run of events.

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/yovico/cyrano/internal/specoracle"
	"pgregory.net/rapid"
)

func TestSpecConformance_Upgradable(t *testing.T) {
	oracle := specoracle.Need(t)
	rapid.Check(t, func(rt *rapid.T) {
		host := rapid.SampledFrom([]string{"a.com", "x.github.io", "github.io", "co.uk", "a.b.co.uk", "bucher.xn--p1ai", "a.test", "a.ck", "ck", "a.kawasaki.jp", "a.example", "www.Example.COM", "a.example.", "intranet", "localhost", "x.localhost", "LOCALHOST",
			"1.2.3.4", "10.0.0.1", "[::1]", "[2001:db8::1]", "a.b.c", "xn--bcher-kva.example", "."}).Draw(rt, "host")
		port := rapid.SampledFrom([]string{"", ":80", ":443", ":8080", ":1"}).Draw(rt, "port")
		reg := "0"
		if h := strings.TrimSuffix(strings.ToLower(host), "."); h != "" && !strings.HasPrefix(h, "[") && knownTLD(h) {
			reg = "1"
		}
		want, _, err := oracle.Ask("upgradable", host+port, reg)
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		if got := upgradable(host + port); got != (want == "yes") {
			rt.Fatalf("upgradable(%s) = %v, spec %s", host+port, got, want)
		}
	})
}

func TestSpecConformance_SwapScheme(t *testing.T) {
	oracle := specoracle.Need(t)
	rapid.Check(t, func(rt *rapid.T) {
		pre := rapid.SampledFrom([]string{"/cyrano/", "/cyrano/", "/cyrano", "/x/", "//cyrano/", ""}).Draw(rt, "pre")
		scheme := rapid.SampledFrom([]string{"http", "https", "ws", "HTTP"}).Draw(rt, "scheme")
		marks := rapid.SampledFrom([]string{"", "!origin", "!js", "!no-referrer!css", "!"}).Draw(rt, "marks")
		rest := rapid.SampledFrom([]string{"/a.example/p?q=1", "/a.example", "", "/", "/h/!x/y"}).Draw(rt, "rest")
		from := rapid.SampledFrom([]string{"http", "https"}).Draw(rt, "from")
		to := map[string]string{"http": "https", "https": "http"}[from]
		target := pre + scheme + marks + rest
		want, _, err := oracle.Ask("swapscheme", from, to, target)
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		got, ok := swapSchemeTarget(target, from, to)
		if !ok {
			got = "none"
		}
		if got != want {
			rt.Fatalf("swapScheme(%s, %s, %q) = %q, spec %q", from, to, target, got, want)
		}
	})
}

// A run of events for one host — http navigations, https pages loading,
// https loads failing, at times in seconds — decides as the spec does.
func TestSpecConformance_UpgradeSteps(t *testing.T) {
	oracle := specoracle.Need(t)
	defer func(c func() time.Time) { upgradeClock = c }(upgradeClock)
	base := time.Unix(1_000_000, 0)
	rapid.Check(t, func(rt *rapid.T) {
		upgrades.mu.Lock()
		upgrades.pending, upgrades.fallback = nil, nil
		upgrades.mu.Unlock()
		h := upgradeHandler()
		var now int64
		upgradeClock = func() time.Time { return base.Add(time.Duration(now) * time.Second) }
		var events []string
		var got strings.Builder
		for k := rapid.IntRange(1, 8).Draw(rt, "n"); k > 0; k-- {
			now += int64(rapid.SampledFrom([]int{0, 1, 5, 29, 30, 31, 604799, 604800, 700000}).Draw(rt, "dt"))
			t := strconv.FormatInt(now, 10)
			switch rapid.IntRange(0, 2).Draw(rt, "event") {
			case 0:
				events = append(events, "n"+t)
				if h.upgradeNavigation(httptest.NewRecorder(), navigation("/cyrano/http/u.com/", "s"), "u.com") {
					got.WriteByte('U')
				} else {
					got.WriteByte('P')
				}
			case 1:
				events = append(events, "l")
				out := navigation("/", "s")
				out.URL = &url.URL{Scheme: "https", Host: "u.com", Path: "/"}
				upgradeLoaded(&http.Response{StatusCode: 200, Request: out}, "s")
			case 2:
				events = append(events, "f"+t)
				if h.upgradeFailed(httptest.NewRecorder(), navigation("/cyrano/https/u.com/", "s"), "u.com") {
					got.WriteByte('B')
				} else {
					got.WriteByte('-')
				}
			}
		}
		want, _, err := oracle.Ask("upgradesteps", strings.Join(events, " "))
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		if got.String() != want {
			rt.Fatalf("events %v: got %s, spec %s", events, got.String(), want)
		}
	})
}

// An <a referrerpolicy> navigation's URL carries a mark; it was never
// upgraded (only "/cyrano/http/" was recognised), nor fell back.
func TestHTTPSUpgrade_MarkedNavigation(t *testing.T) {
	h := upgradeHandler()
	rec := httptest.NewRecorder()
	if !h.upgradeNavigation(rec, navigation("/cyrano/http!origin/marked.com/a", "m"), "marked.com") ||
		rec.Header().Get("Location") != "/cyrano/https!origin/marked.com/a" {
		t.Fatalf("marked navigation: %d %q", rec.Code, rec.Header().Get("Location"))
	}
	rec = httptest.NewRecorder()
	if !h.upgradeFailed(rec, navigation("/cyrano/https!origin/marked.com/a", "m"), "marked.com") ||
		rec.Header().Get("Location") != "/cyrano/http!origin/marked.com/a" {
		t.Fatalf("marked fallback: %d %q", rec.Code, rec.Header().Get("Location"))
	}
}

// What Chrome upgraded and did not (recorded with real Chrome: tests in
// upgrades-vs-chrome): a.example and x.test are non-unique names; the
// loose rule upgraded them.
func TestHTTPSUpgrade_UniqueNamesOnly(t *testing.T) {
	for host, want := range map[string]bool{
		"upgrade-probe.com": true, "a.b.co.uk": true, "upgrade-probe.com.": true, "bucher.xn--p1ai": true,
		"x.github.io": true, "github.io": true, "co.uk": true, "a.ck": true, "a.kawasaki.jp": true, "blogspot.com": true,
		"a.example": false, "upgrade-probe.test": false, "intranet": false, "com": false, "uk": false, "a.local": false, "x.invalid": false,
	} {
		if got := upgradable(host); got != want {
			t.Errorf("upgradable(%s) = %v, want %v", host, got, want)
		}
	}
}

// The Sec-Fetch-Storage-Access decision against spec/Storage.agda (the
// spec against Chromium: storage-access-vs-chromium).
func TestSpecConformance_StorageAccess(t *testing.T) {
	oracle := specoracle.Need(t)
	sites := []string{"https://a.example", "https://b.example", "http://c.example"}
	rapid.Check(t, func(rt *rapid.T) {
		chain := rapid.SliceOfN(rapid.SampledFrom(sites), 1, 4).Draw(rt, "chain")
		mode := rapid.SampledFrom([]string{"navigate", "cors", "no-cors", "same-origin"}).Draw(rt, "mode")
		dest := rapid.SampledFrom([]string{"document", "iframe", "empty", "image", "script"}).Draw(rt, "dest")
		cred := rapid.SampledFrom([]string{"include", "omit", "same-origin"}).Draw(rt, "cred")
		from := chain[len(chain)-1]
		to := rapid.SampledFrom(sites).Draw(rt, "to")
		tw := rapid.Bool().Draw(rt, "trustworthy")
		b := "0"
		if tw {
			b = "1"
		}
		want, _, err := oracle.Ask("storageaccess", mode, dest, cred, strings.Join(chain, " "), from, to, to, b)
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		ctx := frameContext{top: chain[0]}
		for _, s := range chain {
			ctx.cross = ctx.cross || s != chain[0]
		}
		got := storageAccessActive(mode, dest, cred, ctx, from, to, to, tw)
		if got != (want == "active") {
			rt.Fatalf("%s %s %s chain %v → %s: %v, spec %s", mode, dest, cred, chain, to, got, want)
		}
	})
}
