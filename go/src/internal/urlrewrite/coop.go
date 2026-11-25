package urlrewrite

import "strings"

// CoopToken is a Cross-Origin-Opener-Policy header's token as a document's
// runtime is given it (spec/Coop.agda coopOf: a structured item, its bare
// token): "" when there is none or it is not one item that is a token.
// The runtime decides the value from it (secure context, embedder policy:
// ts/client/src/url/coop.ts).
func CoopToken(lines []string) string {
	if len(lines) == 0 {
		return ""
	}
	ms, ok := SFList(strings.Join(lines, ", "))
	if !ok || len(ms) != 1 || ms[0].Inner || ms[0].Items[0].Kind != SFToken {
		return ""
	}
	return ms[0].Items[0].Text
}
