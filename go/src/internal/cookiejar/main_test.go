package cookiejar

import (
	"testing"

	"github.com/yovico/cyrano/internal/specoracle"
)

// One oracle for the package's conformance tests (make oracle).
func TestMain(m *testing.M) { specoracle.Main(m, []string{"http", "https", "ws", "wss"}) }
