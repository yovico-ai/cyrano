package dnscache

import (
	"context"
	"errors"
	"net"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func addrs(ips ...string) []net.IPAddr {
	var out []net.IPAddr
	for _, s := range ips {
		out = append(out, net.IPAddr{IP: net.ParseIP(s)})
	}
	return out
}

func TestConcurrentLookupsShareOne(t *testing.T) {
	var calls atomic.Int32
	r := newWith(func(context.Context, string) ([]net.IPAddr, error) {
		calls.Add(1)
		time.Sleep(50 * time.Millisecond)
		return addrs("192.0.2.1"), nil
	})
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if a, err := r.LookupIPAddr(context.Background(), "a.example"); err != nil || len(a) != 1 {
				t.Errorf("%v %v", a, err)
			}
		}()
	}
	wg.Wait()
	if _, err := r.LookupIPAddr(context.Background(), "a.example"); err != nil {
		t.Fatal(err)
	}
	if n := calls.Load(); n != 1 {
		t.Fatalf("%d lookups; want 1 (joined, then cached)", n)
	}
}

func TestExpiredAnswerIsLookedUpAgain(t *testing.T) {
	var calls atomic.Int32
	r := newWith(func(context.Context, string) ([]net.IPAddr, error) {
		calls.Add(1)
		return addrs("192.0.2.1"), nil
	})
	now := time.Now()
	r.now = func() time.Time { return now }
	_, _ = r.LookupIPAddr(context.Background(), "a.example")
	now = now.Add(okTTL + time.Second)
	_, _ = r.LookupIPAddr(context.Background(), "a.example")
	if n := calls.Load(); n != 2 {
		t.Fatalf("%d lookups; want 2", n)
	}
}

// A lost answer: the first lookup hangs; the hedge answers.
func TestSlowLookupIsRaced(t *testing.T) {
	var calls atomic.Int32
	r := newWith(func(ctx context.Context, _ string) ([]net.IPAddr, error) {
		if calls.Add(1) == 1 {
			<-ctx.Done()
			return nil, ctx.Err()
		}
		return addrs("192.0.2.7"), nil
	})
	start := time.Now()
	a, err := r.LookupIPAddr(context.Background(), "slow.example")
	if err != nil || a[0].IP.String() != "192.0.2.7" {
		t.Fatalf("%v %v", a, err)
	}
	if d := time.Since(start); d > hedgeAfter+time.Second {
		t.Fatalf("took %v", d)
	}
}

// One caller giving up leaves the lookup to the others.
func TestCallerCancelDoesNotCancelLookup(t *testing.T) {
	release := make(chan struct{})
	r := newWith(func(context.Context, string) ([]net.IPAddr, error) {
		<-release
		return addrs("192.0.2.1"), nil
	})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error)
	go func() { _, err := r.LookupIPAddr(ctx, "a.example"); done <- err }()
	time.Sleep(10 * time.Millisecond)
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("%v", err)
	}
	close(release)
	if a, err := r.LookupIPAddr(context.Background(), "a.example"); err != nil || len(a) != 1 {
		t.Fatalf("%v %v", a, err)
	}
}

func TestDialUsesCacheAndFallsBack(t *testing.T) {
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			c.Close()
		}
	}()
	_, port, _ := net.SplitHostPort(ln.Addr().String())
	// First address refuses (nothing listens on ::1 at that port, or no IPv6);
	// the IPv4 one answers.
	r := newWith(func(context.Context, string) ([]net.IPAddr, error) { return addrs("::1", "127.0.0.1"), nil })
	d := &Dialer{Resolver: r, Dialer: net.Dialer{Timeout: 2 * time.Second}}
	c, err := d.DialContext(context.Background(), "tcp", net.JoinHostPort("host.example", port))
	if err != nil {
		t.Fatal(err)
	}
	c.Close()
}
