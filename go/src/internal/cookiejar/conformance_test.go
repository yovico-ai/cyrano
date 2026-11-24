package cookiejar

// Conformance with spec/CookieJar.agda, asked live: random scripts of jar
// operations, the jar and its inbox changes compared line for line; the
// channel's form both ways.

import (
	"fmt"
	"strconv"
	"strings"
	"testing"

	"github.com/yovico/cyrano/internal/specoracle"
	"github.com/yovico/cyrano/internal/urlrewrite"
	"pgregory.net/rapid"
)

const us = "\x1f"

var (
	jarURLs  = []string{"https://a.example/", "https://www.a.example/app/x", "http://a.example/", "https://b.example/p"}
	jarSites = map[string]string{"https://a.example/": "a.example", "https://www.a.example/app/x": "a.example", "http://a.example/": "a.example", "https://b.example/p": "b.example"}
	jarNames = []string{"sid", "a", "b", "__Host-h", "x"}
	jarAttrs = []string{"", "; Max-Age=60", "; Max-Age=0", "; Max-Age=-1", "; HttpOnly", "; Secure", "; Priority=Low", "; Priority=High",
		"; Domain=a.example", "; Path=/app", "; Expires=Wed, 21 Oct 2037 07:28:00 GMT", "; Expires=1 Jan 1999 0:0:0", "; SameSite=Lax"}
)

// apply runs one script line on the jar and gives its inbox lines.
func apply(j *Jar, line string) []string {
	f := strings.Split(line, us)
	var out []Numbered
	switch {
	case len(f) == 6 && f[0] == "put":
		now, _ := strconv.ParseUint(f[2], 10, 64)
		sc, ok := urlrewrite.ParseSetCookie(f[5])
		if !ok {
			return nil
		}
		c, ok := urlrewrite.StoreCookie(f[1] == "api", f[4], sc)
		if !ok {
			return nil
		}
		ch := Change{Cookie: c}
		if e, alive := ExpiryOf(now, sc); alive {
			ch.Expiry = e
		} else {
			ch.Gone = true
		}
		out = j.Put(f[1] == "api", now, f[3], ch)
	case len(f) == 5 && f[0] == "outbox":
		now, _ := strconv.ParseUint(f[1], 10, 64)
		ch, k, _, ok := Unchan(false, f[3], f[4])
		if !ok {
			return nil
		}
		out = j.ApplyOutbox(now, f[2], ch, k)
	case len(f) == 3 && f[0] == "touch":
		now, _ := strconv.ParseUint(f[1], 10, 64)
		j.Touch(now, func(c urlrewrite.StoredCookie) bool { return urlrewrite.MatchesURL(false, f[2], c) })
	case len(f) == 1 && f[0] == "end":
		j.EndSession()
	}
	var lines []string
	for _, n := range out {
		a := j.LastApplied(n.Cookie)
		lines = append(lines, "I"+us+ChanName(true, n.Change)+us+ChanValue(n.Change, n.N, &a))
	}
	return lines
}

func dump(j *Jar, inbox []string) string {
	var lines []string
	for _, e := range j.Entries {
		h := "-"
		if e.Cookie.HTTPOnly {
			h = "H"
		}
		ex := ""
		if !e.Expiry.Session {
			ex = strconv.FormatUint(e.Expiry.Until, 10)
		}
		lines = append(lines, strings.Join([]string{"E", e.Cookie.Scope(), flagsOf(e.Cookie) + h, ex,
			strconv.FormatUint(e.Created, 10), strconv.FormatUint(e.Accessed, 10), strconv.FormatUint(e.Order, 10), e.Site, e.Cookie.Value}, us))
	}
	lines = append(lines, "G"+us+strconv.FormatUint(j.Gen, 10))
	return strings.Join(append(lines, inbox...), "\n")
}

