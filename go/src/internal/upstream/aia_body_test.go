package upstream

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// A POST to a server that sends its chain short: the round tripper
// completes it from AIA and tries once more — with the body, none of which
// was sent before the handshake failed (bigotires' POSTs to
// metrics.kmsmep.com failed with "unknown authority"; only bodiless
// requests were retried).
func TestAIA_RetriesARequestWithABody(t *testing.T) {
	root := mkCert(t, caTmpl(1, "root"), nil)
	inter := mkCert(t, caTmpl(2, "inter"), root)
	aiaSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write(inter.cert.Raw) }))
	defer aiaSrv.Close()
	leaf := mkCert(t, &x509.Certificate{
		SerialNumber: big.NewInt(10), Subject: pkix.Name{CommonName: "127.0.0.1"}, IPAddresses: []net.IP{net.ParseIP("127.0.0.1")},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		IssuingCertificateURL: []string{aiaSrv.URL + "/inter.crt"},
	}, inter)

	got := ""
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		got = string(b)
		_, _ = w.Write([]byte("ok"))
	}))
	// The chain sent short: the leaf alone.
	srv.TLS = &tls.Config{Certificates: []tls.Certificate{{Certificate: [][]byte{leaf.cert.Raw}, PrivateKey: leaf.key}}}
	srv.StartTLS()
	defer srv.Close()

	// The system's roots, for this test: the test root.
	roots := x509.NewCertPool()
	roots.AddCert(root.cert)
	was := systemPool
	systemPool = func() (*x509.CertPool, error) { return roots.Clone(), nil }
	defer func() { systemPool = was }()

	rt := NewRoundTripper(false)
	req, _ := http.NewRequestWithContext(context.WithValue(context.Background(), SessionKey{}, "s1"), "POST", srv.URL+"/collect", strings.NewReader("payload=1"))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := rt.RoundTrip(req)
	if err != nil {
		t.Fatalf("POST over a short chain: %v", err)
	}
	resp.Body.Close()
	if got != "payload=1" {
		t.Errorf("the server got body %q, want the request's", got)
	}
}
