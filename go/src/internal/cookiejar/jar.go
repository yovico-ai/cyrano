// Package cookiejar is the server's cookie jar and the channel through the
// browser's own jar: a port of spec/CookieJar.agda (checked against it by
// conformance_test.go). TS: ts/client/src/cookies/jar.ts (the runtime's
// memory and the channel's reading).
//
// Every cookie of a session lives here, script-visible ones too, under
// Chromium's limits per registrable domain; the browser's jar carries only
// transient entries: outbox (a script's write, applied once) and inbox (a
// change scripts must see).
package cookiejar

import (
	"sort"
	"strconv"
	"strings"

	"github.com/yovico/cyrano/internal/urlrewrite"
)

// Expiry: a session cookie (Session) or one alive until Until (ms after
// the epoch, as Chromium reports an expiry).
type Expiry struct {
	Session bool
	Until   uint64
}

// Alive reports whether a cookie of this expiry is alive at now.
func (e Expiry) Alive(now uint64) bool { return e.Session || now < e.Until }

// Change is what the channel carries: a cookie set (until Expiry) or gone
// (only its identity counts).
type Change struct {
	Cookie urlrewrite.StoredCookie
	Gone   bool
	Expiry Expiry
}

// Numbered is a change of a generation (inbox) or a writer's number (outbox).
type Numbered struct {
	Change
	N uint64
}

// SameID: the RFC's identity — name, domain, path, host-only.
func SameID(a, b urlrewrite.StoredCookie) bool {
	return a.Name == b.Name && a.Domain == b.Domain && a.Path == b.Path && a.HostOnly == b.HostOnly
}

// Cap is Chromium's longest cookie life: 400 days, in ms.
const Cap = 400 * 86400 * 1000

// CapSeconds is the same in seconds (a Max-Age).
const CapSeconds = 400 * 86400

// ExpiryOf is a Set-Cookie's expiry at now, in ms (spec CookieJar.expiryOf): Max-Age
// before Expires, each capped at 400 days; ok false when it is already
// expired (a deletion).
func ExpiryOf(now uint64, sc urlrewrite.SetCookie) (Expiry, bool) {
	capped := func(t uint64) uint64 { return min(t, now+Cap) }
	byExpires := func() (Expiry, bool) {
		if sc.Expires == nil {
			return Expiry{Session: true}, true
		}
		t, ok := urlrewrite.CookieDate(*sc.Expires)
		if !ok {
			return Expiry{Session: true}, true
		}
		if t*1000 <= now {
			return Expiry{}, false
		}
		return Expiry{Until: capped(t * 1000)}, true
	}
	if sc.MaxAge == nil || *sc.MaxAge == "" {
		return byExpires()
	}
	m := *sc.MaxAge
	if m[0] == '-' {
		return Expiry{}, false
	}
	n, ok := natOf(m)
	if !ok {
		return byExpires()
	}
	if n == 0 {
		return Expiry{}, false
	}
	if n > CapSeconds {
		n = CapSeconds
	}
	return Expiry{Until: capped(now + n*1000)}, true
}

// natOf reads decimal digits (at least one), saturating.
func natOf(s string) (uint64, bool) {
	if s == "" {
		return 0, false
	}
	var n uint64
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return 0, false
		}
		if n > (1<<63)/10 {
			n = 1 << 63
		} else {
			n = n*10 + uint64(s[i]-'0')
		}
	}
	return n, true
}

// The channel's prefixes.
const (
	InboxPrefix  = "__crn~i!"
	OutboxPrefix = "__crn~o!"
)

func flagsOf(c urlrewrite.StoredCookie) string {
	s := "i"
	if c.Secure {
		s = "s"
	}
	return s + string(rune(c.SameSite)) + string(rune(c.Priority))
}

func expiryText(ch Change) string {
	switch {
	case ch.Gone:
		return "x"
	case ch.Expiry.Session:
		return ""
	}
	return strconv.FormatUint(ch.Expiry.Until, 10)
}

// ChanName is the channel entry's name for ch (inbox or outbox).
func ChanName(inbox bool, ch Change) string {
	p := OutboxPrefix
	if inbox {
		p = InboxPrefix
	}
	return p + ch.Cookie.Scope()
}

// ChanValue is its value: flags "!" expiry "!" n ["!" applied] ":" value.
func ChanValue(ch Change, n uint64, applied *uint64) string {
	v := ""
	if !ch.Gone {
		v = ch.Cookie.Value
	}
	ap := ""
	if applied != nil {
		ap = "!" + strconv.FormatUint(*applied, 10)
	}
	return flagsOf(ch.Cookie) + "!" + expiryText(ch) + "!" + strconv.FormatUint(n, 10) + ap + ":" + v
}