func TestSpecConformance_Jar(t *testing.T) {
	oracle := specoracle.Need(t)
	rapid.Check(t, func(rt *rapid.T) {
		now := uint64(1795000000000)
		var script []string
		for i, n := 0, rapid.IntRange(1, 25).Draw(rt, "ops"); i < n; i++ {
			now += uint64(rapid.SampledFrom([]int{0, 1, 30, 61, 120}).Draw(rt, "dt")) * 1000
			switch rapid.IntRange(0, 9).Draw(rt, "op") {
			case 0, 1, 2, 3, 4:
				u := rapid.SampledFrom(jarURLs).Draw(rt, "url")
				s := rapid.SampledFrom(jarNames).Draw(rt, "name") + "=" + rapid.SampledFrom([]string{"1", "2", "v w"}).Draw(rt, "value")
				for _, a := range rapid.SliceOfN(rapid.SampledFrom(jarAttrs), 0, 3).Draw(rt, "attrs") {
					s += a
				}
				script = append(script, strings.Join([]string{"put", rapid.SampledFrom([]string{"http", "api"}).Draw(rt, "src"), fmt.Sprint(now), jarSites[u], u, s}, us))
			case 5, 6:
				u := rapid.SampledFrom(jarURLs).Draw(rt, "ourl")
				sc, _ := urlrewrite.ParseSetCookie(rapid.SampledFrom(jarNames).Draw(rt, "oname") + "=o" + rapid.SampledFrom(jarAttrs[:8]).Draw(rt, "oattr"))
				c, ok := urlrewrite.StoreCookie(true, u, sc)
				if !ok {
					continue
				}
				ch := Change{Cookie: c, Expiry: Expiry{Session: true}}
				if rapid.Bool().Draw(rt, "ogone") {
					ch = Change{Cookie: c, Gone: true}
				}
				k := uint64(rapid.IntRange(1, 6).Draw(rt, "k"))
				script = append(script, strings.Join([]string{"outbox", fmt.Sprint(now), jarSites[u], ChanName(false, ch), ChanValue(ch, k, nil)}, us))
			case 7:
				script = append(script, strings.Join([]string{"touch", fmt.Sprint(now), rapid.SampledFrom(jarURLs).Draw(rt, "turl")}, us))
			case 8:
				script = append(script, "end")
			case 9:
				// A burst on one site, past its limit.
				u := rapid.SampledFrom(jarURLs[:2]).Draw(rt, "burl")
				for b, m := 0, rapid.IntRange(150, 200).Draw(rt, "burst"); b < m; b++ {
					attr := rapid.SampledFrom([]string{"", "; Secure", "; Priority=Low", "; Priority=High", "; Max-Age=999"}).Draw(rt, "battr")
					script = append(script, strings.Join([]string{"put", "http", fmt.Sprint(now + uint64(b)), jarSites[u], u, fmt.Sprintf("c%d=1%s", b, attr)}, us))
				}
				now += 200000
			}
		}
		want, _, err := oracle.Ask("jar", strings.Join(script, "\n"))
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		j := &Jar{}
		var inbox []string
		for _, l := range script {
			inbox = append(inbox, apply(j, l)...)
		}
		if got := dump(j, inbox); got != want {
			rt.Fatalf("script:\n%s\n\ngot:\n%s\n\nspec:\n%s", strings.ReplaceAll(strings.Join(script, "\n"), us, " | "),
				strings.ReplaceAll(got, us, " | "), strings.ReplaceAll(want, us, " | "))
		}
	})
}

