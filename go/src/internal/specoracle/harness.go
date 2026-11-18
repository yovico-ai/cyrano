package specoracle

import (
	"fmt"
	"os"
	"slices"
	"testing"
)

var shared *Client

// Main is TestMain for a package with conformance tests: one oracle
// process for the whole package, its vocabulary checked before any test
// runs. Without an oracle the conformance tests skip, with a note — or,
// under CYRANO_REQUIRE_ORACLE (make spec-check), the run fails.
func Main(m *testing.M, schemes []string) {
	path, skip := Locate()
	if skip != "" {
		if Required() {
			fmt.Fprintln(os.Stderr, skip)
			os.Exit(1)
		}
		fmt.Fprintln(os.Stderr, skip+": conformance tests skipped")
		os.Exit(m.Run())
	}
	c, err := Start(path)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if err := CheckSchemes(c, schemes); err != nil {
		c.Close()
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	shared = c
	code := m.Run()
	c.Close()
	os.Exit(code)
}

// Need returns the package's oracle, or skips the test when there is none.
func Need(t *testing.T) *Client {
	t.Helper()
	if shared == nil {
		t.Skip("spec oracle not built (make oracle)")
	}
	return shared
}

// CheckSchemes compares the implementation's list of proxified schemes
// with the spec's. The two are hand-kept in two languages; a comment
// saying they match is not evidence.
func CheckSchemes(c *Client, impl []string) error {
	spec, err := c.Schemes()
	if err != nil {
		return fmt.Errorf("oracle vocabulary: %w", err)
	}
	a := slices.Clone(spec)
	b := slices.Clone(impl)
	slices.Sort(a)
	slices.Sort(b)
	if !slices.Equal(a, b) {
		return fmt.Errorf("vocabulary drifted: spec proxifies %v, impl proxifies %v", spec, impl)
	}
	return nil
}