// Unchan reads a channel entry back: the change, its number and (inbox)
// the last outbox applied; ok false when it is none.
func Unchan(inbox bool, name, value string) (ch Change, n uint64, applied *uint64, ok bool) {
	p := OutboxPrefix
	if inbox {
		p = InboxPrefix
	}
	sc, has := strings.CutPrefix(name, p)
	if !has {
		return
	}
	ho, d, pa, nm, sok := urlrewrite.ParseScope(sc)
	if !sok {
		return
	}
	if len(value) < 4 || value[3] != '!' || (value[0] != 's' && value[0] != 'i') ||
		!strings.ContainsRune("nltu", rune(value[1])) || !strings.ContainsRune("LMH", rune(value[2])) {
		return
	}
	e, r, cut := strings.Cut(value[4:], "!")
	if !cut {
		return
	}
	nums, val, cut := strings.Cut(r, ":")
	if !cut {
		return
	}
	num, ap, hasAp := strings.Cut(nums, "!")
	k, kok := natOf(num)
	if !kok {
		return
	}
	if hasAp {
		a, aok := natOf(ap)
		if !aok {
			return
		}
		applied = &a
	}
	if inbox != hasAp {
		return Change{}, 0, nil, false
	}
	c := urlrewrite.StoredCookie{HostOnly: ho, Domain: d, Path: pa, Name: nm, Value: val, Secure: value[0] == 's',
		SameSite: value[1], Priority: value[2]}
	switch {
	case e == "x":
		ch = Change{Cookie: c, Gone: true}
	case e == "":
		ch = Change{Cookie: c, Expiry: Expiry{Session: true}}
	default:
		t, tok := natOf(e)
		if !tok {
			return Change{}, 0, nil, false
		}
		ch = Change{Cookie: c, Expiry: Expiry{Until: t}}
	}
	return ch, k, applied, true
}

// Entry is a cookie in the jar.
type Entry struct {
	Cookie   urlrewrite.StoredCookie
	Expiry   Expiry
	Site     string // registrable domain (or the host): the 180's key
	Created  uint64
	Accessed uint64 // ms: the once-a-minute threshold
	Order    uint64 // the jar's tick at the last access: the LRU order
}

// Jar is a session's cookies, in creation order.
type Jar struct {
	Entries []Entry
	Gen     uint64            // script-visible changes so far
	Applied map[string]uint64 // scope → the last outbox number applied
	Tick    uint64            // one more at every write and access (Chromium orders by µs access times)
}

// Chromium's limits (net/cookies/cookie_monster.h; measured).
const (
	DomainMax  = 180
	DomainKeep = 150
	TotalMax   = 3300
	TotalKeep  = 3000
)

func quotaOf(p byte) int {
	switch p {
	case urlrewrite.PriorityLow:
		return 30
	case urlrewrite.PriorityHigh:
		return 70
	}
	return 50
}

// byAccess sorts least recently accessed first, creation order kept.
func byAccess(es []Entry) []Entry {
	out := append([]Entry(nil), es...)
	sort.SliceStable(out, func(i, j int) bool { return out[i].Order < out[j].Order })
	return out
}

// purgeRound is Chromium's PurgeLeastRecentMatches (spec purgeRound).
func purgeRound(prio byte, protect bool, goal int, es []Entry) (keep, out []Entry) {
	total, secure := 0, 0
	for _, e := range es {
		if e.Cookie.Priority == prio {
			total++
			if e.Cookie.Secure {
				secure++
			}
		}
	}
	q := quotaOf(prio)
	if total <= q {
		return es, nil
	}
	possible := total - q
	if protect {
		possible = total - max(secure, q)
	}
	for _, e := range es {
		if possible > 0 && goal > 0 && e.Cookie.Priority == prio && (!protect || !e.Cookie.Secure) {
			out = append(out, e)
			possible--
			goal--
			continue
		}
		keep = append(keep, e)
	}
	return keep, out
}

var rounds = []struct {
	prio    byte
	protect bool
}{
	{urlrewrite.PriorityLow, true}, {urlrewrite.PriorityLow, false}, {urlrewrite.PriorityMedium, true},
	{urlrewrite.PriorityHigh, true}, {urlrewrite.PriorityMedium, false}, {urlrewrite.PriorityHigh, false},
}

