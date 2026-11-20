package proxy

import (
	"net/http"
	"strings"
)

// Natively a response that varies on Origin is cached once per requesting
// origin; through the proxy every request is the proxy's own and carries
// no Origin, so one cached copy went to every page (bbc.com was handed
// bbc.co.uk's, failed the CORS check and sent the reader back). Where Vary
// lists Origin the browser is told Crn-I besides — the runtime's header
// naming the requesting page (patches/cors.ts), which differs where Origin
// would. Scripts read the origin's Vary (Crn-H). spec/Carry.agda
// varyForBrowser.

func varyLists(tok, v string) bool {
	for _, t := range strings.Split(v, ",") {
		if strings.EqualFold(strings.Trim(t, " \t"), tok) {
			return true
		}
	}
	return false
}

// varyForBrowser is the Vary (as combined) the browser is told.
func varyForBrowser(v string) string {
	if varyLists("origin", v) && !varyLists(InitiatorHeader, v) {
		return v + ", " + InitiatorHeader
	}
	return v
}

// varyOnInitiator adds Crn-I to a response's Vary where it varies on Origin.
func varyOnInitiator(h http.Header) {
	vs := h.Values("Vary")
	if len(vs) == 0 {
		return
	}
	if combined := strings.Join(vs, ", "); varyForBrowser(combined) != combined {
		h.Add("Vary", InitiatorHeader)
	}
}
