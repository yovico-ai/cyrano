package htmlrewrite

import (
	"os"
	"strings"
	"testing"
)

// The server's bootstrap guard is the client's, character for character
// (ts/client/src/runtime/bootstrap-html.ts FAIL_CLOSED; its behaviour in
// Chromium: tests/native/fail-closed-vs-chromium).
func TestFailClosedSameInBothRuntimes(t *testing.T) {
	b, err := os.ReadFile("../../../../ts/client/src/runtime/bootstrap-html.ts")
	if err != nil {
		t.Skip("client source not found:", err)
	}
	if !strings.Contains(string(b), "export const FAIL_CLOSED = '"+FailClosed+"';") {
		t.Errorf("the client's FAIL_CLOSED is not the server's:\n%s", FailClosed)
	}
}
