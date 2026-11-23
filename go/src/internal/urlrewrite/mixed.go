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
