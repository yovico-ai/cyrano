package server

import (
	"net/http"

	"github.com/yovico/cyrano/internal/config"
)

// cookiesJSONHandler serves /cookies.json?p=<b64(url[,url2,...])>.
//
// The client's $rewriter.fetch_cookies(elem) and process_server_cookies()
// hit this endpoint to ask the proxy for cookies that apply to specific
// resource URLs. Cookie storage is in-memory (roadmap: persistent backend).
func cookiesJSONHandler(vhost *config.VHost) http.HandlerFunc {
	_ = vhost
	return func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte("[]"))
	}
}

// jsStringLiteral wraps s in double-quotes with JS-safe escapes. Avoids
// pulling in encoding/json just for this hot-path single-string case.
func jsStringLiteral(s string) []byte {
	out := make([]byte, 0, len(s)+2)
	out = append(out, '"')
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch c {
		case '\\', '"':
			out = append(out, '\\', c)
		case '\n':
			out = append(out, '\\', 'n')
		case '\r':
			out = append(out, '\\', 'r')
		case '\t':
			out = append(out, '\\', 't')
		case '\b':
			out = append(out, '\\', 'b')
		case '\f':
			out = append(out, '\\', 'f')
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
