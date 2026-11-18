// mitmprobe is a development aid: a forward proxy that terminates the
// browser's TLS (CONNECT, any certificate — run the browser with
// --ignore-certificate-errors) and sends each request, untouched, through
// cyrano's upstream transport (internal/upstream). The page is the origin's
// own, on its own origin, with no rewriting and no runtime: only the
// network leg is cyrano's.
//
// It answers one question when a site treats the proxy differently from a
// direct browser: is it the way cyrano talks to the origin (TLS, HTTP/2,
// header order), or what the page sees in the browser? A site that passes
// through mitmprobe and fails through cyrano is telling by the page.
//
//	mitmprobe -listen 127.0.0.1:9555 -cert cert.pem -key key.pem
//	chrome --proxy-server=127.0.0.1:9555 --ignore-certificate-errors
package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/tls"
	"flag"
	"fmt"
	"html"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/andybalholm/brotli"
	"github.com/klauspost/compress/zstd"
	"golang.org/x/net/http2"

	"github.com/yovico/cyrano/internal/upstream"
	"github.com/yovico/cyrano/internal/urlrewrite"
)

func main() {
	listen := flag.String("listen", "127.0.0.1:9555", "address to listen on")
	certFile := flag.String("cert", "", "certificate presented for every host")
	keyFile := flag.String("key", "", "its key")
	h1 := flag.Bool("h1", false, "speak HTTP/1.1 to the browser instead of HTTP/2")
	flag.StringVar(&decodeURL, "decode", "", "send responses whose URL contains this decoded (no Content-Encoding), body unchanged")
	flag.StringVar(&shiftURL, "shift", "", "as -decode, and move every column of line 2 by one: a space after the first newline, the last newline dropped (same length)")
	flag.StringVar(&viaCyrano, "via", "", "a running cyrano's public URL (https://localhost:9443): fetch through it — rewritten scripts, the runtime in identity mode — and put the page's URLs back on their own origins")
	flag.BoolVar(&noRuntime, "noruntime", false, "with -via: take the injected runtime bootstrap out of documents")
	flag.StringVar(&skipPatches, "skip", "", "with -via: comma-separated runtime patches not to install (config.skip)")
	flag.StringVar(&cspMode, "csp", "", "plain mode: rewrite Content-Security-Policy as cyrano does: 'all' (cyrano's translation), 'tt' (only drop the Trusted Types directives), 'src' (only add the page's origin to source lists)")
	dumpPath := flag.String("dump", "", "file to write each exchange's headers to")
	flag.Parse()
	if *dumpPath != "" {
		dumpFile, _ = os.Create(*dumpPath)
	}
	cert, err := tls.LoadX509KeyPair(*certFile, *keyFile)
	if err != nil {
		log.Fatal(err)
	}
	rt := upstream.NewRoundTripper(false)
	protos := []string{"h2", "http/1.1"}
	if *h1 {
		protos = []string{"http/1.1"}
	}
	ln, err := net.Listen("tcp", *listen)
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("mitmprobe on %s", *listen)
	for {
		c, err := ln.Accept()
		if err != nil {
			log.Fatal(err)
		}
		go serve(c, cert, protos, rt)
	}
}

type oneConn struct {
	net.Listener
	c    net.Conn
	done chan struct{}
}

func (l *oneConn) Accept() (net.Conn, error) {
	if c := l.c; c != nil {
		l.c = nil
		return c, nil
	}
	<-l.done
	return nil, io.EOF
}
func (l *oneConn) Close() error   { return nil }
func (l *oneConn) Addr() net.Addr { return &net.TCPAddr{} }

