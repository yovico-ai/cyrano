// Package dnscache resolves upstream host names the way a browser's host
// cache does, and dials with what it resolved.
//
// A page full of ads opens connections to a few hundred hosts within a
// second or two. Resolving each dial afresh sends as many lookups to the
// system resolver at once; a lost UDP answer then costs the resolver's
// whole retry timeout (5 s), longer than a header-bidding auction waits, and
// the bid is lost. Chrome keeps a host cache (about a minute), joins
// concurrent lookups of one name and retries quickly; so does this:
//
//   - answers are kept for a minute, failures for a few seconds;
//   - concurrent lookups of one name share one;
//   - a lookup with no answer after a second is raced by a second one;
//   - a lookup belongs to no single request: one request giving up does
//     not cancel it for the others waiting on it.
//
// Dial tries the addresses in order, starting on the other address family
// after 300 ms (as Go's and Chrome's happy eyeballs do).
package dnscache

import (
	"context"
	"errors"
	"net"
	"sync"
	"time"
)

const (
	okTTL       = time.Minute
	failTTL     = 5 * time.Second
	hedgeAfter  = time.Second
	lookupLimit = 10 * time.Second
	fallback    = 300 * time.Millisecond
	maxEntries  = 4096
)

// Resolver is a caching resolver. The zero value is not usable; use New.
type Resolver struct {
	lookup func(ctx context.Context, host string) ([]net.IPAddr, error)
	now    func() time.Time

	mu      sync.Mutex
	entries map[string]*entry
}

type entry struct {
	done    chan struct{} // closed when addrs/err are set
	addrs   []net.IPAddr
	err     error
	expires time.Time
}

// New returns a Resolver using the system resolver.
func New() *Resolver {
	return newWith(net.DefaultResolver.LookupIPAddr)
}

func newWith(lookup func(ctx context.Context, host string) ([]net.IPAddr, error)) *Resolver {
	return &Resolver{lookup: lookup, now: time.Now, entries: make(map[string]*entry)}
}

// Default is the resolver the upstream transports dial with.
var Default = New()

