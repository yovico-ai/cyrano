package urlrewrite

import (
	"encoding/json"
	"net/url"
)

// RewriteImportMap rewrites an import map (HTML, "import maps") so it maps
// to and from proxified URLs: URL-like specifier keys and scope prefixes
// (the page's own module specifiers are proxified, so the map's keys must
// be too), and every URL-like address. Bare specifiers ("react") stay as
// written. "integrity" is dropped: its hashes are of the original modules,
// not the rewritten ones. Returns src unchanged when it is not a JSON object.
func RewriteImportMap(src []byte, base *url.URL, cfg ProxyConfig) []byte {
	var m map[string]json.RawMessage
	if err := json.Unmarshal(src, &m); err != nil {
		return src
	}
	re := func(s string) string {
		if !IsURLLikeSpecifier(s) {
			return s
		}
		return Rewrite(s, base, cfg)
	}
	specifiers := func(raw json.RawMessage) json.RawMessage {
		var in map[string]*string
		if json.Unmarshal(raw, &in) != nil {
			return raw
		}
		out := make(map[string]*string, len(in))
		for k, v := range in {
			if v != nil {
				a := re(*v)
				v = &a
			}
			out[re(k)] = v
		}
		b, _ := json.Marshal(out)
		return b
	}
	if raw, ok := m["imports"]; ok {
		m["imports"] = specifiers(raw)
	}
	if raw, ok := m["scopes"]; ok {
		var in map[string]json.RawMessage
		if json.Unmarshal(raw, &in) == nil {
			out := make(map[string]json.RawMessage, len(in))
			for prefix, sm := range in {
				out[Rewrite(prefix, base, cfg)] = specifiers(sm)
			}
			b, _ := json.Marshal(out)
			m["scopes"] = b
		}
	}
	delete(m, "integrity")
	out, err := json.Marshal(m)
	if err != nil {
		return src
	}
	return out
}
