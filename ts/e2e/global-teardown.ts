import { stopFixtureServer } from "./fixture-server.ts";

export default async function globalTeardown() {
    const server = (globalThis as any).__e2eFixtureServer;
    if (server) await stopFixtureServer(server);
}