// LookupIPAddr returns host's addresses, from the cache when it has a live
// answer, else from one lookup shared by every caller asking meanwhile.
func (r *Resolver) LookupIPAddr(ctx context.Context, host string) ([]net.IPAddr, error) {
	r.mu.Lock()
	e, ok := r.entries[host]
	if ok {
		select {
		case <-e.done:
			if r.now().After(e.expires) {
				ok = false
			}
		default: // in flight: wait for it
		}
	}
	if !ok {
		if len(r.entries) >= maxEntries {
			r.evictLocked()
		}
		e = &entry{done: make(chan struct{})}
		r.entries[host] = e
		go r.resolve(host, e)
	}
	r.mu.Unlock()
	select {
	case <-e.done:
		return e.addrs, e.err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// resolve fills e: the first answer of one lookup, raced by a second one
// started when the first has not answered after hedgeAfter.
func (r *Resolver) resolve(host string, e *entry) {
	ctx, cancel := context.WithTimeout(context.Background(), lookupLimit)
	defer cancel()
	type result struct {
		addrs []net.IPAddr
		err   error
	}
	results := make(chan result, 2)
	start := func() {
		go func() {
			a, err := r.lookup(ctx, host)
			results <- result{a, err}
		}()
	}
	start()
	pending := 1
	hedge := time.NewTimer(hedgeAfter)
	defer hedge.Stop()
	var last result
	for pending > 0 {
		select {
		case <-hedge.C:
			start()
			pending++
		case res := <-results:
			pending--
			last = res
			if res.err == nil && len(res.addrs) > 0 {
				pending = 0
			}
		}
	}
	if last.err == nil && len(last.addrs) == 0 {
		last.err = &net.DNSError{Err: "no such host", Name: host, IsNotFound: true}
	}
	r.mu.Lock()
	e.addrs, e.err = last.addrs, last.err
	ttl := okTTL
	if last.err != nil {
		ttl = failTTL
	}
	e.expires = r.now().Add(ttl)
	r.mu.Unlock()
	close(e.done)
}

// evictLocked drops expired answers, or any one answer when none has
// expired. Caller holds r.mu.
func (r *Resolver) evictLocked() {
	now := r.now()
	for k, e := range r.entries {
		select {
		case <-e.done:
			if now.After(e.expires) {
				delete(r.entries, k)
			}
		default:
		}
	}
	if len(r.entries) < maxEntries {
		return
	}
	for k, e := range r.entries {
		select {
		case <-e.done:
			delete(r.entries, k)
			return
		default:
		}
	}
}

// Dialer dials TCP with addresses from a Resolver.
type Dialer struct {
	Resolver *Resolver
	Dialer   net.Dialer
}

// DialContext connects to addr ("host:port"). An IP literal is dialed as
// it is; a name is resolved through the cache and its addresses tried in
// order, the other family joining after 300 ms.
func (d *Dialer) DialContext(ctx context.Context, network, addr string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, err
	}
	if net.ParseIP(host) != nil {
		return d.Dialer.DialContext(ctx, network, addr)
	}
	r := d.Resolver
	if r == nil {
		r = Default
	}
	addrs, err := r.LookupIPAddr(ctx, host)
	if err != nil {
		return nil, err
	}
	primary, secondary := split(addrs, network)
	if len(primary) == 0 {
		return nil, &net.DNSError{Err: "no suitable address", Name: host}
	}
	return d.race(ctx, network, port, primary, secondary)
}

// split orders addrs as the first family seen, then the other, keeping
// only those network allows.
func split(addrs []net.IPAddr, network string) (primary, secondary []net.IPAddr) {
	ok := func(a net.IPAddr) bool {
		switch network {
		case "tcp4":
			return a.IP.To4() != nil
		case "tcp6":
			return a.IP.To4() == nil
		}
		return true
	}
	var firstIs4 *bool
	for _, a := range addrs {
		if !ok(a) {
			continue
		}
		is4 := a.IP.To4() != nil
		if firstIs4 == nil {
			firstIs4 = &is4
		}
		if is4 == *firstIs4 {
			primary = append(primary, a)
		} else {
			secondary = append(secondary, a)
		}
	}
	if len(primary) == 0 {
		return secondary, nil
	}
	return primary, secondary
}

func (d *Dialer) serial(ctx context.Context, network, port string, addrs []net.IPAddr) (net.Conn, error) {
	var first error
	for _, a := range addrs {
		c, err := d.Dialer.DialContext(ctx, network, net.JoinHostPort(a.String(), port))
		if err == nil {
			return c, nil
		}
		if first == nil {
			first = err
		}
		if ctx.Err() != nil {
			break
		}
	}
	if first == nil {
		first = errors.New("dnscache: no address to dial")
	}
	return nil, first
}

func (d *Dialer) race(ctx context.Context, network, port string, primary, secondary []net.IPAddr) (net.Conn, error) {
	if len(secondary) == 0 {
		return d.serial(ctx, network, port, primary)
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	type result struct {
		c   net.Conn
		err error
	}
	results := make(chan result, 2)
	go func() { c, err := d.serial(ctx, network, port, primary); results <- result{c, err} }()
	timer := time.NewTimer(fallback)
	defer timer.Stop()
	started, pending := false, 1
	startSecondary := func() {
		if !started {
			started = true
			pending++
			go func() { c, err := d.serial(ctx, network, port, secondary); results <- result{c, err} }()
		}
	}
	var firstErr error
	for pending > 0 {
		select {
		case <-timer.C:
			startSecondary()
		case res := <-results:
			pending--
			if res.err == nil {
				// The other attempt, if any, is cancelled; a connection it
				// still made is closed.
				if pending > 0 {
					go func() {
						if r := <-results; r.c != nil {
							r.c.Close()
						}
					}()
				}
				return res.c, nil
			}
			if firstErr == nil {
				firstErr = res.err
			}
			startSecondary()
		}
	}
	return nil, firstErr
}
