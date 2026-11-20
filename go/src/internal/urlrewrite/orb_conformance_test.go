package urlrewrite

// Conformance of OrbBlocks / ProxyOrbBlocks with spec/Orb.agda, asked live
// (the spec against Chromium: ts/client/tests/spec/orb-vs-chromium).

import (
	"strings"
	"testing"

	"github.com/yovico/cyrano/internal/specoracle"
	"pgregory.net/rapid"
)

var orbTypes = []string{"-", "", "foo", ";", "text/plain", "TEXT/Plain; charset=utf-8", "application/json", "text/html", "text/xml",
	"application/octet-stream", "application/javascript", "text/css", "text/vtt", "application/dash+xml", "application/pdf",
	"application/zip", "text/csv", "image/png", "video/mp4", "audio/mpeg", "text/plain, application/pdf", "application/pdf, text/plain",
	"*/*", "application/x-protobuf", "text/event-stream"}

var orbPieces = []string{" ", "\n", "\t", "\r", "\v", "<!-- c -->", "<!--", "-->", "<p", "<P>", "<!doctype html", "<!DOCTYPE HTML>",
	"<script", "<b", "<x>", "<?xml", "<?XML", "{", "}", "\"k\"", "\"a\\\"b\"", "\\", ":", "1", ")]}'", "{}&&", "{} &&", "&&", "a", "[", "\""}

func TestSpecConformance_Orb(t *testing.T) {
	oracle := specoracle.Need(t)
	rapid.Check(t, func(rt *rapid.T) {
		ct := rapid.SampledFrom(orbTypes).Draw(rt, "ct")
		pad := rapid.SampledFrom([]int{0, 0, 0, 1010, 1018, 1020, 1022, 1030}).Draw(rt, "pad")
		body := strings.Repeat(" ", pad) + strings.Join(rapid.SliceOfN(rapid.SampledFrom(orbPieces), 0, 7).Draw(rt, "pieces"), "")
		cross := rapid.Bool().Draw(rt, "cross")
		acao := rapid.Bool().Draw(rt, "acao")
		redirect := rapid.Bool().Draw(rt, "redirect")
		b := func(x bool) string {
			if x {
				return "1"
			}
			return "0"
		}
		want, _, err := oracle.Ask("orbblocks", ct, body)
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		hasCT := ct != "-"
		if got := OrbBlocks(ct, hasCT, []byte(body)); (got && want != "yes") || (!got && want != "no") {
			rt.Fatalf("OrbBlocks(%q, %q) = %v, spec %s", ct, body, got, want)
		}
		wantP, _, err := oracle.Ask("orbproxy", b(cross), b(redirect), ct, b(acao), body)
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		if got := ProxyOrbBlocks(cross, redirect, ct, hasCT, acao, []byte(body)); (got && wantP != "yes") || (!got && wantP != "no") {
			rt.Fatalf("ProxyOrbBlocks(%v, redirect %v, %q, acao %v, %q) = %v, spec %s", cross, redirect, ct, acao, body, got, wantP)
		}
	})
}
