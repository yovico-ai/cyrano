package upstream

// HTTP/3 to the origins a direct Chrome speaks it to (spec/Alpn.agda;
// alpn.go UseH3): the host's DNS HTTPS record lists h3, or the origin's own
// Alt-Svc offered it. Per (session, origin), as the HTTP/2 clients are: one
// session's Alt-Svc or broken marks never steer another's.
//
// The connection is raced, never the request: the QUIC handshake is made
// first (a full one, no 0-RTT: a request in early data would have left
// before we know the connection works); only a connection that could not be
// made falls back to TCP — the request not sent — and marks the origin
// broken for five minutes, as Chrome does. Any later failure is the
// request's own and is returned as such (a POST is never sent twice).
//
// Gap: the QUIC ClientHello is quic-go's, not Chrome's (the TLS/H2 path
// impersonates Chrome; quic-go-utls takes no ClientHelloID). Cloudflare's
// zones that challenge HTTP/2 admit it (codepen, science.org, findagrave,
// tenforums: 403 over h2, 200 over h3).

import (
	"context"
	"crypto/x509"
	"errors"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	fhttp "github.com/bogdanfinn/fhttp"
	quic "github.com/bogdanfinn/quic-go-utls"
	"github.com/bogdanfinn/quic-go-utls/http3"
	"github.com/bogdanfinn/tls-client/profiles"
	tls "github.com/bogdanfinn/utls"
	"github.com/yovico/cyrano/internal/dnscache"
)

// quicHandshakeTimeout bounds the QUIC handshake before the request goes
// over TCP instead (Chrome races TCP after a short delay; a handshake to a
// CDN takes tens of milliseconds).
const quicHandshakeTimeout = 2 * time.Second

// errQUICDial wraps a QUIC connection that could not be made: nothing of
// the request was sent.
type errQUICDial struct{ err error }

func (e errQUICDial) Error() string { return "quic dial: " + e.err.Error() }
func (e errQUICDial) Unwrap() error { return e.err }

type h3Origin struct {
	offers      []AltSvcOffer
	expires     []time.Time
	brokenUntil time.Time
}

type h3State struct {
	mu      sync.Mutex
	origins map[string]*h3Origin // session \x00 host:port
	https   *dnscache.HTTPSLookup
}

func newH3State() *h3State {
	return &h3State{origins: map[string]*h3Origin{}, https: dnscache.NewHTTPSLookup()}
}

func originKey(session, host string, port int) string {
	return session + "\x00" + strings.ToLower(host) + ":" + strconv.Itoa(port)
}

// liveOffers drops the expired ones.
func (o *h3Origin) liveOffers(now time.Time) []AltSvcOffer {
	var out []AltSvcOffer
	for i, of := range o.offers {
		if now.Before(o.expires[i]) {
			out = append(out, of)
		}
	}
	return out
}

// want says whether this request goes over HTTP/3.
func (s *h3State) want(ctx context.Context, session, scheme, host string, port int) bool {
	if scheme != "https" {
		return false
	}
	now := time.Now()
	s.mu.Lock()
	o := s.origins[originKey(session, host, port)]
	var offers []AltSvcOffer
	broken := false
	if o != nil {
		offers = o.liveOffers(now)
		broken = now.Before(o.brokenUntil)
	}
	s.mu.Unlock()
	if broken {
		return false
	}
	if h3Here(host, port, offers) {
		return true
	}
	var rr []string
	if port == 443 { // the record is for the name's default port
		if alpn, found := s.https.Alpn(ctx, host); found {
			rr = alpn
		}
	}
	return UseH3(scheme, host, port, rr, offers, broken)
}

// noteAltSvc records a response's Alt-Svc: the origin's whole list.
func (s *h3State) noteAltSvc(session, host string, port int, values []string) {
	if len(values) == 0 {
		return
	}
	clear, offers := ReadAltSvc(strings.Join(values, ","))
	now := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	k := originKey(session, host, port)
	o := s.origins[k]
	if o == nil {
		o = &h3Origin{}
		s.origins[k] = o
	}
	o.offers, o.expires = nil, nil
	if clear {
		return
	}
	for _, of := range offers {
		o.offers = append(o.offers, of)
		o.expires = append(o.expires, now.Add(time.Duration(of.MaxAge)*time.Second))
	}
}

