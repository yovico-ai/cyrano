package server

// The external bootstrap (htmlrewrite.BootURL, read by bootHandler) and a
// module worker's init (workerPreamble's import, read by workerInitHandler)
// carry the runtime's config and a URL in a query: what the script hands
// the runtime is exactly what was written — the config as the same JSON
// value, the URL as the same string.

import (
	"encoding/json"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"testing"

	"github.com/yovico/cyrano/internal/config"
	"github.com/yovico/cyrano/internal/htmlrewrite"
	"github.com/yovico/cyrano/internal/urlrewrite"
	"pgregory.net/rapid"
)

var oddText = rapid.SampledFrom([]string{"", "a", "a b", "x+y", "%", "%25", "&c=1", ";", "#", "?", "é", "😀", "</script>", `"\`, " ", "=", "a=b&u=c"})

func argBetween(t *rapid.T, js, before, after string) string {
	i := strings.Index(js, before)
	if i < 0 {
		t.Fatalf("no %q in %s", before, js)
	}
	rest := js[i+len(before):]
	j := strings.Index(rest, after)
	if j < 0 {
		t.Fatalf("no %q after %q in %s", after, before, js)
	}
	return rest[:j]
}

func TestBootQueryRoundTrip(t *testing.T) {
	rapid.Check(t, func(rt *rapid.T) {
		pass := map[string]any{"apiBaseURL": "http://localhost:9081", "tt": oddText.Draw(rt, "tt"), "source": "/rewriter.js" + oddText.Draw(rt, "src"),
			"n": float64(rapid.IntRange(-1000, 1000).Draw(rt, "n")), "nested": map[string]any{"k" + oddText.Draw(rt, "k"): []any{true, nil, "v"}}}
		cfgJSON, _ := json.Marshal(pass)
		base, err := url.Parse("https://h.example/p" + url.PathEscape(oddText.Draw(rt, "path")) + "?q=" + url.QueryEscape(oddText.Draw(rt, "q")))
		if err != nil {
			rt.Skip()
		}
		rec := httptest.NewRecorder()
		bootHandler(nil, "").ServeHTTP(rec, httptest.NewRequest("GET", htmlrewrite.BootURL(cfgJSON, base), nil))
		js := rec.Body.String()
		var gotCfg, wantCfg any
		if err := json.Unmarshal([]byte(argBetween(rt, js, "$rewriter_init(window,", ").inject()")), &gotCfg); err != nil {
			rt.Fatalf("config not JSON: %v in %s", err, js)
		}
		_ = json.Unmarshal(cfgJSON, &wantCfg)
		if !reflect.DeepEqual(gotCfg, wantCfg) {
			rt.Fatalf("config %v, written %v", gotCfg, wantCfg)
		}
		var href string
		if err := json.Unmarshal([]byte(argBetween(rt, js, "set_location(", ");")), &href); err != nil || href != base.String() {
			rt.Fatalf("location %q (%v), written %q", href, err, base.String())
		}
	})
}

func TestWorkerInitQueryRoundTrip(t *testing.T) {
	vhost := &config.VHost{RewriterJSPath: "/rewriter.js"}
	cfg := urlrewrite.ProxyConfig{PublicURL: &url.URL{Scheme: "http", Host: "localhost:9081"}}
	rapid.Check(t, func(rt *rapid.T) {
		worker := "https://h.example/w" + oddText.Draw(rt, "a") + "?x=" + oddText.Draw(rt, "b") + "#" + oddText.Draw(rt, "c")
		// What workerPreamble imports, as the module worker requests it.
		pre := string(workerPreamble(urlrewrite.APIBase(cfg), vhost.RewriterJSPath, nil, worker, true))
		var spec string
		if err := json.Unmarshal([]byte(argBetween(rt, pre, "import ", ";")), &spec); err != nil {
			rt.Fatalf("import specifier: %v in %s", err, pre)
		}
		u, err := url.Parse(spec)
		if err != nil {
			rt.Fatalf("specifier %q: %v", spec, err)
		}
		rec := httptest.NewRecorder()
		workerInitHandler(vhost, cfg).ServeHTTP(rec, httptest.NewRequest("GET", u.RequestURI(), nil))
		args := argBetween(rt, rec.Body.String(), "$rewriter_init_worker(", ");")
		var href string
		if err := json.Unmarshal([]byte(args[strings.LastIndex(args, ",")+1:]), &href); err != nil || href != worker {
			rt.Fatalf("worker URL %q (%v), written %q", href, err, worker)
		}
	})
}
