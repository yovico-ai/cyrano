package urlrewrite

// Conformance of cookies.go with spec/Cookies.agda, asked live.

import (
	"strconv"
	"strings"
	"testing"

	"github.com/yovico/cyrano/internal/specoracle"
	"pgregory.net/rapid"
)

var (
	cookieNames  = []string{"a", "sid", "__Host-x", "__Secure-y", "__HOST-z", "", " sp ", "n!m", "é", "n\tm", "\tt\t"}
	cookieValues = []string{"1", "", "v=w", " padded ", "a b", `"q"`, "__Host-v", "x;y", "a\tb", "\t1\t"}
	cookieAttrs  = []string{
		"", "Path=/", "Path=/app", "Path=/app/", "path=nope", "Path=", "Path=/other", "Path=/é",
		"Domain=a.example", "Domain=.a.example", "Domain=www.a.example", "Domain=A.example", "Domain=b.example",
		"Domain=", "Domain=example", "Domain=sub.www.a.example", "Domain=1.2.3.4",
		"Secure", "secure", "HttpOnly", "SameSite=None", "SameSite=Lax", "SameSite=Strict", "SameSite=bogus",
		"Max-Age=60", "Max-Age=0", "Max-Age=-1", "Max-Age=abc", "Max-Age=", "Max-Age=-", "Unknown=1", " Secure ",
		"Expires=Wed, 21 Oct 2037 07:28:00 GMT", "Expires=", "\x01", "Path=/a\tb", "\tSecure", "Priority=High", "priority=low", "Priority=medium", "Priority=bogus", "Max-Age=\t60", "Foo=a\tb", "Expires=1 Jan\t2027 0:0:0",
	}
	cookieURLs = []string{
		"https://www.a.example/app/page?x", "http://www.a.example/app/page", "https://a.example/", "https://www.a.example/app",
		"https://www.a.example/application", "https://sub.www.a.example/app/page", "https://b.example/app/page",
		"http://localhost:8080/app/x", "https://1.2.3.4/app/", "http://[::1]/", "https://www.a.example",
	}
)

func drawCookieString(rt *rapid.T) string {
	n := rapid.SampledFrom(cookieNames).Draw(rt, "name")
	v := rapid.SampledFrom(cookieValues).Draw(rt, "value")
	s := n + "=" + v
	if n == "" && rapid.Bool().Draw(rt, "nameless") {
		s = v
	}
	for _, a := range rapid.SliceOfN(rapid.SampledFrom(cookieAttrs), 0, 4).Draw(rt, "attrs") {
		s += ";" + rapid.SampledFrom([]string{"", " "}).Draw(rt, "sp") + a
	}
	return s
}

func opt(p *string) string {
	if p == nil {
		return ""
	}
	return "=" + *p
}

func flag(b bool, t, f string) string {
	if b {
		return t
	}
	return f
}

func TestSpecConformance_SetCookie(t *testing.T) {
	oracle := specoracle.Need(t)
	rapid.Check(t, func(rt *rapid.T) {
		api := rapid.Bool().Draw(rt, "api")
		ps := rapid.Bool().Draw(rt, "publicSuffix")
		page := rapid.SampledFrom(cookieURLs).Draw(rt, "url")
		s := drawCookieString(rt)
		want, wantOK := ask(rt, oracle, "setcookie", flag(api, "api", "http"), flag(ps, "ps", "nops"), page, s)

		got, ok := "", false
		if sc, parsed := ParseSetCookie(s); parsed {
			u, _ := parseRef(nil, page)
			if c, stored := storeCookie(api, ps, u, sc); stored {
				ok = true
				got = strings.Join([]string{
					flag(c.HostOnly, "h", "d"), c.Domain, c.Path, c.Name, c.Value, flag(c.Secure, "s", "i"),
					flag(c.HTTPOnly, "H", "-"), string(rune(c.SameSite)), opt(sc.MaxAge), opt(sc.Expires), c.WireName(), c.WireValue(),
					string(rune(c.Priority)),
				}, "\n")
				// The wire form reads back as the cookie (HttpOnly never goes on the wire).
				back, bok := Unwire(c.WireName(), c.WireValue())
				c.HTTPOnly = false
				c.Priority = PriorityMedium // the legacy wire form carries none
				if !bok || (back != c && !strings.ContainsAny(c.Domain+c.Path, "é")) {
					rt.Fatalf("Unwire(wire(%+v)) = %+v, %v", c, back, bok)
				}
			}
		}
		if ok != wantOK || got != want {
			rt.Fatalf("set-cookie %q at %s (api=%v ps=%v):\n got  %q %v\n spec %q %v", s, page, api, ps, got, ok, want, wantOK)
		}
	})
}

