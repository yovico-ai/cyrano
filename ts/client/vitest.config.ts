// Vitest configuration. Kept separate from vite.config.ts so build and test
// concerns don't crosstalk — the build emits an IIFE bundle, the tests run
// individual modules under happy-dom.
//
// happy-dom is the default test environment because most of the runtime
// touches DOM APIs (document.cookie, prototype patches, location wrappers).
// Pure-JS tests can opt out per-file with `// @vitest-environment node`.

import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        // The spec conformance tests make hundreds of oracle round trips:
        // past the 5 s default when the suite runs in parallel under load.
        testTimeout: 30_000,
        environment: "happy-dom",
        globals: true,
        include: ["tests/**/*.test.ts"],
    },
});