func serve(c net.Conn, cert tls.Certificate, protos []string, rt http.RoundTripper) {
	defer c.Close()
	// The CONNECT request line and headers.
	buf := make([]byte, 0, 4096)
	one := make([]byte, 1)
	for !strings.HasSuffix(string(buf), "\r\n\r\n") {
		if _, err := c.Read(one); err != nil || len(buf) > 65536 {
			return
		}
		buf = append(buf, one[0])
	}
	parts := strings.Fields(strings.SplitN(string(buf), "\r\n", 2)[0])
	if len(parts) < 2 || parts[0] != "CONNECT" {
		_, _ = c.Write([]byte("HTTP/1.1 405 Method Not Allowed\r\n\r\n"))
		return
	}
	host := parts[1]
	if _, err := c.Write([]byte("HTTP/1.1 200 Connection Established\r\n\r\n")); err != nil {
		return
	}
	tc := tls.Server(c, &tls.Config{Certificates: []tls.Certificate{cert}, NextProtos: protos})
	if err := tc.Handshake(); err != nil {
		return
	}
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { forward(w, r, host, rt) })
	if tc.ConnectionState().NegotiatedProtocol == "h2" {
		(&http2.Server{}).ServeConn(tc, &http2.ServeConnOpts{Handler: h})
		return
	}
	done := make(chan struct{})
	srv := &http.Server{Handler: h, ConnState: func(_ net.Conn, s http.ConnState) {
		if s == http.StateClosed || s == http.StateHijacked {
			select {
			case <-done:
			default:
				close(done)
			}
		}
	}}
	_ = srv.Serve(&oneConn{c: tc, done: done})
}

var decodeURL, shiftURL, viaCyrano, skipPatches string
var noRuntime bool
var cspMode string

var metaCSP = regexp.MustCompile(`(?i)(<meta http-equiv="content-security-policy" content=")([^"]*)(")`)

// cspAs rewrites one policy the way cspMode says.
func cspAs(policy, origin string) string {
	switch cspMode {
	case "all":
		return urlrewrite.RewriteCSP(policy, origin)
	case "tt":
		var keep []string
		for _, d := range strings.Split(policy, ";") {
			name := strings.ToLower(strings.TrimSpace(d))
			if strings.HasPrefix(name, "trusted-types") || strings.HasPrefix(name, "require-trusted-types-for") {
				continue
			}
			keep = append(keep, d)
		}
		return strings.Join(keep, ";")
	case "src":
		var out []string
		for _, d := range strings.Split(policy, ";") {
			f := strings.Fields(d)
			if len(f) > 0 && strings.Contains(strings.ToLower(f[0]), "-src") && !strings.Contains(d, "'none'") {
				d += " " + origin
			}
			out = append(out, d)
		}
		return strings.Join(out, ";")
	}
	return policy
}

var bootstrapRE = regexp.MustCompile(`<script[^>]*src="/rewriter\.js"></script><script[^>]*>window\.\$rewriter=.*?\(document\.currentScript\);</script>`)

// cyranoClient speaks HTTP/2 to the local cyrano (any certificate).
var cyranoClient = &http.Client{
	Transport:     &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}, ForceAttemptHTTP2: true, DisableCompression: true},
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
}

