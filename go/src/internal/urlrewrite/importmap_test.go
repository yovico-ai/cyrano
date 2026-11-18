package urlrewrite

import (
	"encoding/json"
	"net/url"
	"testing"
)

func TestRewriteImportMap(t *testing.T) {
	cfg := ProxyConfig{PublicURL: &url.URL{Scheme: "http", Host: "localhost:9081"}}
	base, _ := url.Parse("https://site.example/app/")
	in := `{"imports":{"react":"https://cdn.example/react.js","lib/":"/vendor/lib/","https://cdn.example/x.js":"./local/x.js","blocked":null},
	        "scopes":{"/admin/":{"react":"https://cdn.example/react-admin.js"}},
	        "integrity":{"https://cdn.example/react.js":"sha384-abc"}}`
	var got map[string]any
	if err := json.Unmarshal(RewriteImportMap([]byte(in), base, cfg), &got); err != nil {
		t.Fatal(err)
	}
	P := "http://localhost:9081/cyrano/https/"
	imports := got["imports"].(map[string]any)
	for k, want := range map[string]any{
		"react": P + "cdn.example/react.js", "lib/": P + "site.example/vendor/lib/",
		P + "cdn.example/x.js": P + "site.example/app/local/x.js", "blocked": nil,
	} {
		if imports[k] != want {
			t.Errorf("imports[%q] = %v, want %v", k, imports[k], want)
		}
	}
	scopes := got["scopes"].(map[string]any)
	if s, ok := scopes[P+"site.example/admin/"].(map[string]any); !ok || s["react"] != P+"cdn.example/react-admin.js" {
		t.Errorf("scopes = %v", scopes)
	}
	if _, has := got["integrity"]; has {
		t.Error("integrity kept: its hashes cannot match rewritten modules")
	}
	if out := RewriteImportMap([]byte("not json"), base, cfg); string(out) != "not json" {
		t.Errorf("non-JSON changed: %q", out)
	}
}
