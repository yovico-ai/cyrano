package urlrewrite

import "strings"

// Embedder policies a document can set (COEP; Document-Isolation-Policy's
// isolate-and-require-corp / isolate-and-credentialless are the same).
const (
	EmbedderNone           = ""
	EmbedderRequireCorp    = "require-corp"
	EmbedderCredentialless = "credentialless"
)

// CORPBlocks is spec/Corp.agda corpBlocks: a no-cors request's response is
// blocked by its Cross-Origin-Resource-Policy (has: the header is present)
// or, without one, by the embedder's policy — for a request from origin to
// target (both URLs or origins as text).
func CORPBlocks(header string, has bool, embedder string, credentialed bool, origin, target string) bool {
	o, ores := parseRef(nil, preprocess(origin))
	t, tres := parseRef(nil, preprocess(target))
	if ores != parsedURL || tres != parsedURL {
		return false
	}
	policy := ""
	if has {
		switch strings.Trim(header, " \\t") {
		case "same-origin", "same-site", "cross-origin":
			policy = strings.Trim(header, " \\t")
		}
	}
	if policy == "" {
		switch embedder {
		case EmbedderRequireCorp:
			policy = "same-origin"
		case EmbedderCredentialless:
			if credentialed {
				policy = "same-origin"
			}
		}
	}
	switch policy {
	case "same-origin":
		return !sameOriginURL(o, t)
	case "same-site":
		oSite, tSite := registrable(hostOf(o)), registrable(hostOf(t))
		same := oSite != "" && tSite != "" && oSite == tSite || oSite == "" && tSite == "" && hostOf(o) == hostOf(t)
		return !(same && (o.scheme != "https" || t.scheme == "https"))
	}
	return false
}

// EmbedderOf is a document's embedder policy from its COEP and
// Document-Isolation-Policy headers (their first token).
func EmbedderOf(coep, dip string) string {
	tok := func(v string) string {
		v = strings.TrimSpace(v)
		if i := strings.IndexAny(v, ";, \\t"); i >= 0 {
			v = v[:i]
		}
		return v
	}
	switch tok(coep) {
	case "require-corp":
		return EmbedderRequireCorp
	case "credentialless":
		return EmbedderCredentialless
	}
	switch tok(dip) {
	case "isolate-and-require-corp":
		return EmbedderRequireCorp
	case "isolate-and-credentialless":
		return EmbedderCredentialless
	}
	return EmbedderNone
}
