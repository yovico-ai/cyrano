// Package turn is cyrano's WebRTC relay (spec/WebRtc.agda): a TURN server
// every proxied peer connection uses, and only it (the runtime gives the
// native iceTransportPolicy "relay" and these servers in place of the
// page's). Media and data go browser → cyrano → peer: the user's address
// never reaches the peer, nor the page's STUN servers.
//
// Credentials are TURN's long-term ones made from a shared secret (an
// expiry, its HMAC): each document is given its own, short-lived. The relay
// sends to public peers only — never into the server's own networks
// (loopback, private, link-local) but to its own relay address, which two
// peer connections of one browser relay to each other through.
package turn

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log/slog"
	"net"
	"strconv"
	"time"

	pturn "github.com/pion/turn/v4"
)

// Server is a running relay.
type Server struct {
	s      *pturn.Server
	secret string
	ip     net.IP
	port   int
}

// Options configures Start.
type Options struct {
	Port   int    // UDP and TCP; 0: no relay
	IP     string // the relay address peers and the browser reach; required
	Secret string // the credentials' shared secret; random when empty
	Logger *slog.Logger
}

// Start listens on Port (UDP and TCP) and relays from IP.
func Start(o Options) (*Server, error) {
	ip := net.ParseIP(o.IP)
	if ip == nil {
		return nil, fmt.Errorf("turn: relay IP %q", o.IP)
	}
	secret := o.Secret
	if secret == "" {
		b := make([]byte, 32)
		if _, err := rand.Read(b); err != nil {
			return nil, err
		}
		secret = hex.EncodeToString(b)
	}
	addr := net.JoinHostPort("0.0.0.0", strconv.Itoa(o.Port))
	udp, err := net.ListenPacket("udp4", addr)
	if err != nil {
		return nil, err
	}
	tcp, err := net.Listen("tcp4", addr)
	if err != nil {
		udp.Close()
		return nil, err
	}
	gen := &pturn.RelayAddressGeneratorStatic{RelayAddress: ip, Address: "0.0.0.0"}
	permit := func(_ net.Addr, peer net.IP) bool { return Permitted(peer, ip) }
	s, err := pturn.NewServer(pturn.ServerConfig{
		Realm:             "cyrano",
		AuthHandler:       pturn.NewLongTermAuthHandler(secret, nil),
		PacketConnConfigs: []pturn.PacketConnConfig{{PacketConn: udp, RelayAddressGenerator: gen, PermissionHandler: permit}},
		ListenerConfigs:   []pturn.ListenerConfig{{Listener: tcp, RelayAddressGenerator: gen, PermissionHandler: permit}},
	})
	if err != nil {
		udp.Close()
		tcp.Close()
		return nil, err
	}
	if o.Logger != nil {
		o.Logger.Info("turn relay listening", "port", o.Port, "relay", ip.String())
	}
	return &Server{s: s, secret: secret, ip: ip, port: o.Port}, nil
}

// Close stops the relay.
func (s *Server) Close() error { return s.s.Close() }

// Permitted: whether the relay may send to peer — a public address, or
// the relay's own (another allocation of this server).
func Permitted(peer, relay net.IP) bool {
	if peer == nil {
		return false
	}
	if peer.Equal(relay) {
		return true
	}
	return !(peer.IsLoopback() || peer.IsPrivate() || peer.IsLinkLocalUnicast() || peer.IsLinkLocalMulticast() ||
		peer.IsUnspecified() || peer.IsMulticast() || peer.IsInterfaceLocalMulticast())
}

// Credentials is what a document is given: the relay's URLs, a username
// and a credential good for ttl.
func (s *Server) Credentials(ttl time.Duration) (urls []string, username, credential string, err error) {
	username, credential, err = pturn.GenerateLongTermCredentials(s.secret, ttl)
	if err != nil {
		return nil, "", "", err
	}
	hp := net.JoinHostPort(s.ip.String(), strconv.Itoa(s.port))
	return []string{"turn:" + hp + "?transport=udp", "turn:" + hp + "?transport=tcp"}, username, credential, nil
}
