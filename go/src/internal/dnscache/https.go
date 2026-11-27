package dnscache

// HTTPS resource records (RFC 9460), as Chrome reads them to choose
// HTTP/3 on first contact (spec/Alpn.agda; internal/upstream). Go's
// resolver does not query them, so this asks the system's nameservers
// itself: a type-65 query for the name, the answer's HTTPS records (a CNAME
// chain followed by the recursive resolver) in service mode — priority
// above 0 — and their alpn ids. Answers, an absent record included, are
// cached for a minute (the host cache's lifetime) and joined; a lookup gives
// up after HTTPSWait, as "no record", so a slow resolver never holds a page.

import (
	"bufio"
	"context"
	"net"
	"os"
	"strings"
	"sync"
	"time"

	"golang.org/x/net/dns/dnsmessage"
)

// HTTPSWait bounds how long a connection waits for the HTTPS record.
const HTTPSWait = 500 * time.Millisecond

const httpsTTL = time.Minute

type httpsEntry struct {
	alpn  []string
	found bool
	at    time.Time
	done  chan struct{}
}

// HTTPSLookup caches HTTPS-record lookups. The zero value is not usable;
// use NewHTTPSLookup.
type HTTPSLookup struct {
	mu      sync.Mutex
	entries map[string]*httpsEntry
	query   func(ctx context.Context, host string) ([]string, bool)
}

// NewHTTPSLookup asks the nameservers of /etc/resolv.conf.
func NewHTTPSLookup() *HTTPSLookup {
	return &HTTPSLookup{entries: map[string]*httpsEntry{}, query: queryHTTPS}
}

// Alpn gives host's HTTPS record alpn ids, and whether it has a record in
// service mode. Joined with a lookup in flight; cached.
func (l *HTTPSLookup) Alpn(ctx context.Context, host string) ([]string, bool) {
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	if net.ParseIP(host) != nil || host == "" {
		return nil, false
	}
	l.mu.Lock()
	e, ok := l.entries[host]
	if ok && e.done == nil && time.Since(e.at) > httpsTTL {
		ok = false
	}
	if !ok {
		e = &httpsEntry{done: make(chan struct{})}
		l.entries[host] = e
		go func(e *httpsEntry) {
			qctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			alpn, found := l.query(qctx, host)
			l.mu.Lock()
			e.alpn, e.found, e.at = alpn, found, time.Now()
			close(e.done)
			e.done = nil
			l.mu.Unlock()
		}(e)
	}
	done := e.done
	l.mu.Unlock()
	if done != nil {
		t := time.NewTimer(HTTPSWait)
		defer t.Stop()
		select {
		case <-done:
		case <-t.C:
			return nil, false
		case <-ctx.Done():
			return nil, false
		}
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	return e.alpn, e.found
}

func nameservers() []string {
	f, err := os.Open("/etc/resolv.conf")
	if err != nil {
		return []string{"127.0.0.53:53"}
	}
	defer f.Close()
	var out []string
	s := bufio.NewScanner(f)
	for s.Scan() {
		fs := strings.Fields(s.Text())
		if len(fs) >= 2 && fs[0] == "nameserver" {
			out = append(out, net.JoinHostPort(fs[1], "53"))
		}
	}
	if len(out) == 0 {
		out = []string{"127.0.0.53:53"}
	}
	return out
}

func queryHTTPS(ctx context.Context, host string) ([]string, bool) {
	name, err := dnsmessage.NewName(host + ".")
	if err != nil {
		return nil, false
	}
	b := dnsmessage.NewBuilder(nil, dnsmessage.Header{ID: uint16(time.Now().UnixNano()), RecursionDesired: true})
	b.EnableCompression()
	if b.StartQuestions() != nil || b.Question(dnsmessage.Question{Name: name, Type: dnsmessage.TypeHTTPS, Class: dnsmessage.ClassINET}) != nil {
		return nil, false
	}
	if b.StartAdditionals() != nil {
		return nil, false
	}
	var opt dnsmessage.ResourceHeader
	if opt.SetEDNS0(4096, dnsmessage.RCodeSuccess, false) != nil || b.OPTResource(opt, dnsmessage.OPTResource{}) != nil {
		return nil, false
	}
	msg, err := b.Finish()
	if err != nil {
		return nil, false
	}
	for _, ns := range nameservers() {
		if alpn, found, ok := exchange(ctx, ns, msg); ok {
			return alpn, found
		}
	}
	return nil, false
}

// exchange sends one query; ok false when the server gave no usable answer.
func exchange(ctx context.Context, ns string, msg []byte) (alpn []string, found, ok bool) {
	var d net.Dialer
	c, err := d.DialContext(ctx, "udp", ns)
	if err != nil {
		return nil, false, false
	}
	defer c.Close()
	if dl, has := ctx.Deadline(); has {
		c.SetDeadline(dl)
	}
	if _, err := c.Write(msg); err != nil {
		return nil, false, false
	}
	buf := make([]byte, 4096)
	n, err := c.Read(buf)
	if err != nil {
		return nil, false, false
	}
	alpn, found, err = parseHTTPS(buf[:n], msg)
	return alpn, found, err == nil
}

type errBadReply struct{}

func (errBadReply) Error() string { return "dnscache: bad HTTPS reply" }

// parseHTTPS reads a reply: the alpn ids of its HTTPS records in service
// mode, and whether there was one.
func parseHTTPS(reply, query []byte) ([]string, bool, error) {
	var p dnsmessage.Parser
	h, err := p.Start(reply)
	if err != nil || !h.Response || len(query) < 2 || h.ID != uint16(query[0])<<8|uint16(query[1]) {
		return nil, false, errBadReply{}
	}
	if h.RCode != dnsmessage.RCodeSuccess && h.RCode != dnsmessage.RCodeNameError {
		return nil, false, errBadReply{}
	}
	if err := p.SkipAllQuestions(); err != nil {
		return nil, false, errBadReply{}
	}
	var alpn []string
	found := false
	for {
		rh, err := p.AnswerHeader()
		if err == dnsmessage.ErrSectionDone {
			break
		}
		if err != nil {
			return nil, false, errBadReply{}
		}
		if rh.Type != dnsmessage.TypeHTTPS {
			if p.SkipAnswer() != nil {
				return nil, false, errBadReply{}
			}
			continue
		}
		r, err := p.HTTPSResource()
		if err != nil {
			return nil, false, errBadReply{}
		}
		if r.Priority == 0 { // alias mode
			continue
		}
		found = true
		if v, ok := r.GetParam(dnsmessage.SVCParamALPN); ok {
			alpn = append(alpn, alpnIDs(v)...)
		}
	}
	return alpn, found, nil
}

// alpnIDs reads an alpn value: length-prefixed ids.
func alpnIDs(v []byte) []string {
	var out []string
	for len(v) > 0 {
		n := int(v[0])
		if 1+n > len(v) {
			break
		}
		out = append(out, string(v[1:1+n]))
		v = v[1+n:]
	}
	return out
}
