# The Agda spec (spec/) compiles to the oracle that the Go and TS
# conformance tests ask (spec-oracle skill, yovico-ai/agda-guardrails).
# Run inside `nix develop` (Agda 2.8 + stdlib, GHC), or prefix with it:
#   env -u LD_LIBRARY_PATH nix develop --command make spec-check

.PHONY: typecheck oracle spec-check browser-check

AGDA ?= agda
SAFE_MODULES := Scheme Url Containment Srcset Referrer Cookies Oracle
ORACLE := $(CURDIR)/spec/build/Main

# Every rule module is checked under --safe on its own; Main.agda (the IO
# boundary, one FFI call) is checked last without it.
typecheck:
	cd spec && for m in $(SAFE_MODULES); do $(AGDA) --safe $$m.agda || exit 1; done
	cd spec && $(AGDA) Main.agda

# -O0: the oracle answers a few thousand one-line queries per run; GHC
# optimisation buys nothing here and costs most of the build time.
oracle: typecheck
	cd spec && $(AGDA) --compile --ghc-flag=-O0 --compile-dir=build Main.agda
	@# GHC skips relinking when nothing changed; the tests judge staleness by
	@# mtime, so mark the oracle as current for the spec just checked.
	touch $(ORACLE)

# The conformance tests refuse to skip here: the oracle must exist.
spec-check: oracle
	cd go/src && CYRANO_ORACLE=$(ORACLE) CYRANO_REQUIRE_ORACLE=1 \
		go test ./internal/urlrewrite ./internal/htmlrewrite -run SpecConformance -count=1 -rapid.checks=1000
	cd ts/client && CYRANO_ORACLE=$(ORACLE) CYRANO_REQUIRE_ORACLE=1 npx vitest run tests/spec

# The spec against a real browser: the spec's `direct` must equal headless
# Chromium's URL parser over generated inputs (Playwright from ts/e2e).
# And the native surface: with the runtime installed, every native member
# must read as on a clean page (tests/native/surface-vs-chromium.test.ts).
browser-check: oracle
	cd ts/client && npm run build
	cd ts/client && CYRANO_ORACLE=$(ORACLE) CYRANO_REQUIRE_ORACLE=1 CYRANO_BROWSER=1 \
		npx vitest run tests/spec/spec-vs-chromium.test.ts tests/spec/cookies-vs-chromium.test.ts tests/native
