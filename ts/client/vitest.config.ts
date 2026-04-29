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
        environment: "happy-dom",
        globals: true,
        include: ["tests/**/*.test.ts"],
    },
});
