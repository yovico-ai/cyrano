// Package rewritecache keeps rewritten scripts and stylesheets, by what
// they were rewritten from.
//
// Rewriting a script is a pure function of its bytes and a few facts of
// the proxy (the kind of script, the URL it resolves against, the proxy's
// origin, the rewriter's version): every user who loads a bundle had it
// rewritten again, and compressed again (a 5 MB bundle: ~80 ms of the
// recognizer, more of brotli). The cache's key is a hash of all of them,
// the origin's bytes included, so an entry is only ever found by someone
// who has the very bytes it was made from — nothing of one session reaches
// another (the isolation requirement: no per-user input goes in; a caller
// may cache only rewrites that take none). Documents are never cached
// (their config carries the session's cookies).
package rewritecache

import (
	"container/list"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"strconv"
	"sync"
)

func sharedBytes() int {
	mb := 256
	if v, err := strconv.Atoi(os.Getenv("CYRANO_REWRITE_CACHE_MB")); err == nil && v >= 0 {
		mb = v
	}
	return mb << 20
}

// Version names the rewriting: set at startup from what the output
// depends on (the runtime bundle's name, the binary's hash). An entry of
// another version is not found.
var Version = "dev"

// Shared is the server's cache (CYRANO_REWRITE_CACHE_MB, default 256;
// 0 keeps nothing).
var Shared = New(sharedBytes())

// Key is the cache key of src rewritten as kind with ctx (the URL it
// resolves against, the proxy's origin, … — every other input).
func Key(kind, ctx string, src []byte) string {
	h := sha256.New()
	for _, part := range []string{Version, kind, ctx} {
		h.Write([]byte(part))
		h.Write([]byte{0})
	}
	h.Write(src)
	return hex.EncodeToString(h.Sum(nil))
}

// Cache holds rewritten bodies, and their compressed forms, by Key: the
// least recently used go first once it holds more than its byte budget.
type Cache struct {
	mu    sync.Mutex
	max   int
	size  int
	order *list.List // of *entry, most recent first
	byKey map[string]*list.Element
}

type entry struct {
	key  string
	body []byte
	enc  map[string][]byte // coding → encoded body
	size int
}

// New makes a cache of at most maxBytes (0: nothing is kept).
func New(maxBytes int) *Cache {
	return &Cache{max: maxBytes, order: list.New(), byKey: map[string]*list.Element{}}
}

// Get is the rewritten body under key.
func (c *Cache) Get(key string) ([]byte, bool) {
	if c == nil {
		return nil, false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	el, ok := c.byKey[key]
	if !ok {
		return nil, false
	}
	c.order.MoveToFront(el)
	return el.Value.(*entry).body, true
}

// Put keeps body under key.
func (c *Cache) Put(key string, body []byte) {
	if c == nil || len(body) > c.max {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if el, ok := c.byKey[key]; ok {
		c.order.MoveToFront(el)
		return
	}
	e := &entry{key: key, body: body, size: len(body) + len(key)}
	c.byKey[key] = c.order.PushFront(e)
	c.size += e.size
	c.evict()
}

// Encoded is the body under key in coding, when kept.
func (c *Cache) Encoded(key, coding string) ([]byte, bool) {
	if c == nil {
		return nil, false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	el, ok := c.byKey[key]
	if !ok {
		return nil, false
	}
	b, ok := el.Value.(*entry).enc[coding]
	if ok {
		c.order.MoveToFront(el)
	}
	return b, ok
}

// PutEncoded keeps the body under key in coding too (the body itself
// must be kept already).
func (c *Cache) PutEncoded(key, coding string, b []byte) {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	el, ok := c.byKey[key]
	if !ok {
		return
	}
	e := el.Value.(*entry)
	if e.enc == nil {
		e.enc = map[string][]byte{}
	}
	if old, had := e.enc[coding]; had {
		e.size -= len(old)
		c.size -= len(old)
	}
	e.enc[coding] = b
	e.size += len(b)
	c.size += len(b)
	c.evict()
}

func (c *Cache) evict() {
	for c.size > c.max && c.order.Len() > 0 {
		el := c.order.Back()
		e := el.Value.(*entry)
		c.order.Remove(el)
		delete(c.byKey, e.key)
		c.size -= e.size
	}
}

// Len is the number of bodies kept.
func (c *Cache) Len() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.order.Len()
}