func purgeSite(goal int, es []Entry) []Entry {
	r := byAccess(es)
	var out []Entry
	for _, rd := range rounds {
		if goal <= 0 {
			break
		}
		var o []Entry
		r, o = purgeRound(rd.prio, rd.protect, goal, r)
		out = append(out, o...)
		goal -= len(o)
	}
	return out
}

func without(es, out []Entry) []Entry {
	var keep []Entry
	for _, e := range es {
		gone := false
		for _, x := range out {
			if SameID(e.Cookie, x.Cookie) {
				gone = true
				break
			}
		}
		if !gone {
			keep = append(keep, e)
		}
	}
	return keep
}

func purgeTotal(goal int, es []Entry) []Entry {
	sorted := byAccess(es)
	var order []Entry
	for _, e := range sorted {
		if !e.Cookie.Secure {
			order = append(order, e)
		}
	}
	for _, e := range sorted {
		if e.Cookie.Secure {
			order = append(order, e)
		}
	}
	if goal > len(order) {
		goal = len(order)
	}
	return order[:goal]
}

// evict drops the expired and applies the site's and the session's limits
// after a cookie of site was stored (spec evict). Gives the entries kept
// and those removed.
func evict(now uint64, site string, es0 []Entry) (kept, removed []Entry) {
	var es, expired []Entry
	for _, e := range es0 {
		if e.Expiry.Alive(now) {
			es = append(es, e)
		} else {
			expired = append(expired, e)
		}
	}
	var ofSite []Entry
	for _, e := range es {
		if e.Site == site {
			ofSite = append(ofSite, e)
		}
	}
	kept = es
	if len(ofSite) > DomainMax {
		out := purgeSite(len(ofSite)-DomainKeep, ofSite)
		kept = without(es, out)
		removed = out
	}
	if len(kept) > TotalMax {
		out := purgeTotal(len(kept)-TotalKeep, kept)
		kept = without(kept, out)
		removed = append(append(removed, expired...), out...)
		return kept, removed
	}
	return kept, append(removed, expired...)
}

func (j *Jar) findLive(now uint64, c urlrewrite.StoredCookie) *Entry {
	for i := range j.Entries {
		if SameID(j.Entries[i].Cookie, c) && j.Entries[i].Expiry.Alive(now) {
			return &j.Entries[i]
		}
	}
	return nil
}

func dropID(es []Entry, c urlrewrite.StoredCookie) []Entry {
	var out []Entry
	for _, e := range es {
		if !SameID(e.Cookie, c) {
			out = append(out, e)
		}
	}
	return out
}

// Put stores ch at now for site (spec put). api: from a script — an HttpOnly
// cookie of the same identity then stands. Gives the changes scripts see,
// numbered by the jar's generation.
func (j *Jar) Put(api bool, now uint64, site string, ch Change) []Numbered {
	old := j.findLive(now, ch.Cookie)
	if old != nil && api && old.Cookie.HTTPOnly {
		return nil
	}
	wasVisible := old != nil && !old.Cookie.HTTPOnly
	var es []Entry
	var chs []Change
	c := ch.Cookie
	switch {
	case ch.Gone || !ch.Expiry.Alive(now):
		es = dropID(j.Entries, c)
		if wasVisible {
			chs = append(chs, Change{Cookie: c, Gone: true})
		}
	default:
		// An overwrite keeps the old creation (and place) when the value is
		// the same; with another value it is a new cookie, last (spec
		// replaceOrAdd; Chromium, measured).
		ne := Entry{Cookie: c, Expiry: ch.Expiry, Site: site, Created: now, Accessed: now, Order: j.Tick + 1}
		replaced, moved := false, false
		for _, e := range j.Entries {
			if !replaced && SameID(e.Cookie, c) {
				replaced = true
				if e.Cookie.Value == c.Value {
					ne.Created = e.Created
					es = append(es, ne)
				} else {
					moved = true
				}
				continue
			}
			es = append(es, e)
		}
		if !replaced || moved {
			es = append(es, ne)
		}
		if !c.HTTPOnly {
			chs = append(chs, ch)
		} else if wasVisible {
			chs = append(chs, Change{Cookie: c, Gone: true})
		}
	}
	j.Tick++
	kept, removed := evict(now, site, es)
	for _, e := range removed {
		if !e.Cookie.HTTPOnly {
			chs = append(chs, Change{Cookie: e.Cookie, Gone: true})
		}
	}
	j.Entries = kept
	out := make([]Numbered, len(chs))
	for i, x := range chs {
		j.Gen++
		out[i] = Numbered{x, j.Gen}
	}
	return out
}

