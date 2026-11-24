package urlrewrite

import (
	"net/url"
	"strings"
)

// MixedVerdict is what the proxy does with a request as Chromium's mixed
// content checks would have (spec/MixedContent.agda).
type MixedVerdict int

const (
	MixedAllowed MixedVerdict = iota
	MixedUpgraded
	MixedBlocked
)

func (v MixedVerdict) String() string { return [...]string{"allow", "upgrade", "block"}[v] }

// MixedContent is spec mixed: ctx the requesting document's original URL
// (nil: none known), target the request's, dest its Sec-Fetch-Dest (has:
// sent), imageSet its URL's srcset mark. An https context's request for a
// URL that is not a priori authenticated is upgraded (image, audio, video;
// not an image a srcset offered) or blocked; a top-level navigation is not
// mixed content.
func MixedContent(ctx, target *url.URL, dest string, has, imageSet bool) MixedVerdict {
	if ctx == nil {
		return MixedAllowed
	}
	if s := strings.ToLower(ctx.Scheme); s != "https" && s != "wss" || Trustworthy(target) {
		return MixedAllowed
	}
	if !has {
		return MixedAllowed
	}
	switch strings.ToLower(dest) {
	case "document":
		return MixedAllowed
	case "image":
		if imageSet {
			return MixedBlocked
		}
		return MixedUpgraded
	case "audio", "video":
		return MixedUpgraded
	}
	return MixedBlocked
}

// UIRUpgrades: a document that declared upgrade-insecure-requests has this
// request upgraded to https / wss before the mixed-content check (spec
// MixedContent.uirUpgrades): an http: or ws: target, a top-level
// navigation only to the document's own origin.
func UIRUpgrades(ctx, target *url.URL, dest string, has bool) bool {
	if s := strings.ToLower(target.Scheme); s != "http" && s != "ws" {
		return false
	}
	if !has || !strings.EqualFold(dest, "document") {
		return true
	}
	if ctx == nil {
		return false
	}
	// (parsed as the spec parses them: a default port is no port)
	c, cres := parseRef(nil, preprocess(ctx.String()))
	t, tres := parseRef(nil, preprocess(target.String()))
	return cres == parsedURL && tres == parsedURL && sameOriginURL(c, t)
}
