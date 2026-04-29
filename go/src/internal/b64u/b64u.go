// Package b64u implements URL-safe base64 (RFC 4648 §5) without padding.
// Wire-compatible with the TS client so the URL-containment scheme stays
// consistent across runtimes.
package b64u

import (
	"encoding/base64"
)

// Encode returns the URL-safe base64 of s with no padding.
func Encode(s string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(s))
}

// Decode is the inverse of Encode. It accepts both padded and unpadded input.
func Decode(s string) (string, error) {
	// RawURLEncoding rejects any '=' padding; trim it first so we accept both forms.
	for len(s) > 0 && s[len(s)-1] == '=' {
		s = s[:len(s)-1]
	}
	out, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return "", err
	}
	return string(out), nil
}
