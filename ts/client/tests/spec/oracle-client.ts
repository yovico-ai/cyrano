/// <reference types="node" />
// Drives the compiled Agda spec (spec/ at the repo root, built with
// `make oracle`) for the conformance tests. It transports requests and
// makes no decisions of its own: the answers are the spec's.
//
// Protocol (spec/Oracle.agda): one tab-separated request line in, one
// JSON line out. Mirrors go/src/internal/specoracle/client.go.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export interface Answer {
    kind: string;
    out: string;
}

/** Thrown for a URL the spec does not decide; a property skips that draw. */
export class OutOfModel extends Error {}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/**
 * The oracle to use, and why there is none (missing, or older than the
 * spec it was built from). Whether that skips or fails is the suite's
 * decision: CYRANO_REQUIRE_ORACLE (make spec-check) makes it fail.
 */
export function locateOracle(): { path: string; skip: string } {
    const path = process.env["CYRANO_ORACLE"] ?? join(repoRoot, "spec", "build", "Main");
    if (!existsSync(path)) return { path, skip: `spec oracle ${path} not built (make oracle)` };
    const built = statSync(path).mtimeMs;
    const specDir = join(repoRoot, "spec");
    for (const f of readdirSync(specDir)) {
        if (f.endsWith(".agda") && statSync(join(specDir, f)).mtimeMs > built) {
            return { path, skip: `spec oracle ${path} is older than ${f} (make oracle)` };
        }
    }
    return { path, skip: "" };
}

export const oracleRequired = (process.env["CYRANO_REQUIRE_ORACLE"] ?? "") !== "";

/** Every backslash, control and non-ASCII character as "\u{HEX}". */
export function escapeField(s: string): string {
    let out = "";
    for (const ch of s) {
        const cp = ch.codePointAt(0)!;
        out += ch === "\\" || cp < 0x20 || cp >= 0x7f ? `\\u{${cp.toString(16).toUpperCase()}}` : ch;
    }
    return out;
}

/**
 * ONE oracle process for the whole suite; requests are queued so replies
 * pair with requests in order on the single pipe pair.
 */
export class OracleClient {
    private readonly child: ChildProcessWithoutNullStreams;
    private readonly waiting: Array<(line: string | Error) => void> = [];
    private stderr = "";
    private closed = false;

    constructor(path: string) {
        // A nix-built binary links nix's glibc; an inherited LD_LIBRARY_PATH
        // can shadow it and the child dies at start-up. Strip it.
        const env = { ...process.env };
        delete env["LD_LIBRARY_PATH"];
        this.child = spawn(path, [], { env, stdio: ["pipe", "pipe", "pipe"] });
        this.child.stderr.on("data", (d: Buffer) => { this.stderr += d.toString(); });
        createInterface({ input: this.child.stdout }).on("line", (line) => {
            this.waiting.shift()?.(line);
        });
        this.child.on("exit", () => {
            const err = new Error(`oracle exited${this.stderr ? ` (oracle stderr: ${this.stderr.trim()})` : ""}`);
            for (const w of this.waiting.splice(0)) w(err);
        });
    }

    /** Kill the oracle: its serve loop runs forever and ignores EOF. */
    close(): void {
        if (this.closed) return;
        this.closed = true;
        this.child.kill();
    }

    private roundTrip(req: string): Promise<string> {
        if (this.closed) return Promise.reject(new Error("oracle client is closed"));
        return new Promise((ok, fail) => {
            this.waiting.push((line) => (line instanceof Error ? fail(line) : ok(line)));
            this.child.stdin.write(req + "\n");
        });
    }

    async schemes(): Promise<string[]> {
        const line = await this.roundTrip("vocab");
        const r: unknown = JSON.parse(line);
        if (typeof r !== "object" || r === null || !("schemes" in r) || !Array.isArray(r.schemes)) {
            throw new Error(`oracle protocol: unexpected reply to vocab: ${line}`);
        }
        return r.schemes.map(String);
    }

    rewrite(proxy: string, base: string, raw: string): Promise<Answer> {
        return this.answer("rewrite", [proxy, base, raw], true);
    }

    /** What the browser shows for `raw` on a page at `base`, without cyrano. */
    direct(base: string, raw: string): Promise<Answer> {
        return this.answer("direct", [base, raw], true);
    }

    /** Any request: its "out", or null for {"none":true}. Throws OutOfModel. */
    async ask(op: string, args: string[]): Promise<string | null> {
        const req = [op, ...args.map(escapeField)].join("\t");
        const line = await this.roundTrip(req);
        const r = JSON.parse(line) as { out?: string; none?: boolean; error?: string };
        if (r.error === "OutOfModel") throw new OutOfModel();
        if (r.error) throw new Error(`oracle: ${r.error} (${op})`);
        if (r.none) return null;
        if (typeof r.out !== "string") throw new Error(`oracle protocol: ${req} → ${line}`);
        return r.out;
    }

    unwrap(proxy: string, href: string): Promise<Answer> {
        return this.answer("unwrap", [proxy, href], true);
    }

    async srcset(value: string): Promise<string> {
        return (await this.answer("srcset", [value], false)).out;
    }

    private async answer(op: string, args: string[], needKind: boolean): Promise<Answer> {
        const req = [op, ...args.map(escapeField)].join("\t");
        const line = await this.roundTrip(req);
        const r: unknown = JSON.parse(line);
        if (typeof r !== "object" || r === null) throw new Error(`oracle protocol: ${req} → ${line}`);
        // Presence checks: an {"error":…} reply must fail, never read as an answer.
        if ("error" in r) {
            if (r.error === "OutOfModel") throw new OutOfModel(req);
            throw new Error(`oracle refused ${req}: ${String(r.error)}`);
        }
        if (!("out" in r) || typeof r.out !== "string" || (needKind && !("kind" in r))) {
            throw new Error(`oracle protocol: unexpected reply to ${req}: ${line}`);
        }
        return { kind: "kind" in r ? String(r.kind) : "", out: r.out };
    }
}

/**
 * Compares the implementation's list of proxified schemes with the
 * spec's: the two are hand-kept in two languages.
 */
export async function checkSchemes(c: OracleClient, impl: string[]): Promise<void> {
    const spec = await c.schemes();
    const a = [...spec].sort();
    const b = [...impl].sort();
    if (a.join(",") !== b.join(",")) {
        throw new Error(`vocabulary drifted: spec proxifies [${spec}], impl proxifies [${impl}]`);
    }
}
