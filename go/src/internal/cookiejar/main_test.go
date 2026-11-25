package cookiejar

import (
	"testing"

	"github.com/yovico/cyrano/internal/specoracle"
)

// One oracle for the package's conformance tests (make oracle).
func TestMain(m *testing.M) { specoracle.Main(m, []string{"http", "https", "ws", "wss"}) }

// A jar written in ms (before 2026-11-25) is read as µs.
func TestToMicro(t *testing.T) {
	j := Jar{Entries: []Entry{{Expiry: Expiry{Until: 1795000123456}, Created: 1795000000000, Accessed: 1795000000001}, {Expiry: Expiry{Session: true}, Created: 5}}}
	j.ToMicro()
	if e := j.Entries[0]; e.Expiry.Until != 1795000123456000 || e.Created != 1795000000000000 || e.Accessed != 1795000000001000 {
		t.Fatalf("ToMicro: %+v", e)
	}
	if e := j.Entries[1]; !e.Expiry.Session || e.Expiry.Until != 0 || e.Created != 5000 {
		t.Fatalf("ToMicro session: %+v", e)
	}
	if MsText(1795000123456749) != "1795000123456.749" || MsText(1795000123456500) != "1795000123456.5" || MsText(1795000123456000) != "1795000123456" {
		t.Fatal("MsText")
	}
}
