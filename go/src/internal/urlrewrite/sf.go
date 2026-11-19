package urlrewrite

// RFC 8941 Structured Field Values — lists and dictionaries, as spec/Sf.agda
// reads them: parameters read and dropped, a number's lengths unchecked.
// Used for Accept-CH (proxy/client_hints.go) and Permissions-Policy
// (permissions.go).

import "strings"

// SFKind is a bare item's kind.
type SFKind byte

const (
	SFToken  SFKind = 't'
	SFString SFKind = 's'
	SFOther  SFKind = 'o' // a number, a boolean, a byte sequence
)

// SFItem is a bare item: a token's or a string's text (escapes undone).
type SFItem struct {
	Kind SFKind
	Text string
}

// SFMember is a list or dictionary member: one item, or an inner list's.
type SFMember struct {
	Inner bool
	Items []SFItem
}

// SFEntry is a dictionary member.
type SFEntry struct {
	Key   string
	Value SFMember
}

func sfTchar(c byte) bool {
	return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.IndexByte("!#$%&'*+-.^_`|~", c) >= 0
}

func sfBare(s string) (SFItem, string, bool) {
	if s == "" {
		return SFItem{}, s, false
	}
	c := s[0]
	switch {
	case c == '-' || c >= '0' && c <= '9':
		i := 0
		if c == '-' {
			i = 1
		}
		j := i
		for j < len(s) && s[j] >= '0' && s[j] <= '9' {
			j++
		}
		if j == i {
			return SFItem{}, s, false
		}
		if j < len(s) && s[j] == '.' {
			k := j + 1
			for k < len(s) && s[k] >= '0' && s[k] <= '9' {
				k++
			}
			if k == j+1 {
				return SFItem{}, s, false
			}
			j = k
		}
		return SFItem{Kind: SFOther}, s[j:], true
	case c == '"':
		var b strings.Builder
		for i := 1; i < len(s); i++ {
			switch {
			case s[i] == '"':
				return SFItem{Kind: SFString, Text: b.String()}, s[i+1:], true
			case s[i] == '\\':
				if i+1 >= len(s) || (s[i+1] != '"' && s[i+1] != '\\') {
					return SFItem{}, s, false
				}
				i++
				b.WriteByte(s[i])
			case s[i] < 0x20 || s[i] > 0x7e:
				return SFItem{}, s, false
			default:
				b.WriteByte(s[i])
			}
		}
		return SFItem{}, s, false
	case c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c == '*':
		i := 1
		for i < len(s) && (sfTchar(s[i]) || s[i] == ':' || s[i] == '/') {
			i++
		}
		return SFItem{Kind: SFToken, Text: s[:i]}, s[i:], true
	case c == ':':
		i := 1
		for i < len(s) && (s[i] >= 'a' && s[i] <= 'z' || s[i] >= 'A' && s[i] <= 'Z' || s[i] >= '0' && s[i] <= '9' || s[i] == '+' || s[i] == '/' || s[i] == '=') {
			i++
		}
		if i < len(s) && s[i] == ':' {
			return SFItem{Kind: SFOther}, s[i+1:], true
		}
		return SFItem{}, s, false
	case c == '?':
		if len(s) >= 2 && (s[1] == '0' || s[1] == '1') {
			return SFItem{Kind: SFOther}, s[2:], true
		}
	}
	return SFItem{}, s, false
}

func sfKeyStart(c byte) bool { return c >= 'a' && c <= 'z' || c == '*' }
func sfKeyChar(c byte) bool {
	return c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || strings.IndexByte("_-.*", c) >= 0
}

// sfParams skips parameters: *( ";" *SP key [ "=" bare ] ).
func sfParams(s string) (string, bool) {
	for len(s) > 0 && s[0] == ';' {
		s = strings.TrimLeft(s[1:], " ")
		if s == "" || !sfKeyStart(s[0]) {
			return s, false
		}
		i := 1
		for i < len(s) && sfKeyChar(s[i]) {
			i++
		}
		s = s[i:]
		if len(s) > 0 && s[0] == '=' {
			var ok bool
			if _, s, ok = sfBare(s[1:]); !ok {
				return s, false
			}
		}
	}
	return s, true
}

// sfInner reads an inner list after its "(".
func sfInner(s string) ([]SFItem, string, bool) {
	items := []SFItem{}
	for {
		t := strings.TrimLeft(s, " ")
		if t == "" {
			return nil, s, false
		}
		if t[0] == ')' {
			rest, ok := sfParams(t[1:])
			return items, rest, ok
		}
		if len(items) > 0 && len(t) == len(s) {
			return nil, s, false // items are separated by SP
		}
		b, rest, ok := sfBare(t)
		if !ok {
			return nil, s, false
		}
		if rest, ok = sfParams(rest); !ok {
			return nil, s, false
		}
		items = append(items, b)
		s = rest
	}
}

func sfMember(s string) (SFMember, string, bool) {
	if s != "" && s[0] == '(' {
		items, rest, ok := sfInner(s[1:])
		return SFMember{Inner: true, Items: items}, rest, ok
	}
	b, rest, ok := sfBare(s)
	if ok {
		rest, ok = sfParams(rest)
	}
	return SFMember{Items: []SFItem{b}}, rest, ok
}

// sfNext is the input after a member: "" at the end, else what follows
// its comma; ok false for anything else, or a trailing comma.
func sfNext(s string) (string, bool, bool) {
	s = strings.TrimLeft(s, " \t")
	if s == "" {
		return "", true, true
	}
	if s[0] != ',' {
		return "", false, false
	}
	s = strings.TrimLeft(s[1:], " \t")
	if s == "" {
		return "", false, false
	}
	return s, false, true
}

// SFList reads a list (§4.2.1).
func SFList(s string) ([]SFMember, bool) {
	s = strings.Trim(s, " ")
	var out []SFMember
	for s != "" {
		m, rest, ok := sfMember(s)
		if !ok {
			return nil, false
		}
		out = append(out, m)
		var end bool
		if s, end, ok = sfNext(rest); !ok {
			return nil, false
		} else if end {
			break
		}
	}
	return out, true
}

// SFDict reads a dictionary (§4.2.2): a key with no "=" is the boolean
// true; a key repeated takes the later value, in the earlier place.
func SFDict(s string) ([]SFEntry, bool) {
	s = strings.Trim(s, " ")
	var out []SFEntry
	for s != "" {
		if !sfKeyStart(s[0]) {
			return nil, false
		}
		i := 1
		for i < len(s) && sfKeyChar(s[i]) {
			i++
		}
		key, rest := s[:i], s[i:]
		var m SFMember
		ok := true
		if rest != "" && rest[0] == '=' {
			m, rest, ok = sfMember(rest[1:])
		} else {
			m = SFMember{Items: []SFItem{{Kind: SFOther}}}
			rest, ok = sfParams(rest)
		}
		if !ok {
			return nil, false
		}
		replaced := false
		for k := range out {
			if out[k].Key == key {
				out[k].Value, replaced = m, true
			}
		}
		if !replaced {
			out = append(out, SFEntry{key, m})
		}
		var end bool
		if s, end, ok = sfNext(rest); !ok {
			return nil, false
		} else if end {
			break
		}
	}
	return out, true
}
