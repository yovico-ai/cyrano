package htmlrewrite

// A document rewritten as it arrives. The rewriter is a token stream: what
// it has rewritten goes out when reading the next input would wait (the
// origin flushed a part and is still working on the rest: an SSR page's
// head before its body) and in bounded pieces, so the browser parses the
// document — and fetches what it names — as directly, instead of after
// the origin's last byte (bbc.com's first byte came 1.2 s later proxied:
// the proxy read and rewrote the whole document first). The output is the
// same bytes whatever the input's pieces: only when they are written out
// changes.

import (
	"io"
	"sync"
	"time"
)

// Streaming says how a streamed rewrite writes its output out.
type Streaming struct {
	// Stall: how long a read of the input may wait before what is rewritten
	// so far is written out.
	Stall time.Duration
	// Chunk: the most rewritten bytes held before they are written out.
	Chunk int
	// Flush, if set, is called after each write-out (the writer's own
	// buffers: a compressor's).
	Flush func() error
}

// stallReader reads r; when a read waits longer than stall, out runs (in
// another goroutine, while the reader's owner waits in Read: it touches
// nothing the owner uses outside Read).
type stallReader struct {
	r     io.Reader
	stall time.Duration
	out   func()

	mu     sync.Mutex
	inRead bool
}

func (s *stallReader) Read(p []byte) (int, error) {
	s.mu.Lock()
	s.inRead = true
	s.mu.Unlock()
	t := time.AfterFunc(s.stall, func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.inRead {
			s.out()
		}
	})
	n, err := s.r.Read(p)
	t.Stop()
	s.mu.Lock() // waits for a write-out under way
	s.inRead = false
	s.mu.Unlock()
	return n, err
}
