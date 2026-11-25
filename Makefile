# The Agda spec (spec/) compiles to the oracle that the Go and TS
# conformance tests ask (spec-oracle skill, yovico-ai/agda-guardrails).
# Run inside `nix develop` (Agda 2.8 + stdlib, GHC), or prefix with it:
#   env -u LD_LIBRARY_PATH nix develop --command make spec-check

.PHONY: typecheck oracle spec-check browser-check chrome-check

AGDA ?= agda
SAFE_MODULES := Scheme Url Containment Srcset Referrer Cookies Fetch Csp Css Html ImportMap Attrs HtmlTok Link Disposition Refresh WsOrigin Carry Query Sf Hints Upgrades Permissions Allow Storage Metadata Dictionary Priority FetchLater WorkerSource DataUrl Speculation XmlDoc MixedContent Messaging Frames Stack H1 Eval LocalStore Route Features Selectors Orb Toolbar Payment ClearSiteData Auth Corp Encoding AdAuction ErrorEvents WebRtc JsUrl Canvas Preflight Oracle
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
		go test ./internal/urlrewrite ./internal/htmlrewrite ./internal/proxy ./internal/cssrewrite ./internal/server ./internal/upstream ./internal/headerorder -run SpecConformance -count=1 -rapid.checks=1000
	cd ts/client && CYRANO_ORACLE=$(ORACLE) CYRANO_REQUIRE_ORACLE=1 npx vitest run tests/spec

# The spec against a real browser: the spec's `direct` must equal headless
# Chromium's URL parser over generated inputs (Playwright from ts/e2e).
# And the native surface: with the runtime installed, every native member
# must read as on a clean page (tests/native/surface-vs-chromium.test.ts).
browser-check: oracle
	cd ts/client && npm run build
	cd ts/client && CYRANO_ORACLE=$(ORACLE) CYRANO_REQUIRE_ORACLE=1 CYRANO_BROWSER=1 \
		npx vitest run tests/spec/spec-vs-chromium.test.ts tests/spec/cookies-vs-chromium.test.ts tests/spec/fetch-vs-chromium.test.ts tests/spec/csp-vs-chromium.test.ts tests/spec/framing-vs-chromium.test.ts tests/spec/css-vs-chromium.test.ts tests/spec/html-vs-chromium.test.ts tests/spec/json-vs-chromium.test.ts tests/spec/attrs-vs-chromium.test.ts tests/spec/html-tok-vs-chromium.test.ts tests/spec/link-vs-chromium.test.ts tests/spec/refresh-vs-chromium.test.ts tests/spec/carry-vs-chromium.test.ts tests/spec/hints-vs-chromium.test.ts tests/spec/permissions-vs-chromium.test.ts tests/spec/allow-vs-chromium.test.ts tests/spec/storage-access-vs-chromium.test.ts tests/spec/metadata-vs-chromium.test.ts tests/spec/sniff-vs-chromium.test.ts tests/spec/policy-contexts-vs-chromium.test.ts tests/spec/post-message-vs-chromium.test.ts tests/spec/feature-policy-vs-chromium.test.ts tests/spec/selectors-vs-chromium.test.ts tests/spec/storage-partition-vs-chromium.test.ts tests/spec/dictionary-vs-chromium.test.ts tests/spec/priority-vs-chromium.test.ts tests/spec/fetch-later-vs-chromium.test.ts tests/spec/worker-source-vs-chromium.test.ts tests/spec/frame-origin-vs-chromium.test.ts tests/spec/stack-vs-chromium.test.ts tests/spec/no-scripts-vs-chromium.test.ts tests/spec/features-vs-chromium.test.ts tests/spec/quirks-sheets-vs-chromium.test.ts tests/spec/orb-vs-chromium.test.ts tests/spec/cookie-store-vs-chromium.test.ts tests/native

# Rules only real Chrome shows (Playwright's Chromium switches them off):
# needs Google Chrome and a display (headed; DISPLAY=:98 under Xvfb).
chrome-check: oracle
	cd ts/client && CYRANO_ORACLE=$(ORACLE) CYRANO_REQUIRE_ORACLE=1 CYRANO_CHROME=1 \
		npx vitest run tests/spec/upgrades-vs-chrome.test.ts tests/spec/cookie-store-vs-chromium.test.ts