func TestSpecConformance_CookiesFor(t *testing.T) {
	oracle := specoracle.Need(t)
	rapid.Check(t, func(rt *rapid.T) {
		api := rapid.Bool().Draw(rt, "api")
		// A jar: cookies stored from several pages, plus foreign entries.
		var jar []string
		for i := rapid.IntRange(0, 5).Draw(rt, "n"); i > 0; i-- {
			if sc, ok := ParseSetCookie(drawCookieString(rt)); ok {
				if c, ok := StoreCookie(false, rapid.SampledFrom(cookieURLs).Draw(rt, "setAt"), sc); ok && !c.HTTPOnly {
					jar = append(jar, c.WireName()+"="+c.WireValue())
				}
			}
		}
		jar = append(jar, rapid.SampledFrom([]string{"other=1", "__crn!x!bad", "__crn!h!a.example!%2F!n=zz:1", "plain"}).Draw(rt, "foreign"))
		j := strings.Join(jar, "; ")
		page := rapid.SampledFrom(cookieURLs).Draw(rt, "url")
		want, _ := ask(rt, oracle, "cookies", flag(api, "api", "http"), page, j)
		if got := CookieString(SelectCookies(api, page, JarCookies(j))); got != want {
			rt.Fatalf("cookies for %s (api=%v) from %q:\n got  %q\n spec %q", page, api, j, got, want)
		}
	})
}

func TestSpecConformance_SameSite(t *testing.T) {
	oracle := specoracle.Need(t)
	for _, ss := range []byte{SameSiteNone, SameSiteLax, SameSiteStrict, SameSiteDefault} {
		for _, same := range []bool{true, false} {
			for _, nav := range []bool{true, false} {
				for _, top := range []bool{true, false} {
					for _, age := range []uint64{0, 119999, 120000, 120001, 999999999} {
						out, _, err := oracle.Ask("samesite", string(rune(ss)), flag(same, "same", "cross"), flag(nav, "nav", "other"), flag(top, "top", "other"), strconv.FormatUint(age, 10))
						if err != nil {
							t.Fatal(err)
						}
						if got := flag(SameSiteAllows(ss, same, nav, top, age), "yes", "no"); got != out {
							t.Errorf("SameSiteAllows(%c, same=%v, nav=%v, top=%v, age=%d) = %s, spec says %s", ss, same, nav, top, age, got, out)
						}
					}
				}
			}
		}
	}
}