func (s *h3State) markBroken(session, host string, port int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	k := originKey(session, host, port)
	o := s.origins[k]
	if o == nil {
		o = &h3Origin{}
		s.origins[k] = o
	}
	o.brokenUntil = time.Now().Add(brokenForSeconds * time.Second)
}

// dropSessionsExcept forgets the origins of sessions with no clients left
// (as their AIA state).
func (s *h3State) dropSessionsExcept(live map[string]bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for k := range s.origins {
		if i := strings.IndexByte(k, 0); i >= 0 && !live[k[:i]] {
			delete(s.origins, k)
		}
	}
}

// h3Transport is an HTTP/3 transport whose connections are dialed ahead
// of the requests that use them, so a request can wait a short while for
// one and go over TCP instead — never both.
type h3Transport struct {
	t      *http3.Transport
	mu     sync.Mutex
	dials  map[string]*h3Dial // host:port
	onFail func(addr string)  // a connection that could not be made
}

type h3Dial struct {
	done  chan struct{}
	conn  *quic.Conn
	err   error
	taken bool // handed to the transport, which pools it
}

func (d *h3Dial) live() bool {
	select {
	case <-d.done:
		return d.err == nil && d.conn.Context().Err() == nil
	default:
		return false
	}
}

// quicRace is how long a request waits for its QUIC connection before it
// goes over TCP (Chrome delays its TCP job by about as much when QUIC is
// in play).
const quicRace = 300 * time.Millisecond

// ready says whether a request to addr can go over HTTP/3 now: a
// connection is up, or comes up within wait. A dial is started when there
// is none (and goes on after the wait: a later request may use it).
func (h *h3Transport) ready(addr string, wait time.Duration) bool {
	h.mu.Lock()
	d := h.dials[addr]
	if d != nil && d.taken && d.live() {
		h.mu.Unlock()
		return true // the transport holds a live connection
	}
	if d == nil || isDone(d.done) && !d.live() {
		d = &h3Dial{done: make(chan struct{})}
		h.dials[addr] = d
		go h.dial(addr, d)
	}
	h.mu.Unlock()
	t := time.NewTimer(wait)
	defer t.Stop()
	select {
	case <-d.done:
		return d.err == nil
	case <-t.C:
		return false
	}
}

func isDone(c chan struct{}) bool {
	select {
	case <-c:
		return true
	default:
		return false
	}
}

func (h *h3Transport) dial(addr string, d *h3Dial) {
	host, _, _ := net.SplitHostPort(addr)
	cfg := h.t.TLSClientConfig.Clone()
	cfg.ServerName = host
	cfg.NextProtos = []string{http3.NextProtoH3}
	d.conn, d.err = dialQUIC(context.Background(), addr, cfg, h.t.QUICConfig)
	close(d.done)
	if d.err != nil && h.onFail != nil {
		h.onFail(addr)
	}
}

// dialQUIC makes a QUIC connection with a full handshake through the
// proxy's resolver.
func dialQUIC(ctx context.Context, addr string, tlsCfg *tls.Config, cfg *quic.Config) (*quic.Conn, error) {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, errQUICDial{err}
	}
	ips, err := dnscache.Default.LookupIPAddr(ctx, host)
	if err != nil || len(ips) == 0 {
		if err == nil {
			err = errors.New("no address")
		}
		return nil, errQUICDial{err}
	}
	// The connection lives on after the request (pooled): quic-go ties it
	// to the dial's context, so that must outlive the request; the
	// handshake is bounded by HandshakeIdleTimeout and this deadline.
	dctx := context.WithoutCancel(ctx)
	deadline := time.Now().Add(quicHandshakeTimeout)
	var last error
	for _, ip := range ips {
		if time.Now().After(deadline) {
			break
		}
		c, err := quic.DialAddr(dctx, net.JoinHostPort(ip.IP.String(), port), tlsCfg, cfg)
		if err == nil {
			return c, nil
		}
		last = err
	}
	if last == nil {
		last = errors.New("handshake timed out")
	}
	return nil, errQUICDial{last}
}

