//go:build e2e

package e2e

import (
	"io"
	"net/http"
	"strings"
	"testing"

	"golang.org/x/text/encoding/charmap"
	"golang.org/x/text/encoding/japanese"
)

// A document in a declared legacy encoding (spec/Encoding.agda): rewritten
// as text and given back in its encoding. Its attribute URLs keep their
// query in the document's encoding (the browser's), a reference to a
// character the encoding lacks stays a reference (was: UTF-8 bytes, read
// as mojibake), its originals keep the page's text, and a Shift_JIS
// character whose trail byte is a backslash does not upset the script.
func TestE2E_LegacyEncodedDocument(t *testing.T) {
	cp1251, _ := charmap.Windows1251.NewEncoder().String(`<!doctype html><meta charset="windows-1251"><title>поиск</title>` +
		`<a id=a href="/p?q=поиск" title="&#252; и">x</a><img src="/i.png?q=ё" alt="&copy;">`)
	sjis, _ := japanese.ShiftJIS.NewEncoder().String(`<!doctype html><html><head><meta http-equiv="Content-Type" content="text/html; charset=Shift_JIS"></head>` +
		`<body><script>var s = "表示"; document.title = s + location.href;</script><a href="/k?q=表">k</a></body></html>`)
	up := startInlineServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		if strings.HasPrefix(r.URL.Path, "/sjis") {
			_, _ = io.WriteString(w, sjis)
			return
		}
		_, _ = io.WriteString(w, cp1251)
	})
	proxy := startProxy(t)

	_, body := getVia(t, proxy, up.URL+"/page")
	text, err := charmap.Windows1251.NewDecoder().String(body)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"/p?q=%EF%EE%E8%F1%EA", // поиск in windows-1251
		"/i.png?q=%B8",         // ё
		`title="&#252; и"`,     // ü is not in windows-1251: a reference again
		"<title>поиск</title>",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("windows-1251: missing %q in\n%.900s", want, text)
		}
	}
	if strings.Contains(text, "�") || strings.Contains(body, "\xc3\xbc") {
		t.Errorf("windows-1251: replacement characters or UTF-8 bytes in\n%.900s", text)
	}

	_, body = getVia(t, proxy, up.URL+"/sjis")
	text, err = japanese.ShiftJIS.NewDecoder().String(body)
	if err != nil {
		t.Fatal(err)
	}
	// (表's trail byte is "\\": not in the query percent-encode set, it stays)
	for _, want := range []string{`var s = "表示";`, "/k?q=%95\\"} {
		if !strings.Contains(text, want) {
			t.Errorf("shift_jis: missing %q in\n%.1200s", want, text)
		}
	}
}
