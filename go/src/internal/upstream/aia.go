package upstream

import (
	"crypto/x509"
	"encoding/pem"
	"errors"
	"io"
	"net/http"
	"sync"
	"time"
)

// A server that sends its certificate without the intermediate that issued
// it: Chrome completes the chain itself, fetching the issuer named in the
// certificate's Authority Information Access ("CA Issuers") over HTTP, and
// loads the page; Go's verifier reports an unknown authority, and the
// proxy answered with its error page (dental.dhcs.ca.gov, 2026-11-20).
//
// The proxy does as Chrome does: on an unknown-authority failure it fetches
// the issuer the failing certificate names, accepts it only if it verifies
// to a system root and the certificate verifies through it, adds it to the
// pool the upstream clients verify with, and tries the request once more.
// An intermediate that itself chains to a system root admits exactly the
// chains Chrome's AIA fetching admits. (Not done: PKCS#7 bundles, which
// Chrome reads too; a chain missing more than one certificate.)

type aiaState struct {
	// One completion at a time: a page's parallel requests fail together
	// on a short chain; the first fetches the issuer, the rest wait and
	// find it accepted.
	completing sync.Mutex
	mu         sync.Mutex
	roots      *x509.CertPool  // system roots plus the intermediates accepted; nil: the system's
	tried      map[string]bool // AIA URLs fetched (accepted or not)
	fetch      func(string) ([]byte, error)
	sysPool    func() (*x509.CertPool, error)
}

func newAIAState() *aiaState {
	client := &http.Client{Timeout: 10 * time.Second}
	return &aiaState{
		tried: map[string]bool{},
		fetch: func(u string) ([]byte, error) {
			resp, err := client.Get(u)
			if err != nil {
				return nil, err
			}
			defer resp.Body.Close()
			if resp.StatusCode != http.StatusOK {
				return nil, errors.New(resp.Status)
			}
			return io.ReadAll(io.LimitReader(resp.Body, 64<<10))
		},
		sysPool: systemPool,
	}
}

// systemPool is the system's roots (a test gives its own).
var systemPool = x509.SystemCertPool

// pool is the root pool upstream clients verify with (nil: the system's).
func (a *aiaState) pool() *x509.CertPool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.roots
}

// complete reports whether err is an unknown-authority failure whose missing
// issuer it could fetch and accept; the pool then holds it.
func (a *aiaState) complete(err error) bool {
	var ua x509.UnknownAuthorityError
	if !errors.As(err, &ua) || ua.Cert == nil {
		return false
	}
	leaf := ua.Cert
	a.completing.Lock()
	defer a.completing.Unlock()
	anyUsage := []x509.ExtKeyUsage{x509.ExtKeyUsageAny}
	// Completed meanwhile (by a request that failed alongside this one):
	// the pool already verifies it.
	if pool := a.pool(); pool != nil {
		if _, verr := leaf.Verify(x509.VerifyOptions{Roots: pool, KeyUsages: anyUsage}); verr == nil {
			return true
		}
	}
	for _, u := range leaf.IssuingCertificateURL {
		a.mu.Lock()
		seen := a.tried[u]
		a.tried[u] = true
		a.mu.Unlock()
		if seen {
			continue
		}
		raw, ferr := a.fetch(u)
		if ferr != nil {
			continue
		}
		issuer := parseIssuer(raw)
		if issuer == nil {
			continue
		}
		sys, serr := a.sysPool()
		if serr != nil || sys == nil {
			sys = x509.NewCertPool()
		}
		if _, verr := issuer.Verify(x509.VerifyOptions{Roots: sys, KeyUsages: anyUsage}); verr != nil {
			continue
		}
		inter := x509.NewCertPool()
		inter.AddCert(issuer)
		if _, verr := leaf.Verify(x509.VerifyOptions{Roots: sys, Intermediates: inter, KeyUsages: anyUsage}); verr != nil {
			continue
		}
		a.mu.Lock()
		if a.roots == nil {
			a.roots = sys.Clone()
		}
		a.roots.AddCert(issuer)
		a.mu.Unlock()
		return true
	}
	return false
}

// parseIssuer reads a DER or PEM certificate (what CA Issuers URLs serve).
func parseIssuer(raw []byte) *x509.Certificate {
	if c, err := x509.ParseCertificate(raw); err == nil {
		return c
	}
	if b, _ := pem.Decode(raw); b != nil && b.Type == "CERTIFICATE" {
		if c, err := x509.ParseCertificate(b.Bytes); err == nil {
			return c
		}
	}
	return nil
}
