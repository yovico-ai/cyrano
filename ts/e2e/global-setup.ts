import { writeFile } from "node:fs/promises";
import { FIXTURE_PORT } from "./playwright.config.ts";
import { startFixtureServer } from "./fixture-server.ts";

export default async function globalSetup() {
    const server = await startFixtureServer(FIXTURE_PORT);
    // Store the server on the global so globalTeardown can close it.
    (globalThis as any).__e2eFixtureServer = server;
    // Write the port so tests can read it if needed.
    await writeFile("/tmp/cyrano-e2e-fixture-port", String(FIXTURE_PORT));
    console.log(`[e2e] fixture server listening on 127.0.0.1:${FIXTURE_PORT}`);
}
