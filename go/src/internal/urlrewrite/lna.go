package urlrewrite

import "net"

// AddressSpace is an address's space for Local Network Access (spec/Lna.agda).
type AddressSpace int

const (
	SpaceLoopback AddressSpace = iota
	SpaceLocal
	SpacePublic
)

func (s AddressSpace) String() string {
	return [...]string{"loopback", "local", "public"}[s]
}

// SpaceOf is an IP address's space (spec Lna.space4 / space6): loopback
// 127/8 and ::1; local 10/8, 172.16/12, 192.168/16, 169.254/16, fc00::/7,
// fe80::/10; else public.
func SpaceOf(ip net.IP) AddressSpace {
	if v4 := ip.To4(); v4 != nil {
		a, b := v4[0], v4[1]
		switch {
		case a == 127:
			return SpaceLoopback
		case a == 10, a == 172 && b >= 16 && b <= 31, a == 192 && b == 168, a == 169 && b == 254:
			return SpaceLocal
		}
		return SpacePublic
	}
	if ip.Equal(net.IPv6loopback) {
		return SpaceLoopback
	}
	if len(ip) == net.IPv6len {
		g := uint16(ip[0])<<8 | uint16(ip[1])
		if (g >= 0xfc00 && g <= 0xfdff) || (g >= 0xfe80 && g <= 0xfebf) {
			return SpaceLocal
		}
	}
	return SpacePublic
}

// LNARefused: a request from a document of space doc to a target of space
// target (spec Lna.refused): a less public target, unless a navigation.
func LNARefused(doc, target AddressSpace, navigation bool) bool {
	return !navigation && target < doc
}
