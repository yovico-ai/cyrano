// Helpers for reading/writing globals by name.
//
// We can't write `window.WebSocket = ...` in strict TS — the DOM lib doesn't
// declare these as writable. They're all on `globalThis` though, so we route
// through there with explicit casts. These two functions encapsulate the
// cast in one place.
//
// They also serve a second purpose: in unit-test environments some globals
// are missing, and a `getGlobal` returning `undefined` is cleaner to handle
// than a property access on an unknown shape.

export function getGlobal<T>(name: string): T | undefined {
    return (globalThis as unknown as Record<string, T | undefined>)[name];
}

export function setGlobal(name: string, value: unknown): void {
    (globalThis as unknown as Record<string, unknown>)[name] = value;
}
