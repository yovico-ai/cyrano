package htmlrewrite

import (
	"encoding/json"
	"fmt"
)

// bootstrapScript returns the literal HTML to splice in just after <head>.
//
// Two synchronous scripts:
//
//  1. <script src="<rewriterJsPath>">   — loads the client runtime
//  2. inline <script>                   — calls $rewriter_init(window, config).inject(),
//                                         then immediately calls
//                                         $rewriter.set_location(originalURL) so
//                                         the runtime's base-URL state is correct
//                                         before any of the page's own inline
//                                         scripts run.
//
// Both reference the single public origin (cfg.Proxy.PublicURL).
//
// The set_location call MUST be inline (not in a separate <script src=…>).
// The page's own inline scripts run
// strictly between the HTML parser hitting them and the async script
// returning. If they create resources with relative URLs (Cloudflare's
// /cdn-cgi/challenge-platform/... is the canonical example), the prototype-
// patched setters resolve those relatives against the *default* base URL
// (the proxy origin), producing on-proxy URLs that bypass the rewriter.
// Inlining makes set_location run at the right moment in the parser.
func bootstrapScript(cfg *Config) string {
	configJSON, err := json.Marshal(cfg.ClientPassthrough)
	if err != nil {
		// ClientPassthrough is a plain map; marshal can't fail in practice.
		// Fall back to {} and keep going rather than blow up the response.
		configJSON = []byte(`{}`)
	}

	originalURLLit := jsStringLiteral(cfg.BaseURL.String())

	cookieCall := ""
	if len(cfg.PageCookies) > 0 {
		cookiesJSON, jerr := json.Marshal(cfg.PageCookies)
		if jerr != nil {
			cookiesJSON = []byte(`[]`)
		}
		cookieCall = `$rewriter.set_cookies(` + string(cookiesJSON) + `);`
	}

	return fmt.Sprintf(
		`<script src="%s"></script>`+
			`<script>window.$rewriter=window.$rewriter_init(window,%s).inject();`+
			`$rewriter.set_location(%s);`+
			`%s`+
			`document.currentScript.remove();</script>`,
		cfg.RewriterJSPath,
		string(configJSON),
		string(originalURLLit),
		cookieCall,
	)
}

// jsStringLiteral renders s as a double-quoted JS string with the minimum
// set of escapes needed to make any byte sequence safe inside an HTML
// `<script>` block. Includes the `</` → `<\/` escape so a target URL
// containing those characters can't end the script element prematurely.
func jsStringLiteral(s string) []byte {
	out := make([]byte, 0, len(s)+2)
	out = append(out, '"')
	for i := 0; i < len(s); i++ {
		c := s[i]
		// Defang `</` and `<!--` so the string can't break out of <script>.
		if c == '<' && i+1 < len(s) && (s[i+1] == '/' || s[i+1] == '!') {
			out = append(out, '\\', '<')
			continue
		}
		switch c {
		case '\\', '"':
			out = append(out, '\\', c)
		case '\n':
			out = append(out, '\\', 'n')
		case '\r':
			out = append(out, '\\', 'r')
		case '\t':
			out = append(out, '\\', 't')
		default:
			if c < 0x20 {
				out = append(out, '\\', 'u', '0', '0',
					hexDigit(c>>4), hexDigit(c&0xf))
			} else {
				out = append(out, c)
			}
		}
	}
	out = append(out, '"')
	return out
}

func hexDigit(b byte) byte {
	if b < 10 {
		return '0' + b
	}
	return 'a' + b - 10
}