// throughCyrano serves r by asking the cyrano at viaCyrano for the proxied
// URL of the same resource, then undoes the one thing that must not reach
// this browser: URLs pointing at the proxy. The runtime is told to leave
// URLs alone (config.identity).
func throughCyrano(w http.ResponseWriter, r *http.Request, host string) {
	target := viaCyrano + "/cyrano/https/" + host + r.URL.RequestURI()
	if r.URL.Path == "/rewriter.js" || r.URL.Path == "/cyrano-worker-init.js" {
		target = viaCyrano + r.URL.RequestURI() // the runtime itself
	}
	out, err := http.NewRequestWithContext(r.Context(), r.Method, target, r.Body)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	out.ContentLength = r.ContentLength
	if r.ContentLength == 0 {
		out.Body = nil
	}
	for k, vs := range r.Header {
		if !hopByHop[k] {
			out.Header[k] = vs
		}
	}
	// cyrano tells the requesting page by its proxied Referer (it sets
	// Referrer-Policy: unsafe-url to always get one, and works out what
	// the page's own policy sends upstream): give it that form.
	if ref := out.Header.Get("Referer"); strings.HasPrefix(ref, "https://") {
		out.Header.Set("Referer", viaCyrano+"/cyrano/https/"+strings.TrimPrefix(ref, "https://"))
	}
	resp, err := cyranoClient.Do(out)
	if err != nil {
		log.Printf("via %s: %v", target, err)
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	proxied := regexp.MustCompile(`(?:` + regexp.QuoteMeta(viaCyrano) + `)?/cyrano/(https?|wss?)/`)
	for k, vs := range resp.Header {
		if hopByHop[k] {
			continue
		}
		for _, v := range vs {
			if k == "Location" || k == "Content-Location" || k == "Link" || k == "Refresh" {
				v = proxied.ReplaceAllString(v, "$1://")
			}
			if strings.HasPrefix(k, "Content-Security-Policy") {
				v = strings.ReplaceAll(v, viaCyrano, "https://"+host) // where the runtime is served from here
			}
			w.Header().Add(k, v)
		}
	}
	// cyrano forces crossorigin=use-credentials on scripts (same-origin
	// under the proxy); here they are really cross-origin: admit them.
	if o := r.Header.Get("Origin"); o != "" {
		w.Header().Set("Access-Control-Allow-Origin", o)
		w.Header().Set("Access-Control-Allow-Credentials", "true")
	}
	ct := strings.ToLower(resp.Header.Get("Content-Type"))
	text := resp.Header.Get("Content-Encoding") == "" && (strings.Contains(ct, "html") || strings.Contains(ct, "javascript") || strings.Contains(ct, "css") || strings.Contains(ct, "json"))
	log.Printf("via %d %s %s%s", resp.StatusCode, r.Method, host, strings.SplitN(r.URL.RequestURI(), "?", 2)[0])
	if !text {
		dump(r, host, resp.StatusCode, w.Header(), -1)
		w.WriteHeader(resp.StatusCode)
		_, _ = io.Copy(w, resp.Body)
		return
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	body = proxied.ReplaceAll(body, []byte("$1://"))
	// The runtime's own URLs on the page's origin (a COEP page loads nothing else).
	body = bytes.ReplaceAll(body, []byte(`"apiBaseURL":"`+viaCyrano+`"`), []byte(`"apiBaseURL":"https://`+host+`"`))
	body = bytes.ReplaceAll(body, []byte(" "+viaCyrano), []byte(" https://"+host)) // CSP in <meta>
	if noRuntime {
		if bootstrapRE.Match(body) {
			log.Printf("bootstrap removed from %s", host+r.URL.Path)
		}
		body = bootstrapRE.ReplaceAll(body, nil)
	}
	extra := `"identity":true,`
	if skipPatches != "" {
		extra += `"skip":["` + strings.Join(strings.Split(skipPatches, ","), `","`) + `"],`
	}
	body = bytes.ReplaceAll(body, []byte("$rewriter_init(window,{"), []byte(`$rewriter_init(window,{`+extra))
	body = bytes.ReplaceAll(body, []byte("$rewriter_init_worker({"), []byte(`$rewriter_init_worker({`+extra))
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	dump(r, host, resp.StatusCode, w.Header(), len(body))
	w.WriteHeader(resp.StatusCode)
	_, _ = w.Write(body)
}

// decoded reads a response body, decoded.
func decoded(resp *http.Response) ([]byte, error) {
	var r io.Reader = resp.Body
	switch strings.ToLower(resp.Header.Get("Content-Encoding")) {
	case "gzip":
		gz, err := gzip.NewReader(resp.Body)
		if err != nil {
			return nil, err
		}
		r = gz
	case "br":
		r = brotli.NewReader(resp.Body)
	case "zstd":
		zr, err := zstd.NewReader(resp.Body)
		if err != nil {
			return nil, err
		}
		defer zr.Close()
		r = zr
	}
	return io.ReadAll(r)
}

// dump writes one line per exchange to the dump file: the browser's
// request headers and the response headers it is given, for comparing runs.
var dumpFile *os.File

func dump(r *http.Request, host string, status int, h http.Header, bodyLen int) {
	if dumpFile == nil {
		return
	}
	line := func(hd http.Header) string {
		var out []string
		for k, vs := range hd {
			v := strings.Join(vs, ", ")
			if len(v) > 300 {
				v = v[:300] + "…"
			}
			out = append(out, strings.ToLower(k)+"="+v)
		}
		sort.Strings(out)
		return strings.Join(out, " | ")
	}
	fmt.Fprintf(dumpFile, "%s https://%s%s\n  REQ %s\n  RES %d len=%d %s\n", r.Method, host, strings.SplitN(r.URL.RequestURI(), "?", 2)[0], line(r.Header), status, bodyLen, line(h))
}

var hopByHop = map[string]bool{"Connection": true, "Proxy-Connection": true, "Keep-Alive": true, "Te": true, "Trailer": true, "Transfer-Encoding": true, "Upgrade": true}

func forward(w http.ResponseWriter, r *http.Request, connectHost string, rt http.RoundTripper) {
	host := r.Host
	if host == "" {
		host = strings.TrimSuffix(connectHost, ":443")
	}
	if viaCyrano != "" {
		throughCyrano(w, r, host)
		return
	}
	ctx := context.WithValue(r.Context(), upstream.SessionKey{}, "mitmprobe")
	out, err := http.NewRequestWithContext(ctx, r.Method, "https://"+host+r.URL.RequestURI(), r.Body)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	out.ContentLength = r.ContentLength
	if r.ContentLength == 0 {
		out.Body = nil
	}
	for k, vs := range r.Header {
		if hopByHop[k] {
			continue
		}
		out.Header[k] = vs
	}
	resp, err := rt.RoundTrip(out)
	if err != nil {
		log.Printf("%s %s: %v", r.Method, out.URL, err)
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	for k, vs := range resp.Header {
		if hopByHop[k] || k == "Alt-Svc" {
			continue
		}
		w.Header()[k] = vs
	}
	log.Printf("%d %s %s", resp.StatusCode, r.Method, strings.SplitN(out.URL.String(), "?", 2)[0])
	u := out.URL.String()
	if cspMode != "" {
		for _, k := range []string{"Content-Security-Policy"} {
			if vs := w.Header().Values(k); len(vs) > 0 {
				w.Header().Del(k)
				for _, v := range vs {
					w.Header().Add(k, cspAs(v, "https://"+host))
				}
			}
		}
		if strings.Contains(strings.ToLower(resp.Header.Get("Content-Type")), "html") {
			body, err := decoded(resp)
			if err != nil {
				http.Error(w, err.Error(), http.StatusBadGateway)
				return
			}
			n := 0
			body = metaCSP.ReplaceAllFunc(body, func(m []byte) []byte {
				g := metaCSP.FindSubmatch(m)
				n++
				return []byte(string(g[1]) + html.EscapeString(cspAs(html.UnescapeString(string(g[2])), "https://"+host)) + string(g[3]))
			})
			log.Printf("csp %s: header + %d meta on %s", cspMode, n, u)
			w.Header().Del("Content-Encoding")
			w.Header().Set("Content-Length", strconv.Itoa(len(body)))
			dump(r, host, resp.StatusCode, w.Header(), len(body))
			w.WriteHeader(resp.StatusCode)
			_, _ = w.Write(body)
			return
		}
	}
	shift := shiftURL != "" && strings.Contains(u, shiftURL)
	if resp.StatusCode == 200 && (shift || (decodeURL != "" && strings.Contains(u, decodeURL))) {
		body, err := decoded(resp)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		if ct := resp.Header.Get("Content-Type"); shift && strings.Contains(ct, "html") {
			// The first inline script: a space before its first character.
			if i := bytes.Index(body, []byte("<script")); i >= 0 {
				if j := bytes.IndexByte(body[i:], '>'); j >= 0 {
					at := i + j + 1
					body = append(append(append([]byte{}, body[:at]...), ' '), body[at:]...)
					log.Printf("shifted inline script of %s", u)
				}
			}
		} else if i := bytes.IndexByte(body, '\n'); shift && (i < 0 || !bytes.HasSuffix(body, []byte("\n"))) {
			body = append([]byte{' '}, body...)
			log.Printf("shifted (prepended) %s", u)
		} else if shift {
			moved := append([]byte{}, body[:i+1]...)
			moved = append(moved, ' ')
			moved = append(moved, body[i+1:len(body)-1]...)
			body = moved
			log.Printf("shifted %s", u)
		} else {
			log.Printf("decoded %s", u)
		}
		w.Header().Del("Content-Encoding")
		w.Header().Set("Content-Length", strconv.Itoa(len(body)))
		w.WriteHeader(resp.StatusCode)
		_, _ = w.Write(body)
		return
	}
	dump(r, host, resp.StatusCode, w.Header(), -1)
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}
