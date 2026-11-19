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
	// Module URLs: marked as scripts (spec/Containment.agda Dest).
	P := "http://localhost:9081/cyrano/https!js/"
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
	// Its hashes cannot match rewritten modules: emptied (spec/ImportMap.agda).
	if in, ok := got["integrity"].(map[string]any); !ok || len(in) != 0 {
		t.Errorf("integrity = %v, want {}", got["integrity"])
	}
	if out := RewriteImportMap([]byte("not json"), base, cfg); string(out) != "not json" {
		t.Errorf("non-JSON changed: %q", out)
	}
}
