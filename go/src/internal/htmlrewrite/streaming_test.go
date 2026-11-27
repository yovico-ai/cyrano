package htmlrewrite

// A streamed rewrite (streaming.go): the same bytes whatever the input's
// pieces, and what is rewritten goes out when the input stalls.

import (
	"bytes"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/yovico/cyrano/internal/jsrewrite"
	"pgregory.net/rapid"
)

// streamDocs are documents with every kind of element the rewriter holds
// or rewrites as a whole (a script's, a style's, a rule set's, an import
// map's text; a <base>; the originals attribute; the bootstrap's place).
var streamDocs = []string{
	`<!doctype html><html><head><meta charset=utf-8><title>t</title>` +
		`<link rel=stylesheet href="/a.css"><script src="/b.js"></script>` +
		`<script>var u = location.href; window.top.x = 1;</script>` +
		`<style>body{background:url(/i.png)}</style>` +
		`<script type=importmap>{"imports":{"x":"/x.js"}}</script>` +
		`<script type=speculationrules>{"prefetch":[{"source":"list","urls":["/n"]}]}</script>` +
		`<base href="/sub/"></head><body><a href="p">p</a><img srcset="a.png 1x, b.png 2x">` +
		`<iframe srcdoc="<a href=/q>q</a>"></iframe><div onclick="location='/z'">z</div>` +
		`<svg><style>a{fill:url(#g)}</style><use href="#u"/></svg><noscript><img src=/ns.png></noscript>` +
		`<template><img src=/t.png></template>&amp; &lt;text&gt;</body></html>`,
	`<div>a fragment-like ad frame <script>document.write('<img src="/w.png">')</script></div>`,
	`<html><body>` + strings.Repeat(`<p><a href="/l">link</a> <img src="/i.png"></p>`, 3000) + `</body></html>`,
}

func streamCfg(t testing.TB) Config {
	cfg := Config{
		BaseURL:         mustURL(t.(interface{ Helper() }).(*testing.T), "https://example.com/dir/page"),
		Proxy:           devProxy,
		RewriterJSPath:  "/rewriter.js",
		InjectBootstrap: true,
	}
	cfg.RewriteInlineJS = func(src []byte) []byte { return jsrewrite.Rewrite(src, jsrewrite.DefaultOptions()) }
	cfg.RewriteInlineCSS = func(src []byte) []byte { return []byte(strings.ReplaceAll(string(src), "url(/", "url(/cyrano/https/example.com/")) }
	return cfg
}

// pieces reads src in the given piece sizes (cycling), one Read each.
type pieces struct {
	src   []byte
	sizes []int
	i     int
}

func (p *pieces) Read(b []byte) (int, error) {
	if len(p.src) == 0 {
		return 0, io.EOF
	}
	n := p.sizes[p.i%len(p.sizes)]
	p.i++
	if n > len(p.src) {
		n = len(p.src)
	}
	if n > len(b) {
		n = len(b)
	}
	copy(b, p.src[:n])
	p.src = p.src[n:]
	return n, nil
}

func rewriteWith(t *testing.T, r io.Reader, cfg Config) []byte {
	t.Helper()
	var out bytes.Buffer
	if err := Rewrite(&out, r, cfg); err != nil {
		t.Fatalf("Rewrite: %v", err)
	}
	return out.Bytes()
}

// The same bytes, whole or in any pieces, streamed or not.
func TestStreaming_SameBytesWhateverThePieces(t *testing.T) {
	for i, doc := range streamDocs {
		want := rewriteWith(t, strings.NewReader(doc), streamCfg(t))
		for _, sizes := range [][]int{{1}, {2, 7, 3}, {4096}, {13, 1, 500}} {
			cfg := streamCfg(t)
			cfg.Stream = &Streaming{Stall: time.Microsecond, Chunk: 100}
			if got := rewriteWith(t, &pieces{src: []byte(doc), sizes: sizes}, cfg); !bytes.Equal(got, want) {
				t.Fatalf("doc %d in pieces %v: the output differs from the whole document's", i, sizes)
			}
		}
	}
	rapid.Check(t, func(rt *rapid.T) {
		doc := drawMarkup(rt)
		sizes := rapid.SliceOfN(rapid.IntRange(1, 9), 1, 6).Draw(rt, "sizes")
		var whole, streamed bytes.Buffer
		cfg := streamCfg(t)
		if err := Rewrite(&whole, strings.NewReader(doc), cfg); err != nil {
			rt.Fatalf("Rewrite: %v", err)
		}
		cfg.Stream = &Streaming{Stall: time.Microsecond, Chunk: rapid.IntRange(1, 64).Draw(rt, "chunk")}
		if err := Rewrite(&streamed, &pieces{src: []byte(doc), sizes: sizes}, cfg); err != nil {
			rt.Fatalf("Rewrite: %v", err)
		}
		if !bytes.Equal(whole.Bytes(), streamed.Bytes()) {
			rt.Fatalf("%q in pieces %v:\nwhole    %q\nstreamed %q", doc, sizes, whole.String(), streamed.String())
		}
	})
}

// gate delivers its head, then waits until released for the rest.
type gate struct {
	head, rest []byte
	release    chan struct{}
	sent       bool
}

func (g *gate) Read(b []byte) (int, error) {
	if len(g.head) > 0 {
		n := copy(b, g.head)
		g.head = g.head[n:]
		return n, nil
	}
	if !g.sent {
		<-g.release
		g.sent = true
	}
	if len(g.rest) == 0 {
		return 0, io.EOF
	}
	n := copy(b, g.rest)
	g.rest = g.rest[n:]
	return n, nil
}

type syncBuf struct {
	mu      sync.Mutex
	b       bytes.Buffer
	flushes int
}

func (s *syncBuf) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuf) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

// The origin sends the head and works on the body: the rewritten head —
// the bootstrap, the stylesheet's proxified URL — goes out, and is pushed
// on, before the body comes.
func TestStreaming_HeadGoesOutWhileTheBodyIsAwaited(t *testing.T) {
	g := &gate{
		head:    []byte(`<!doctype html><html><head><link rel=stylesheet href="/a.css"></head>`),
		rest:    []byte(`<body><img src="/b.png"></body></html>`),
		release: make(chan struct{}),
	}
	out := &syncBuf{}
	cfg := streamCfg(t)
	flushed := make(chan struct{}, 16)
	cfg.Stream = &Streaming{Stall: 5 * time.Millisecond, Chunk: 32 << 10, Flush: func() error { flushed <- struct{}{}; return nil }}
	done := make(chan error, 1)
	go func() { done <- Rewrite(out, g, cfg) }()
	select {
	case <-flushed:
	case <-time.After(2 * time.Second):
		t.Fatal("nothing was written out while the body was awaited")
	}
	head := out.String()
	if !strings.Contains(head, `/cyrano/https!css/example.com/a.css`) || !strings.Contains(head, "/rewriter.js") {
		t.Fatalf("written out while waiting: %q; want the rewritten head and the bootstrap", head)
	}
	if strings.Contains(head, "b.png") {
		t.Fatalf("the body was written before it came: %q", head)
	}
	close(g.release)
	if err := <-done; err != nil {
		t.Fatalf("Rewrite: %v", err)
	}
	want := rewriteWith(t, strings.NewReader(`<!doctype html><html><head><link rel=stylesheet href="/a.css"></head><body><img src="/b.png"></body></html>`), streamCfg(t))
	if out.String() != string(want) {
		t.Fatalf("streamed %q\nwhole    %q", out.String(), want)
	}
}
