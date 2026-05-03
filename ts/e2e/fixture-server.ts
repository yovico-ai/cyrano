// Minimal static file server for e2e fixtures.
// Serves testdata/e2e/fixtures/ and special endpoints.
//
// Used by global-setup.ts; not a test file.

import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createBrotliCompress } from "node:zlib";
import { Readable } from "node:stream";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, "../../testdata/e2e/fixtures");

const MIME: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js":   "application/javascript",
    ".json": "application/json",
    ".css":  "text/css",
};

function mime(path: string): string {
    return MIME[extname(path)] ?? "application/octet-stream";
}

export function startFixtureServer(port: number): Promise<Server> {
    return new Promise((resolve_p, reject) => {
        const server = createServer(async (req, res) => {
            const url = new URL(req.url ?? "/", "http://localhost");
            const path = url.pathname;

            try {
                // /brotli-page → brotli-decode.html, brotli-encoded.
                if (path === "/brotli-page") {
                    const src = await readFile(resolve(FIXTURES, "brotli-decode.html"));
                    res.setHeader("Content-Type", "text/html; charset=utf-8");
                    res.setHeader("Content-Encoding", "br");
                    const br = createBrotliCompress();
                    br.pipe(res);
                    br.end(src);
                    return;
                }

                // Akamai-shaped path with ?v=<UUID> — serve akamai-payload.js.
                if (/^\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(path) && url.searchParams.get("v")) {
                    const src = await readFile(resolve(FIXTURES, "akamai-payload.js"));
                    res.setHeader("Content-Type", "application/javascript");
                    res.end(src);
                    return;
                }

                // Static files from fixtures directory.
                const filePath = resolve(FIXTURES, path.replace(/^\//, ""));
                const src = await readFile(filePath);
                res.setHeader("Content-Type", mime(filePath));
                res.end(src);
            } catch (e: any) {
                if (e.code === "ENOENT") {
                    res.writeHead(404);
                    res.end("not found");
                } else {
                    res.writeHead(500);
                    res.end(String(e));
                }
            }
        });

        server.listen(port, "127.0.0.1", () => resolve_p(server));
        server.once("error", reject);
    });
}

export function stopFixtureServer(server: Server): Promise<void> {
    return new Promise((resolve_p, reject) => server.close(e => e ? reject(e) : resolve_p()));
}
