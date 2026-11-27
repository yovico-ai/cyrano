package urlrewrite

// A speculation rule set's content (spec/Speculation.agda rewriteRuleSet):
// every string of an array that is the value of a "urls" member — a list
// rule's URLs, prefetch and prerender alike — proxified, resolved against
// the rule set's base; the rest byte for byte. A script that read a link's
// href (the page's URL) and wrote it into a list rule had the browser
// prefetch it from the origin (immi-usa.com). Text that is not JSON at the
// token level is left as written.

import "net/url"

type ruleFrame uint8

const (
	frameURLs ruleFrame = iota
	frameArray
	frameObject
)

// RewriteRuleSetText rewrites a rule set's "urls" strings with rewrite (a
// URL it returns unchanged keeps its text as written).
func RewriteRuleSetText(text string, rewrite func(string) string) string {
	toks, ok := jsonTokens(text)
	if !ok {
		return text
	}
	var out []byte
	var frames []ruleFrame
	var key, prev *string
	for _, t := range toks {
		switch t.kind {
		case jWS:
			out = append(out, t.text...)
		case jLit:
			out = append(out, t.text...)
			key, prev = nil, nil
		case jString:
			if len(frames) > 0 && frames[len(frames)-1] == frameURLs {
				if u := rewrite(t.value); u != t.value {
					out = append(out, jsonStringify(u)...)
				} else {
					out = append(out, t.text...)
				}
			} else {
				out = append(out, t.text...)
			}
			v := t.value
			prev = &v
		case jPunct:
			out = append(out, t.text...)
			switch t.text {
			case ":":
				key, prev = prev, nil
			case "[":
				f := frameArray
				if key != nil && *key == "urls" {
					f = frameURLs
				}
				frames = append(frames, f)
				key, prev = nil, nil
			case "{":
				frames = append(frames, frameObject)
				key, prev = nil, nil
			case "]", "}":
				if len(frames) > 0 {
					frames = frames[:len(frames)-1]
				}
				key, prev = nil, nil
			default:
				key, prev = nil, nil
			}
		}
	}
	return string(out)
}

// RewriteRuleSet rewrites a rule set against base: its URLs are documents'
// (no mark).
func RewriteRuleSet(src []byte, base *url.URL, cfg ProxyConfig) []byte {
	return []byte(RewriteRuleSetText(string(src), func(u string) string { return RewriteDest(u, base, cfg, "") }))
}
