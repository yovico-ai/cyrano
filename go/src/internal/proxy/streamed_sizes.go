package proxy

// A streamed body's sizes (spec/Carry.agda sizesCookie): known only when
// the body has ended, they go to the runtime in the session's next
// response, as a cookie of the channel (the runtime's
// patches/streamed-sizes.ts reads it from the browser's jar). No request
// is made for them: a page's CSP refused the runtime's request (a
// violation event the page saw), a sandboxed frame's failed CORS.

import (
	"strconv"
	"sync"
)

// SizesCookiePrefix names the cookie (spec sizesCookiePrefix).
const SizesCookiePrefix = "__crn~z!"

// sizesPerSession bounds what waits for a session's next response.
const sizesPerSession = 64

var sizesQueue = struct {
	mu sync.Mutex
	m  map[string][]string
}{m: map[string][]string{}}

// SizesCookie is the Set-Cookie for a streamed body's sizes.
func SizesCookie(token string, encoded, decoded int64) string {
	return SizesCookiePrefix + token + "=" + strconv.FormatInt(encoded, 10) + "-" + strconv.FormatInt(decoded, 10) + channelAttrs(InboxLife)
}

// QueueStreamedSizes keeps a streamed body's sizes for the session's next
// response.
func QueueStreamedSizes(session, token string, encoded, decoded int64) {
	if session == "" || token == "" {
		return
	}
	sizesQueue.mu.Lock()
	defer sizesQueue.mu.Unlock()
	q := append(sizesQueue.m[session], SizesCookie(token, encoded, decoded))
	if len(q) > sizesPerSession {
		q = q[len(q)-sizesPerSession:]
	}
	sizesQueue.m[session] = q
}

// takeStreamedSizes is what waits for the session's next response.
func takeStreamedSizes(session string) []string {
	if session == "" {
		return nil
	}
	sizesQueue.mu.Lock()
	defer sizesQueue.mu.Unlock()
	q := sizesQueue.m[session]
	delete(sizesQueue.m, session)
	return q
}
