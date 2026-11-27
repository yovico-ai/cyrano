package rewritecache

import (
	"bytes"
	"testing"
)

// An entry is found only by the same bytes, kind, context and version.
func TestKeyNamesEveryInput(t *testing.T) {
	base := Key("js", "https://a.example/x.js|https://proxy", []byte("var a=1"))
	for name, k := range map[string]string{
		"bytes":   Key("js", "https://a.example/x.js|https://proxy", []byte("var a=2")),
		"kind":    Key("module", "https://a.example/x.js|https://proxy", []byte("var a=1")),
		"context": Key("js", "https://b.example/x.js|https://proxy", []byte("var a=1")),
	} {
		if k == base {
			t.Fatalf("another %s, the same key", name)
		}
	}
	// No ambiguity between the parts.
	if Key("j", "s", nil) == Key("js", "", nil) {
		t.Fatal("parts run into each other")
	}
	was := Version
	Version = "other"
	defer func() { Version = was }()
	if Key("js", "https://a.example/x.js|https://proxy", []byte("var a=1")) == base {
		t.Fatal("another version, the same key")
	}
}

// The least recently used go first beyond the budget; encoded forms
// count too.
func TestEvictsLeastRecentlyUsed(t *testing.T) {
	c := New(30)
	c.Put("a", bytes.Repeat([]byte("x"), 9)) // 10 with its key
	c.Put("b", bytes.Repeat([]byte("x"), 9))
	c.Put("c", bytes.Repeat([]byte("x"), 9))
	if _, ok := c.Get("a"); !ok { // a is now the most recent
		t.Fatal("a evicted early")
	}
	c.Put("d", bytes.Repeat([]byte("x"), 9))
	if _, ok := c.Get("b"); ok {
		t.Fatal("b, the least recently used, kept")
	}
	if _, ok := c.Get("a"); !ok {
		t.Fatal("a, recently used, evicted")
	}
	c.PutEncoded("a", "br", bytes.Repeat([]byte("y"), 15))
	if b, ok := c.Encoded("a", "br"); !ok || len(b) != 15 {
		t.Fatal("encoded form not kept")
	}
	if c.Len() > 2 {
		t.Fatalf("%d entries over a 30-byte budget", c.Len())
	}
	if New(5).Put("big", []byte("0123456789")); New(5).Len() != 0 {
		t.Fatal("a body over the whole budget kept")
	}
}
