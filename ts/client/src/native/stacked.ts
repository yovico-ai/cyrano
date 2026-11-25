// A DOMException the runtime makes itself has no `stack`: V8 gives one to
// an exception Blink throws, not to `new DOMException(…)` in script (round
// J: pushState's SecurityError read `stack` undefined — error reporters
// read it, and it is a tell). Every one the runtime throws or rejects with
// is given one here, captured where it is made; the stack formatter leaves
// the runtime's own frames out, so its first frame is the page's caller.

// The intrinsic, saved as the bundle loads (before the runtime's Error stand-in).
const capture = (Error as unknown as { captureStackTrace?: (o: object) => void }).captureStackTrace;

/** `e` with a stack of its own, as a native exception has. */
export function stacked<T>(e: T): T {
    if (capture && typeof e === "object" && e !== null) {
        try { capture(e as unknown as object); } catch { /* as it is */ }
    }
    return e;
}
