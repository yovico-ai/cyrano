package upstream

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"math/big"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

type testCA struct {
	cert *x509.Certificate
	key  *ecdsa.PrivateKey
}

func mkCert(t *testing.T, tmpl *x509.Certificate, parent *testCA) *testCA {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, parentCert := key, tmpl
	if parent != nil {
		signer, parentCert = parent.key, parent.cert
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, parentCert, &key.PublicKey, signer)
	if err != nil {
		t.Fatal(err)
	}
	c, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	return &testCA{cert: c, key: key}
}

func caTmpl(serial int64, cn string) *x509.Certificate {
	return &x509.Certificate{
		SerialNumber: big.NewInt(serial), Subject: pkix.Name{CommonName: cn},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
		IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign,
	}
}

// A leaf whose server left out the intermediate: its AIA names it, the
// intermediate is fetched, accepted (it chains to a root) and the leaf then
// verifies with the pool. An issuer that does not chain to a root is
// refused; a URL is fetched once.
func TestAIA_CompletesAShortChain(t *testing.T) {
	root := mkCert(t, caTmpl(1, "root"), nil)
	inter := mkCert(t, caTmpl(2, "inter"), root)
	stray := mkCert(t, caTmpl(3, "stray"), nil) // self-signed, no root knows it

	fetches := map[string]int{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fetches[r.URL.Path]++
		switch r.URL.Path {
		case "/inter.crt":
			_, _ = w.Write(inter.cert.Raw)
		case "/stray.crt":
			_, _ = w.Write(stray.cert.Raw)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	leafTmpl := func(serial int64, aia string) *x509.Certificate {
		return &x509.Certificate{
			SerialNumber: big.NewInt(serial), Subject: pkix.Name{CommonName: "site.example"}, DNSNames: []string{"site.example"},
			NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
			KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
			IssuingCertificateURL: []string{srv.URL + aia},
		}
	}
	leaf := mkCert(t, leafTmpl(10, "/inter.crt"), inter)
	strayLeaf := mkCert(t, leafTmpl(11, "/stray.crt"), stray)

	roots := x509.NewCertPool()
	roots.AddCert(root.cert)
	a := newAIAState()
	a.sysPool = func() (*x509.CertPool, error) { return roots.Clone(), nil }

	failure := func(c *x509.Certificate) error {
		_, err := c.Verify(x509.VerifyOptions{Roots: roots, DNSName: "site.example"})
		return err
	}
	if failure(leaf.cert) == nil {
		t.Fatal("the short chain verified without the intermediate")
	}
	if !a.complete(failure(leaf.cert)) {
		t.Fatal("the intermediate was not accepted")
	}
	if _, err := leaf.cert.Verify(x509.VerifyOptions{Roots: a.pool(), DNSName: "site.example"}); err != nil {
		t.Fatalf("the leaf does not verify with the completed pool: %v", err)
	}
	// A request that failed alongside the first: its issuer is already in
	// the pool (its URL already fetched) — it is told to try again too.
	if !a.complete(failure(leaf.cert)) || fetches["/inter.crt"] != 1 {
		t.Fatalf("a parallel failure was not completed from the pool (fetches %d)", fetches["/inter.crt"])
	}
	if a.complete(failure(strayLeaf.cert)) {
		t.Fatal("an issuer that chains to no root was accepted")
	}
	if a.complete(failure(strayLeaf.cert)) || fetches["/stray.crt"] != 1 {
		t.Fatalf("a refused URL was fetched again: %d", fetches["/stray.crt"])
	}
	if a.complete(errFake{}) {
		t.Fatal("another error was taken for an unknown authority")
	}
}

type errFake struct{}

func (errFake) Error() string { return "fake" }

// Two certificates missing, as Let's Encrypt's Generation Y chains are
// served: leaf → YR1 (its AIA) → Root YR, whose AIA copy is cross-signed by
// a system root (ISRG Root X1). Both are fetched up the chain, and the leaf
// verifies with the pool; Chromium completes it the same way.
func TestAIA_CompletesTwoHops(t *testing.T) {
	x1 := mkCert(t, caTmpl(1, "ISRG Root X1"), nil)
	yrCross := mkCert(t, caTmpl(2, "Root YR"), x1)
	var srvURL string
	var yr1Raw []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/yr.crt":
			_, _ = w.Write(yrCross.cert.Raw)
		case "/yr1.crt":
			_, _ = w.Write(yr1Raw)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	srvURL = srv.URL
	yr1T := caTmpl(3, "YR1")
	yr1T.IssuingCertificateURL = []string{srvURL + "/yr.crt"}
	yr1 := mkCert(t, yr1T, yrCross)
	yr1Raw = yr1.cert.Raw
	leaf := mkCert(t, &x509.Certificate{
		SerialNumber: big.NewInt(10), Subject: pkix.Name{CommonName: "site.example"}, DNSNames: []string{"site.example"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		IssuingCertificateURL: []string{srvURL + "/yr1.crt"},
	}, yr1)

	roots := x509.NewCertPool()
	roots.AddCert(x1.cert)
	a := newAIAState()
	a.sysPool = func() (*x509.CertPool, error) { return roots.Clone(), nil }
	_, err := leaf.cert.Verify(x509.VerifyOptions{Roots: roots, DNSName: "site.example"})
	if err == nil {
		t.Fatal("the short chain verified without its intermediates")
	}
	if !a.complete(err) {
		t.Fatal("the two-hop chain was not completed")
	}
	if _, err := leaf.cert.Verify(x509.VerifyOptions{Roots: a.pool(), DNSName: "site.example"}); err != nil {
		t.Fatalf("the leaf does not verify with the completed pool: %v", err)
	}
}
