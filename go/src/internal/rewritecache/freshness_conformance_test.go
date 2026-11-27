package rewritecache

// Conformance of FreshnessOf and BrowserCC with spec/Freshness.agda.

import (
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/yovico/cyrano/internal/specoracle"
	"pgregory.net/rapid"
)

func genCC(t *rapid.T) string {
	n := rapid.IntRange(0, 4).Draw(t, "n")
	parts := make([]string, n)
	for i := range parts {
		parts[i] = rapid.SampledFrom([]string{
			"max-age=60", "Max-Age=3600", "max-age=x", "max-age=", "max-age", "max-age=\"120\"", "s-maxage=99",
			"no-store", "NO-CACHE", "no-cache=\"set-cookie\"", "private=\"a, no-store\"", "public", "immutable",
			"must-revalidate", "", " ", "max-age=31536000", "=5", "max-age = 7",
		}).Draw(t, "d")
	}
	return strings.Join(parts, rapid.SampledFrom([]string{",", ", ", " ,"}).Draw(t, "sep"))
}

func TestMain(m *testing.M) {
	specoracle.Main(m, []string{"http", "https", "ws", "wss"})
}

func optArg(n int64) string {
	if n < 0 {
		return "-"
	}
	return strconv.FormatInt(n, 10)
}

func TestSpecConformance_Freshness(t *testing.T) {
	oracle := specoracle.Need(t)
	rapid.Check(t, func(rt *rapid.T) {
		cc := genCC(rt)
		e := rapid.SampledFrom([]int64{-1, 0, 300, 86400}).Draw(rt, "expires")
		lm := rapid.SampledFrom([]int64{-1, 0, 9, 1000, 864000}).Draw(rt, "lm")
		age := rapid.SampledFrom([]int64{0, 10, 100000}).Draw(rt, "age")
		since := rapid.SampledFrom([]int64{0, 5, 70}).Draw(rt, "since")
		capS := rapid.SampledFrom([]int64{0, 60, 3600}).Draw(rt, "cap")
		args := []string{cc, optArg(e), optArg(lm), strconv.FormatInt(age, 10), strconv.FormatInt(since, 10)}
		want, _, err := oracle.Ask("freshness", args...)
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		f := FreshnessOf(cc, e, lm, age, since)
		got := "nostore"
		if !f.NoStore {
			nc := "0"
			if f.NoCache {
				nc = "1"
			}
			got = nc + " " + strconv.FormatInt(int64(f.Left/time.Second), 10)
		}
		if got != want {
			rt.Fatalf("freshness%q: got %q, spec %q", args, got, want)
		}
		wantCC, _, err := oracle.Ask("browsercc", append(args, strconv.FormatInt(capS, 10))...)
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		gotCC := BrowserCC(f, time.Duration(capS)*time.Second)
		if gotCC == "" {
			gotCC = "keep"
		}
		if gotCC != wantCC {
			rt.Fatalf("browsercc%q cap %d: got %q, spec %q", args, capS, gotCC, wantCC)
		}
	})
}
