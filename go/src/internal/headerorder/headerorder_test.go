package headerorder

import (
	"bufio"
	"fmt"
	"io"
	"net"
	"net/http"
	"reflect"
	"strings"
	"testing"
)

// A real server on the recording listener: each request's handler sees the
// header names in the order they were on the wire — across keep-alive
// requests with bodies, chunked bodies and reads split anywhere.
func TestRecordsWireOrderPerRequest(t *testing.T) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	got := make(chan []string, 8)
	srv := &http.Server{ConnContext: ConnContext, Handler: Handler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		got <- FromContext(r.Context())
		fmt.Fprint(w, "ok")
	}))}
	go srv.Serve(Listener(l))
	defer srv.Close()

	c, err := net.Dial("tcp", l.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	br := bufio.NewReader(c)
	send := func(raw string, split int) {
		t.Helper()
		// Written in two pieces, to split the header block (or body) across reads.
		if split > 0 && split < len(raw) {
			io.WriteString(c, raw[:split])
			io.WriteString(c, raw[split:])
		} else {
			io.WriteString(c, raw)
		}
		resp, err := http.ReadResponse(br, nil)
		if err != nil {
			t.Fatal(err)
		}
		io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
	}
	cases := []struct {
		raw  string
		want []string
	}{
		{"GET /a HTTP/1.1\r\nHost: x\r\nsec-ch-ua-platform: \"Linux\"\r\nUser-Agent: UA\r\nsec-ch-ua: b\r\nAccept: */*\r\n\r\n",
			[]string{"host", "sec-ch-ua-platform", "user-agent", "sec-ch-ua", "accept"}},
		{"POST /b HTTP/1.1\r\nHost: x\r\nContent-Length: 11\r\nX-Custom: 1\r\nUser-Agent: UA\r\n\r\nGET /fake\r\n",
			[]string{"host", "content-length", "x-custom", "user-agent"}}, // the body is not a request
		{"POST /c HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\nZ-Last: 1\r\nA-First: 2\r\n\r\n5\r\nhello\r\n3;ext=1\r\nabc\r\n0\r\nTrailer: t\r\n\r\n",
			[]string{"host", "transfer-encoding", "z-last", "a-first"}},
		{"GET /d HTTP/1.1\r\nHost: x\r\nB: 1\r\nA: 2\r\n\r\n", []string{"host", "b", "a"}},
	}
	for i, tc := range cases {
		for _, split := range []int{0, 7, len(tc.raw) / 2, len(tc.raw) - 3} {
			send(tc.raw, split)
			if o := <-got; !reflect.DeepEqual(o, tc.want) {
				t.Errorf("request %d (split %d): order %v, want %v", i, split, o, tc.want)
			}
		}
	}
}

func TestApply(t *testing.T) {
	browser := []string{"host", "connection", "sec-ch-ua-platform", "user-agent", "x-page", "accept", "sec-fetch-site", "accept-encoding", "accept-language"}
	// What the proxy is about to send: host/connection gone, cookie, priority and origin added.
	have := []string{"accept", "accept-encoding", "accept-language", "cookie", "origin", "priority", "sec-ch-ua-platform", "sec-fetch-site", "user-agent", "x-page"}
	want := "sec-ch-ua-platform user-agent x-page accept sec-fetch-site accept-encoding accept-language origin cookie priority"
	if got := strings.Join(Apply(browser, have), " "); got != want {
		t.Errorf("Apply:\n got  %s\n want %s", got, want)
	}
}

func TestChromeDefault(t *testing.T) {
	// A fetch and an XHR, as Chrome 139 was measured sending them (tls.peet.ws,
	// 2026-11-24, DNT on): a fetch's page-set headers follow
	// sec-ch-ua-mobile, an XHR's come first; Content-Length leads.
	have := []string{"accept", "accept-encoding", "accept-language", "content-length", "dnt", "priority", "referer", "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform", "sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site", "user-agent", "x-custom"}
	want := "content-length sec-ch-ua-platform user-agent sec-ch-ua dnt sec-ch-ua-mobile x-custom accept sec-fetch-site sec-fetch-mode sec-fetch-dest referer accept-encoding accept-language priority"
	if got := strings.Join(ChromeDefault(have, false), " "); got != want {
		t.Errorf("fetch:\n got  %s\n want %s", got, want)
	}
	wantXHR := "content-length x-custom sec-ch-ua-platform user-agent sec-ch-ua dnt sec-ch-ua-mobile accept sec-fetch-site sec-fetch-mode sec-fetch-dest referer accept-encoding accept-language priority"
	if got := strings.Join(ChromeDefault(have, false, true), " "); got != wantXHR {
		t.Errorf("xhr:\n got  %s\n want %s", got, wantXHR)
	}
	nav := []string{"accept", "accept-encoding", "accept-language", "cookie", "priority", "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform", "sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site", "sec-fetch-user", "upgrade-insecure-requests", "user-agent"}
	wantNav := "sec-ch-ua sec-ch-ua-mobile sec-ch-ua-platform upgrade-insecure-requests user-agent accept sec-fetch-site sec-fetch-mode sec-fetch-user sec-fetch-dest accept-encoding accept-language cookie priority"
	if got := strings.Join(ChromeDefault(nav, true), " "); got != wantNav {
		t.Errorf("navigation:\n got  %s\n want %s", got, wantNav)
	}
}