func TestSpecConformance_Chan(t *testing.T) {
	oracle := specoracle.Need(t)
	rapid.Check(t, func(rt *rapid.T) {
		inbox := rapid.Bool().Draw(rt, "inbox")
		u := rapid.SampledFrom(jarURLs).Draw(rt, "url")
		s := rapid.SampledFrom(jarNames).Draw(rt, "name") + "=" + rapid.SampledFrom([]string{"1", "", "a:b!c", "é"}).Draw(rt, "v") +
			rapid.SampledFrom(jarAttrs).Draw(rt, "attr")
		e := rapid.SampledFrom([]string{"", "x", "1795000123456"}).Draw(rt, "exp")
		k := uint64(rapid.IntRange(0, 99).Draw(rt, "k"))
		ap := "-"
		var apn *uint64
		if inbox {
			a := uint64(rapid.IntRange(0, 9).Draw(rt, "ap"))
			apn, ap = &a, strconv.FormatUint(a, 10)
		}
		pk := rapid.SampledFrom([]string{"-", "-", "https://a.example", "https://a.example^", "http://h%x!.y"}).Draw(rt, "partition")
		args := []string{map[bool]string{true: "in", false: "out"}[inbox], u, s, e, strconv.FormatUint(k, 10), ap}
		if pk != "-" {
			args = append(args, pk)
		}
		want, _, err := oracle.Ask("chan", args...)
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		sc, ok := urlrewrite.ParseSetCookie(s)
		var c urlrewrite.StoredCookie
		if ok {
			c, ok = urlrewrite.StoreCookie(false, u, sc)
		}
		if !ok {
			if want != "null" && want != "" {
				rt.Fatalf("%q at %s: not stored here, spec %q", s, u, want)
			}
			return
		}
		if pk != "-" {
			c.Partitioned, c.PartitionKey = true, pk
		}
		ch := Change{Cookie: c}
		switch e {
		case "x":
			ch.Gone = true
		case "":
			ch.Expiry = Expiry{Session: true}
		default:
			ch.Expiry = Expiry{Until: 1795000123456}
		}
		name, value := ChanName(inbox, ch), ChanValue(ch, k, apn)
		if got := name + "\n" + value; got != want {
			rt.Fatalf("chan(%q at %s, %q) = %q, spec %q", s, u, e, got, want)
		}
		// And read back, by the spec and here.
		back, kb, ab, bok := Unchan(inbox, name, value)
		wantBack, _, _ := oracle.Ask("unchan", map[bool]string{true: "in", false: "out"}[inbox], name, value)
		if !bok || kb != k || (apn == nil) != (ab == nil) || (ab != nil && *ab != *apn) || !SameID(back.Cookie, c) || back.Gone != ch.Gone {
			rt.Fatalf("Unchan(%q, %q) = %+v %d %v %v; spec %q", name, value, back, kb, ab, bok, wantBack)
		}
		if wantBack == "null" {
			rt.Fatalf("spec cannot read back %q %q", name, value)
		}
	})
}

func TestSpecConformance_Slot(t *testing.T) {
	oracle := specoracle.Need(t)
	pieces := []string{"a", "%", "~", "*", "%25", "%7e", "!", ":", "é", "", "__crn~o!h!x!%2F!n"}
	rapid.Check(t, func(rt *rapid.T) {
		var recs [][2]string
		var args []string
		for i, n := 0, rapid.IntRange(1, 4).Draw(rt, "n"); i < n; i++ {
			a := strings.Join(rapid.SliceOfN(rapid.SampledFrom(pieces), 1, 4).Draw(rt, "a"), "")
			b := strings.Join(rapid.SliceOfN(rapid.SampledFrom(pieces), 0, 4).Draw(rt, "b"), "")
			recs = append(recs, [2]string{a, b})
			args = append(args, a, b)
		}
		packed := PackSlot(recs)
		want, _, err := oracle.Ask("pack", strings.Join(args, us))
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		if packed != want {
			rt.Fatalf("PackSlot(%q) = %q, spec %q", recs, packed, want)
		}
		back, _, _ := oracle.Ask("unpack", packed)
		var lines []string
		for _, r := range UnpackSlot(packed) {
			lines = append(lines, r[0]+us+r[1])
		}
		if got := strings.Join(lines, "\n"); got != back {
			rt.Fatalf("UnpackSlot(%q) = %q, spec %q", packed, got, back)
		}
		for i, r := range UnpackSlot(packed) {
			if r != recs[i] {
				rt.Fatalf("round trip of %q: %q", recs, UnpackSlot(packed))
			}
		}
	})
}