// newH3Transport builds an HTTP/3 transport from the profile's HTTP/3
// settings, as tls-client builds its own. Its connections are the ones
// ready() dialed; one that died is dialed again here (a failure then is
// errQUICDial: the request was not sent).
// HTTP/3 SETTINGS identifiers (RFC 9204 §5).
const (
	qpackMaxTableCapacity = 0x1
	qpackBlockedStreams   = 0x7
)

func newH3Transport(profile profiles.ClientProfile, roots *x509.CertPool, skipVerify bool) *h3Transport {
	t := &http3.Transport{
		TLSClientConfig: &tls.Config{
			RootCAs:            roots,
			InsecureSkipVerify: skipVerify,
			OmitEmptyPsk:       true,
			ClientSessionCache: tls.NewLRUClientSessionCache(32),
		},
		EnableDatagrams:    true, // Chrome sends H3_DATAGRAM
		DisableCompression: true, // cyrano decodes bodies itself
		PseudoHeaderOrder:  profile.GetHttp3PseudoHeaderOrder(),
		SendGreaseFrames:   profile.GetHttp3SendGreaseFrames(),
		PriorityParam:      profile.GetHttp3PriorityParam(),
		QUICConfig:         &quic.Config{EnableDatagrams: true, HandshakeIdleTimeout: quicHandshakeTimeout},
	}
	if s := profile.GetHttp3Settings(); len(s) > 0 {
		t.AdditionalSettings = make(map[uint64]uint64, len(s))
		for k, v := range s {
			t.AdditionalSettings[k] = v
		}
		// The QPACK decoder has no dynamic table: offered one (Chrome's
		// 64 KiB), servers encode against it and the response cannot be
		// read. Chrome's settings in Chrome's order, these two at 0.
		for _, k := range []uint64{qpackMaxTableCapacity, qpackBlockedStreams} {
			if _, ok := t.AdditionalSettings[k]; ok {
				t.AdditionalSettings[k] = 0
			}
		}
		t.AdditionalSettingsOrder = profile.GetHttp3SettingsOrder()
	}
	h := &h3Transport{t: t, dials: map[string]*h3Dial{}}
	t.Dial = func(ctx context.Context, addr string, tlsCfg *tls.Config, cfg *quic.Config) (*quic.Conn, error) {
		h.mu.Lock()
		d := h.dials[addr]
		if d != nil && !d.taken && d.live() {
			d.taken = true
			h.mu.Unlock()
			return d.conn, nil
		}
		h.mu.Unlock()
		return dialQUIC(ctx, addr, tlsCfg, cfg)
	}
	return h
}

func (h *h3Transport) Close() error { return h.t.Close() }

// isQUICDial says whether err is a connection that could not be made.
func isQUICDial(err error) bool {
	var d errQUICDial
	return errors.As(err, &d)
}

// h3For is the HTTP/3 transport beside a client (made on first use).
func (rt *RoundTripper) h3For(key string, profile profiles.ClientProfile) *h3Transport {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	e := rt.clients[key]
	if e == nil {
		return nil
	}
	if e.h3 == nil {
		e.h3 = newH3Transport(profile, rt.aiaLocked(sessionOfKey(key)).pool(), rt.skipVerify)
		session := sessionOfKey(key)
		e.h3.onFail = func(addr string) {
			host, p, _ := net.SplitHostPort(addr)
			port, _ := strconv.Atoi(p)
			rt.h3.markBroken(session, host, port)
		}
	}
	return e.h3
}

// h3RoundTrip sends a copy of fReq over HTTP/3: the transport changes the
// request it is given (sent as given, every proxied navigation came back
// H3_NO_ERROR / H3_REQUEST_CANCELLED), and the TCP fallback needs it intact.
func h3RoundTrip(h *h3Transport, fReq *fhttp.Request) (*fhttp.Response, error) {
	return h.t.RoundTrip(fReq.Clone(fReq.Context()))
}
