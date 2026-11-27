package upstream

// Conformance of ReadAltSvc and UseH3 with spec/Alpn.agda.

import (
	"strconv"
	"strings"
	"testing"

	"github.com/yovico/cyrano/internal/specoracle"
	"pgregory.net/rapid"
)

func altSvcLines(clear bool, offers []AltSvcOffer) string {
	if clear {
		return "clear"
	}
	lines := make([]string, len(offers))
	for i, o := range offers {
		lines[i] = o.Proto + "\t" + o.Host + "\t" + strconv.Itoa(o.Port) + "\t" + strconv.Itoa(o.MaxAge)
	}
	return strings.Join(lines, "\n")
}

// Alt-Svc values from pieces that make readable and unreadable entries.
func genAltSvc(t *rapid.T) string {
	if rapid.IntRange(0, 9).Draw(t, "clear") == 0 {
		return rapid.SampledFrom([]string{"clear", " Clear", "CLEAR ", "clear;", "clear, h3=\":443\""}).Draw(t, "c")
	}
	n := rapid.IntRange(1, 4).Draw(t, "n")
	parts := make([]string, n)
	for i := range parts {
		pid := rapid.SampledFrom([]string{"h3", "h3-29", "h2", "H3", " h3 ", ""}).Draw(t, "pid")
		host := rapid.SampledFrom([]string{"", "Alt.Example", "a,b", "[::1]", "x\\\"y"}).Draw(t, "host")
		port := rapid.SampledFrom([]string{"443", "8443", "", "44x", "0"}).Draw(t, "port")
		au := rapid.SampledFrom([]string{`"` + host + ":" + port + `"`, host + ":" + port, `"` + host + `"`, `"` + host + ":" + port}).Draw(t, "au")
		eq := rapid.SampledFrom([]string{"=", " = ", "", "=="}).Draw(t, "eq")
		params := rapid.SampledFrom([]string{"", "; ma=3600", ";ma=60; persist=1", "; MA = 10", "; ma=x; ma=5", "; v=\"1,2\""}).Draw(t, "params")
		parts[i] = pid + eq + au + params
	}
	return strings.Join(parts, rapid.SampledFrom([]string{",", ", ", " ,"}).Draw(t, "sep"))
}

func TestSpecConformance_ReadAltSvc(t *testing.T) {
	oracle := specoracle.Need(t)
	rapid.Check(t, func(rt *rapid.T) {
		v := genAltSvc(rt)
		want, _, err := oracle.Ask("altsvc", v)
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		if got := altSvcLines(ReadAltSvc(v)); got != want {
			rt.Fatalf("ReadAltSvc(%q)\n got  %q\n spec %q", v, got, want)
		}
	})
}

func TestSpecConformance_UseH3(t *testing.T) {
	oracle := specoracle.Need(t)
	rapid.Check(t, func(rt *rapid.T) {
		scheme := rapid.SampledFrom([]string{"https", "http", "wss"}).Draw(rt, "scheme")
		host := rapid.SampledFrom([]string{"codepen.io", "Alt.Example", "a.com"}).Draw(rt, "host")
		port := rapid.SampledFrom([]int{443, 8443}).Draw(rt, "port")
		rrArg := rapid.SampledFrom([]string{"-", "h3,h2", "h2", "h3-29,h2", "h2,h3", ""}).Draw(rt, "rr")
		alt := rapid.SampledFrom([]string{"-", `h3=":443"; ma=86400`, `h3="alt.example:443"`, `h3-29=":443"`, `h3=":8443"`, "clear"}).Draw(rt, "alt")
		broken := rapid.Bool().Draw(rt, "broken")
		var rr []string
		if rrArg != "-" {
			rr = strings.Split(rrArg, ",")
		}
		var offers []AltSvcOffer
		if alt != "-" {
			_, offers = ReadAltSvc(alt)
		}
		b := "0"
		if broken {
			b = "1"
		}
		want, _, err := oracle.Ask("h3proto", scheme, host, strconv.Itoa(port), rrArg, alt, b)
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		got := "h2"
		if UseH3(scheme, host, port, rr, offers, broken) {
			got = "h3"
		}
		if got != want {
			rt.Fatalf("UseH3(%s, %s, %d, %q, %q, %v) = %s, spec %s", scheme, host, port, rrArg, alt, broken, got, want)
		}
	})
}

// Cloudflare's header, as these zones send it.
func TestReadAltSvc_Cloudflare(t *testing.T) {
	clear, offers := ReadAltSvc(`h3=":443"; ma=86400`)
	if clear || len(offers) != 1 || offers[0] != (AltSvcOffer{"h3", "", 443, 86400}) {
		t.Fatalf("got %v %+v", clear, offers)
	}
}
