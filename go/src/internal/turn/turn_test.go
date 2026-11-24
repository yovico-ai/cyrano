package turn

import (
	"net"
	"strings"
	"testing"
	"time"

	pturn "github.com/pion/turn/v4"
)

func TestPermitted(t *testing.T) {
	relay := net.ParseIP("203.0.113.7")
	for ip, want := range map[string]bool{
		"203.0.113.7": true, "8.8.8.8": true, "2001:4860::8888": true,
		"127.0.0.1": false, "10.1.2.3": false, "192.168.1.1": false, "172.16.0.1": false, "169.254.1.1": false,
		"::1": false, "fe80::1": false, "0.0.0.0": false, "224.0.0.1": false,
	} {
		if got := Permitted(net.ParseIP(ip), relay); got != want {
			t.Errorf("Permitted(%s) = %v, want %v", ip, got, want)
		}
	}
	if !Permitted(net.ParseIP("127.0.0.1"), net.ParseIP("127.0.0.1")) {
		t.Error("the relay's own loopback address refused")
	}
}

// A client with the credentials a document gets allocates a relay address
// on the relay's IP; a wrong credential is refused.
func TestAllocate(t *testing.T) {
	// One free port for UDP and TCP.
	l, _ := net.ListenPacket("udp4", "127.0.0.1:0")
	port := l.LocalAddr().(*net.UDPAddr).Port
	l.Close()
	s, err := Start(Options{Port: port, IP: "127.0.0.1"})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	urls, user, cred, err := s.Credentials(time.Hour)
	if err != nil || len(urls) != 2 || !strings.HasPrefix(urls[0], "turn:127.0.0.1:") {
		t.Fatalf("credentials: %v %v", urls, err)
	}
	try := func(password string) error {
		conn, _ := net.ListenPacket("udp4", "127.0.0.1:0")
		defer conn.Close()
		c, err := pturn.NewClient(&pturn.ClientConfig{
			STUNServerAddr: urls[0][5:strings.IndexByte(urls[0], '?')], TURNServerAddr: urls[0][5:strings.IndexByte(urls[0], '?')],
			Conn: conn, Username: user, Password: password, Realm: "cyrano",
		})
		if err != nil {
			return err
		}
		defer c.Close()
		if err := c.Listen(); err != nil {
			return err
		}
		relayConn, err := c.Allocate()
		if err != nil {
			return err
		}
		defer relayConn.Close()
		if !strings.HasPrefix(relayConn.LocalAddr().String(), "127.0.0.1:") {
			t.Errorf("relay address %s", relayConn.LocalAddr())
		}
		return nil
	}
	if err := try(cred); err != nil {
		t.Fatalf("allocation with the document's credentials: %v", err)
	}
	if err := try("wrong"); err == nil {
		t.Fatal("a wrong credential allocated")
	}
}
