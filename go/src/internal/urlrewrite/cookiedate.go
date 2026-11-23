package urlrewrite

// A cookie's Expires date as Chromium reads it: spec/CookieDate.agda
// (Chromium's ParseCookieExpirationTime, not RFC 6265bis §5.1.1), checked
// against the spec by cookiedate_conformance_test.go. TS:
// ts/client/src/cookies/date.ts.

import "strings"

func cookieDateDelimiter(c byte) bool {
	return c == '\t' || (c >= 32 && c <= 47) || (c >= 59 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126)
}

func isASCIIDigit(c byte) bool { return c >= '0' && c <= '9' }

// atoi: the value of the leading digits; ok false past 10 digits would
// overflow nothing that matters (tokens are at most 5 octets here).
func cookieAtoi(t string) uint64 {
	var n uint64
	for i := 0; i < len(t) && isASCIIDigit(t[i]); i++ {
		n = n*10 + uint64(t[i]-'0')
	}
	return n
}

// upTo2 reads %2u: 1 or 2 digits.
func upTo2(t string) (uint64, string, bool) {
	if len(t) == 0 || !isASCIIDigit(t[0]) {
		return 0, t, false
	}
	if len(t) >= 2 && isASCIIDigit(t[1]) {
		return uint64(t[0]-'0')*10 + uint64(t[1]-'0'), t[2:], true
	}
	return uint64(t[0] - '0'), t[1:], true
}

// cookieTime reads sscanf "%2u:%2u:%2u" == 3.
func cookieTime(t string) (h, m, s uint64, ok bool) {
	var r string
	if h, r, ok = upTo2(t); !ok || len(r) == 0 || r[0] != ':' {
		return 0, 0, 0, false
	}
	if m, r, ok = upTo2(r[1:]); !ok || len(r) == 0 || r[0] != ':' {
		return 0, 0, 0, false
	}
	if s, _, ok = upTo2(r[1:]); !ok {
		return 0, 0, 0, false
	}
	return h, m, s, true
}

var cookieMonths = [...]string{"jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"}

func cookieLeap(y uint64) bool { return y%4 == 0 && (y%100 != 0 || y%400 == 0) }

func cookieDaysIn(y, m uint64) uint64 {
	switch m {
	case 2:
		if cookieLeap(y) {
			return 29
		}
		return 28
	case 4, 6, 9, 11:
		return 30
	}
	return 31
}

func leapsTo(n uint64) uint64 { return n/4 - n/100 + n/400 }

// CookieDate is the instant an Expires value names, in seconds after the
// epoch (0 for one before it); ok false when it names none (the cookie is
// then a session cookie).
func CookieDate(s string) (secs uint64, ok bool) {
	var day, month, year, h, mi, sec uint64
	var haveDay, haveMonth, haveTime, haveYear bool
	for i := 0; i < len(s); {
		for i < len(s) && cookieDateDelimiter(s[i]) {
			i++
		}
		j := i
		for j < len(s) && !cookieDateDelimiter(s[j]) {
			j++
		}
		if j == i {
			break
		}
		t := s[i:j]
		i = j
		switch {
		case !isASCIIDigit(t[0]):
			if !haveMonth {
				for k, name := range cookieMonths {
					if len(t) >= 3 && strings.EqualFold(t[:3], name) {
						month, haveMonth = uint64(k+1), true
						break
					}
				}
			}
		case strings.IndexByte(t, ':') >= 0:
			if !haveTime {
				h, mi, sec, haveTime = cookieTime(t)
			}
		case !haveDay && len(t) <= 2:
			day, haveDay = cookieAtoi(t), true
		case !haveYear && len(t) <= 5:
			year, haveYear = cookieAtoi(t), true
		}
	}
	if !haveDay || !haveMonth || !haveTime || !haveYear {
		return 0, false
	}
	switch {
	case year >= 70 && year <= 99:
		year += 1900
	case year <= 69:
		year += 2000
	}
	if day < 1 || day > cookieDaysIn(year, month) || h > 23 || mi > 59 || sec > 59 {
		return 0, false
	}
	if year < 1970 {
		return 0, true
	}
	days := 365*(year-1970) + (leapsTo(year-1) - leapsTo(1969)) + day - 1
	for m := uint64(1); m < month; m++ {
		days += cookieDaysIn(year, m)
	}
	return days*86400 + h*3600 + mi*60 + sec, true
}
