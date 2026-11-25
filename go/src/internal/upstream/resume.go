package upstream

import (
	tls "github.com/bogdanfinn/utls"

	"github.com/bogdanfinn/tls-client/profiles"
)

// withResumption is the profile with Chrome's pre_shared_key extension last
// in its ClientHello, so connections resume TLS sessions as Chrome's do.
//
// Chrome keeps the tickets a server issues and offers one on its next
// connection there (pre_shared_key, always the last extension; psk_dhe_ke
// only, no early data over TCP). tls-client's Chrome profiles list
// psk_key_exchange_modes but not pre_shared_key, and tls-client makes a
// client its session cache only when the profile's spec has that
// extension, so every upstream connection was a full handshake: a Chrome
// that never resumes, visible on every connection after the first, and a
// certificate chain sent and verified each time. With the extension
// present, a hello with no ticket to offer leaves it out (OmitEmptyPsk),
// exactly the profile's first hello; the random extension order keeps it
// last (utls ShuffleChromeTLSExtensions). The cache is the client's, so
// tickets stay within one session's one host (clientFor).
func withResumption(p profiles.ClientProfile) profiles.ClientProfile {
	id := p.GetClientHelloId()
	base := id.SpecFactory
	if base == nil {
		return p
	}
	id.SpecFactory = func() (tls.ClientHelloSpec, error) {
		spec, err := base()
		if err != nil {
			return spec, err
		}
		for _, e := range spec.Extensions {
			if _, ok := e.(*tls.UtlsPreSharedKeyExtension); ok {
				return spec, nil
			}
		}
		spec.Extensions = append(spec.Extensions, &tls.UtlsPreSharedKeyExtension{})
		return spec, nil
	}
	return profiles.NewClientProfile(id, p.GetSettings(), p.GetSettingsOrder(), p.GetPseudoHeaderOrder(),
		p.GetConnectionFlow(), p.GetPriorities(), p.GetHeaderPriority(), p.GetStreamID(), p.GetAllowHTTP(),
		p.GetHttp3Settings(), p.GetHttp3SettingsOrder(), p.GetHttp3PriorityParam(), p.GetHttp3PseudoHeaderOrder(),
		p.GetHttp3SendGreaseFrames())
}