// LastApplied is the last outbox number applied to the identity of c.
func (j *Jar) LastApplied(c urlrewrite.StoredCookie) uint64 { return j.Applied[c.Scope()] }

// ApplyOutbox applies an outbox entry numbered k by its writer, once and in
// order: one numbered no higher than the last applied is ignored.
func (j *Jar) ApplyOutbox(now uint64, site string, ch Change, k uint64) []Numbered {
	s := ch.Cookie.Scope()
	if k <= j.Applied[s] {
		return nil
	}
	out := j.Put(true, now, site, ch)
	if j.Applied == nil {
		j.Applied = map[string]uint64{}
	}
	j.Applied[s] = k
	return out
}

// Touch records that the cookies used reports were used at now (ms), at
// most once a minute each (Chromium's kLastAccessThreshold).
func (j *Jar) Touch(now uint64, used func(urlrewrite.StoredCookie) bool) {
	for i := range j.Entries {
		e := &j.Entries[i]
		if used(e.Cookie) && e.Accessed+60000 <= now {
			j.Tick++
			e.Accessed, e.Order = now, j.Tick
		}
	}
}

// EndSession drops the session cookies: the browser session ended.
func (j *Jar) EndSession() {
	var keep []Entry
	for _, e := range j.Entries {
		if !e.Expiry.Session {
			keep = append(keep, e)
		}
	}
	j.Entries = keep
}

// Created is when the live cookie of c's identity was made (ms), if any.
func (j *Jar) Created(now uint64, c urlrewrite.StoredCookie) (uint64, bool) {
	if e := j.findLive(now, c); e != nil {
		return e.Created, true
	}
	return 0, false
}

// Live is the jar's live cookies at now, in creation order.
func (j *Jar) Live(now uint64) []urlrewrite.StoredCookie {
	var out []urlrewrite.StoredCookie
	for _, e := range j.Entries {
		if e.Expiry.Alive(now) {
			out = append(out, e.Cookie)
		}
	}
	return out
}

// AckPrefix names a writer's ack: the highest outbox number the server read.
const AckPrefix = "__crn~a!"

// SepEsc percent-encodes "%", "~" and "*" (spec sepEsc): a record of a slot.
func SepEsc(s string) string {
	r := strings.NewReplacer("%", "%25", "~", "%7E", "*", "%2A")
	return r.Replace(s)
}

// SepUnesc reads SepEsc back (spec sepUnesc).
func SepUnesc(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '%' && i+2 < len(s) {
			switch {
			case s[i+1] == '2' && s[i+2] == '5':
				b.WriteByte('%')
				i += 2
				continue
			case s[i+1] == '7' && (s[i+2] == 'E' || s[i+2] == 'e'):
				b.WriteByte('~')
				i += 2
				continue
			case s[i+1] == '2' && (s[i+2] == 'A' || s[i+2] == 'a'):
				b.WriteByte('*')
				i += 2
				continue
			}
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

// PackSlot writes records (one-write outbox entries' names and values) as
// one slot's value (spec packSlot).
func PackSlot(records [][2]string) string {
	parts := make([]string, len(records))
	for i, r := range records {
		parts[i] = SepEsc(r[0]) + "*" + SepEsc(r[1])
	}
	return strings.Join(parts, "~")
}

// UnpackSlot reads a slot's value back (spec unpackSlot).
func UnpackSlot(v string) [][2]string {
	var out [][2]string
	for _, r := range strings.Split(v, "~") {
		n, val, _ := strings.Cut(r, "*")
		out = append(out, [2]string{SepUnesc(n), SepUnesc(val)})
	}
	return out
}

// OutboxOf reads the writes a slot carries (spec outboxOf, one slot).
func OutboxOf(slotValue string) []Numbered {
	var out []Numbered
	for _, r := range UnpackSlot(slotValue) {
		if ch, k, ap, ok := Unchan(false, r[0], r[1]); ok && ap == nil {
			out = append(out, Numbered{ch, k})
		}
	}
	return out
}

// InboxFor reports whether a change of a cookie of site is told to the
// browser as an inbox entry (spec inboxFor): on a response to a page of that
// same site; with no page known, or on a document's own response (a
// download, a frame sent to JSON: no snapshot comes with it), when it is
// the response's own site (targetSite).
func InboxFor(document bool, requesterSite *string, targetSite, site string) bool {
	if requesterSite == nil || document {
		return targetSite == site
	}
	return *requesterSite == site
}
