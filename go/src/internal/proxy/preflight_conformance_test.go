package proxy

import (
	"strconv"
	"strings"
	"testing"

	"pgregory.net/rapid"

	"github.com/yovico/cyrano/internal/specoracle"
)

var preflightHeaderPool = []headerPair{
	{"accept", "*/*"}, {"Accept", "a(b"}, {"accept", "text/html, application/json;q=0.9"}, {"accept-language", "en-US,en;q=0.9"},
	{"accept-language", "en_US"}, {"Accept-Language", strings.Repeat("a", 129)}, {"content-language", "de"}, {"content-language", "de\x01"},
	{"content-type", "text/plain;charset=UTF-8"}, {"content-type", " text/plain "}, {"content-type", "application/json"},
	{"Content-Type", "text/plain garbage"}, {"content-type", "multipart/form-data; boundary=x"}, {"content-type", "TEXT/PLAIN"},
	{"content-type", "application/x-www-form-urlencoded"}, {"content-type", "text/plain\x7f"}, {"range", "bytes=0-10"}, {"range", "bytes=10-"},
	{"range", "bytes=10-5"}, {"range", "bytes=-5"}, {"range", "bytes=1-2, 4-5"}, {"Range", "bytes =0-1"}, {"x-foo", "1"}, {"X-Alpha", "2"},
	{"authorization", "x"}, {"x-foo", "3"}, {"accept", strings.Repeat("b", 128)}, {"accept", strings.Repeat("b", 129)},
}

