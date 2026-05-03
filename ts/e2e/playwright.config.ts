import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// The proxy binary must be running before Playwright starts.
// Run: /tmp/cyrano --assets ./go/assets --log-level warn
// Or use the helper script: ./go/scripts/run.sh
//
// The fixture server is started by globalSetup and its port is written to
// /tmp/cyrano-e2e-fixture-port so tests can read it.
const PROXY_ORIGIN = process.env.PROXY_ORIGIN ?? "http://localhost:9081";
const FIXTURE_PORT = parseInt(process.env.FIXTURE_PORT ?? "9090", 10);

export { PROXY_ORIGIN, FIXTURE_PORT };

export default defineConfig({
    testDir: resolve(__dirname, "tests"),
    timeout: 15_000,
    globalSetup: resolve(__dirname, "global-setup.ts"),
    globalTeardown: resolve(__dirname, "global-teardown.ts"),
    use: {
        baseURL: PROXY_ORIGIN,
        // Don't follow redirects automatically — some tests care about them.
        actionTimeout: 8_000,
    },
    projects: [
        {
            name: "chromium",
            use: { ...devices["Desktop Chrome"] },
        },
    ],
    reporter: [["list"], ["html", { open: "never" }]],
});