// The context rules (spec Cookies storableIn, placedIn, inCtx).
func TestSpecConformance_CookieCtx(t *testing.T) {
	oracle := specoracle.Need(t)
	rapid.Check(t, func(rt *rapid.T) {
		top := rapid.SampledFrom([]string{"https://a.example", "http://b.example"}).Draw(rt, "top")
		cross := rapid.Bool().Draw(rt, "cross")
		x := CookieCtx{Top: top, Cross: cross}
		s := "n=v" + strings.Join(rapid.SliceOfN(rapid.SampledFrom([]string{"; Secure", "; Partitioned", "; partitioned=x", "; SameSite=None", "; SameSite=Lax", "; SameSite=Strict", "; HttpOnly"}), 0, 4).Draw(rt, "attrs"), "")
		want, _ := ask(rt, oracle, "storable", top, flag(cross, "cross", "same"), s)
		sc, _ := ParseSetCookie(s)
		got := "refused"
		if StorableIn(x, sc) {
			got = "-"
			if c := PlacedIn(x, sc, StoredCookie{}); c.Partitioned {
				got = c.PartitionKey
			}
		}
		if got != want {
			rt.Fatalf("storable(%v, %q) = %q, spec %q", x, s, got, want)
		}
		script := rapid.Bool().Draw(rt, "script")
		pk := rapid.SampledFrom([]string{"-", "https://a.example", "https://a.example^", "http://b.example"}).Draw(rt, "pk")
		ss := rapid.SampledFrom([]string{"n", "l", "t", "u"}).Draw(rt, "ss")
		wantIn, _ := ask(rt, oracle, "inctx", flag(script, "script", "http"), top, flag(cross, "cross", "same"), pk, ss)
		c := StoredCookie{SameSite: ss[0], Partitioned: pk != "-"}
		if pk != "-" {
			c.PartitionKey = pk
		}
		if gotIn := flag(InCtx(script, x, c), "yes", "no"); gotIn != wantIn {
			rt.Fatalf("inctx(%v, %v, %+v) = %s, spec %s", script, x, c, gotIn, wantIn)
		}
	})
}

func TestSpecConformance_ClearSiteData(t *testing.T) {
	oracle := specoracle.Need(t)
	rapid.Check(t, func(rt *rapid.T) {
		tw := rapid.Bool().Draw(rt, "trustworthy")
		v := strings.Join(rapid.SliceOfN(rapid.SampledFrom([]string{`"cookies"`, ` "cookies" `, "\t\"*\"", `cookies`, `"storage"`, `"cache"`, `"Cookies"`, `""`, `"`, ``, ` `, `"cookies`, `x"cookies"`}), 0, 4).Draw(rt, "items"), ",")
		want, _ := ask(rt, oracle, "clearsitedata", flag(tw, "yes", "no"), v)
		if got := flag(ClearsCookies(tw, v), "yes", "no"); got != want {
			rt.Fatalf("ClearsCookies(%v, %q) = %s, spec %s", tw, v, got, want)
		}
	})
}

func TestSpecConformance_ElementCookies(t *testing.T) {
	oracle := specoracle.Need(t)
	for _, cors := range []bool{true, false} {
		for _, cred := range []bool{true, false} {
			for _, same := range []bool{true, false} {
				want, _, err := oracle.Ask("elemcookies", flag(cors, "cors", "other"), flag(cred, "cred", "plain"), flag(same, "same", "cross"))
				if err != nil {
					t.Fatal(err)
				}
				if got := flag(ElementCookies(cors, cred, same), "yes", "no"); got != want {
					t.Errorf("ElementCookies(%v, %v, %v) = %s, spec %s", cors, cred, same, got, want)
				}
			}
		}
	}
}

func TestSpecConformance_MarkedCookies(t *testing.T) {
	oracle := specoracle.Need(t)
	for _, anon := range []bool{true, false} {
		for _, cors := range []bool{true, false} {
			for _, cred := range []bool{true, false} {
				for _, same := range []bool{true, false} {
					want, _, err := oracle.Ask("markedcookies", flag(anon, "anon", "other"), flag(cors, "cors", "other"), flag(cred, "cred", "plain"), flag(same, "same", "cross"))
					if err != nil {
						t.Fatal(err)
					}
					if got := flag(MarkedCookies(anon, cors, cred, same), "yes", "no"); got != want {
						t.Errorf("MarkedCookies(%v, %v, %v, %v) = %s, spec %s", anon, cors, cred, same, got, want)
					}
				}
			}
		}
	}
}