func TestSpecConformance_Preflight(t *testing.T) {
	oracle := specoracle.Need(t)
	rapid.Check(t, func(rt *rapid.T) {
		hs := rapid.SliceOfN(rapid.SampledFrom(preflightHeaderPool), 0, 4).Draw(rt, "headers")
		method := rapid.SampledFrom([]string{"GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "patch", "OPTIONS"}).Draw(rt, "method")
		force := rapid.Bool().Draw(rt, "force")
		args := []string{method, map[bool]string{true: "1", false: "0"}[force]}
		pargs := []string{}
		for _, h := range hs {
			args = append(args, h.name, h.value)
			pargs = append(pargs, h.name, h.value)
		}
		want, _, err := oracle.Ask("needspreflight", args...)
		if err != nil {
			rt.Fatal(err)
		}
		if got := map[bool]string{true: "yes", false: "no"}[needsPreflight(method, force, hs)]; got != want {
			rt.Fatalf("needsPreflight(%q, %v, %q) = %s, spec %s", method, force, hs, got, want)
		}
		wantH, _, err := oracle.Ask("preflightheaders", pargs...)
		if err != nil {
			rt.Fatal(err)
		}
		if got := requestHeadersValue(hs); got != wantH {
			rt.Fatalf("requestHeaders(%q) = %q, spec %q", hs, got, wantH)
		}
	})
}

func TestSpecConformance_PreflightOk(t *testing.T) {
	oracle := specoracle.Need(t)
	const o = "https://a.example"
	opt := func(rt *rapid.T, name string, vals []string) (string, string) {
		if !rapid.Bool().Draw(rt, name+"?") {
			return "0", ""
		}
		return "1", rapid.SampledFrom(vals).Draw(rt, name)
	}
	rapid.Check(t, func(rt *rapid.T) {
		status := rapid.SampledFrom([]int{200, 204, 299, 199, 300, 302, 404, 500}).Draw(rt, "status")
		aoP, ao := opt(rt, "acao", []string{o, "*", "https://b.example", "null", " " + o})
		acP, ac := opt(rt, "acac", []string{"true", "TRUE", "false", ""})
		cred := rapid.Bool().Draw(rt, "cred")
		method := rapid.SampledFrom([]string{"GET", "POST", "PUT", "PATCH", "patch", "DELETE", "FOO"}).Draw(rt, "method")
		unsafe := rapid.SliceOfNDistinct(rapid.SampledFrom([]string{"x-foo", "x-bar", "authorization", "content-type"}), 0, 3, func(s string) string { return s }).Draw(rt, "unsafe")
		sortStrings(unsafe)
		lines := func(name string, pool []string) []string {
			return rapid.SliceOfN(rapid.SampledFrom(pool), 0, 2).Draw(rt, name)
		}
		am := lines("acam", []string{"PUT, PATCH, DELETE", "put", "*", "  PUT ,DELETE", ",,PUT,", "PUT, a b", "", "PATCH", "patch", "FOO"})
		ah := lines("acah", []string{"x-foo, x-bar", "X-FOO", "*", "x-foo, a b", "", "Authorization", "content-type,x-bar"})
		var acao, acac []string
		if aoP == "1" {
			acao = []string{ao}
		}
		if acP == "1" {
			acac = []string{ac}
		}
		b := map[bool]string{true: "1", false: "0"}
		want, _, err := oracle.Ask("preflightok", strconv.Itoa(status), aoP, ao, acP, ac, b[cred], o, method, strings.Join(unsafe, ","),
			strings.Join(am, "\x1e"), strings.Join(ah, "\x1e"))
		if err != nil {
			rt.Fatal(err)
		}
		if got := map[bool]string{true: "yes", false: "no"}[preflightOk(status, acao, acac, am, ah, o, cred, method, unsafe)]; got != want {
			rt.Fatalf("preflightOk(%d, %q, %q, %q, %q, cred %v, %s, %q) = %s, spec %s", status, acao, acac, am, ah, cred, method, unsafe, got, want)
		}
	})
}

func TestSpecConformance_MaxAge(t *testing.T) {
	oracle := specoracle.Need(t)
	for _, v := range []string{"", "0", "5", "60", "7200", "7201", "99999999999", "-1", "-", "abc", " 60 ", "1.5", "+5", "-0"} {
		for _, p := range []bool{true, false} {
			want, _, err := oracle.Ask("maxage", map[bool]string{true: "1", false: "0"}[p], v)
			if err != nil {
				t.Fatal(err)
			}
			if got := strconv.Itoa(maxAge(v, p)); got != want {
				t.Errorf("maxAge(%q, %v) = %s, spec %s", v, p, got, want)
			}
		}
	}
}

func sortStrings(s []string) {
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && s[j] < s[j-1]; j-- {
			s[j], s[j-1] = s[j-1], s[j]
		}
	}
}

// A blob: context names the origin inside its URL (its fetches had no
// Origin and no preflight: preflight-vs-chromium's blob: worker).
func TestInitiatorOriginBlob(t *testing.T) {
	for in, want := range map[string]string{
		"blob:https://a.example/0e3c-11": "https://a.example",
		"blob:http://127.0.0.1:8080/x":   "http://127.0.0.1:8080",
		"BLOB:https://a.example/x":       "https://a.example",
		"blob:null/x":                    "",
		"blob:blob:https://a.example/x":  "",
		"https://a.example/page":         "https://a.example",
		"data:text/plain,x":              "",
	} {
		if got := initiatorOrigin(in); got != want {
			t.Errorf("initiatorOrigin(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestSpecConformance_CorsElementDest(t *testing.T) {
	oracle := specoracle.Need(t)
	for _, d := range []string{"script", "Script", "style", "image", "font", "audio", "video", "track", "audioworklet", "paintworklet",
		"sharedstorageworklet", "manifest", "json", "empty", "", "document", "iframe", "worker", "sharedworker", "serviceworker", "report", "object", "embed"} {
		want, _, err := oracle.Ask("corsdest", d)
		if err != nil {
			t.Fatal(err)
		}
		if got := map[bool]string{true: "yes", false: "no"}[corsElementDest(d)]; got != want {
			t.Errorf("corsElementDest(%q) = %s, spec %s", d, got, want)
		}
	}
}
