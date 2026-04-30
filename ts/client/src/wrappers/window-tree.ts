// Wrappers for window-tree references: `top`, `parent`, and the helper to
// walk up to the outermost window.
//
// All pages we serve live in the same proxy origin, so a page reading
// `window.top` is normally already the rewritten window — no unwrap needed.
// For the cases where it isn't (cross-origin iframes, ad slots that escaped
// the rewrite), we can't safely "unwrap" anyway: cross-origin reads throw,
// so the safest thing is to return values as-is and let same-origin policy
// surface its own errors.

function hasOwnLikeProperty(obj: unknown, key: string): boolean {
    return obj !== null && obj !== undefined && key in (obj as object);
}

// Duck-type check for the global Window object. Avoids depending on the
// `Window` constructor (absent in Node.js test environments). The invariant
// `globalThis.window === globalThis` holds for every real browser Window;
// no user-defined object satisfies it in practice.
function isWindowLike(obj: unknown): obj is Window {
    if (obj == null || typeof obj !== "object") return false;
    try {
        return (obj as { window?: unknown }).window === obj;
    } catch {
        // Cross-origin window property reads throw SecurityError — definitely
        // a Window, but one we can't introspect. Treat conservatively as Window.
        return true;
    }
}

/**
 * Server-side rule emits `$rewriter.wrap_get_top_window(top)` in place of
 * bare `top` reads. Identity for now; reserved for future unwrap logic.
 */
export function wrapGetTopWindow(top: Window): Window {
    return top;
}

/**
 * Server-side rule emits `$rewriter.wrap_top_window({obj}).top` in place of
 * `obj.top`. Pass through the underlying property if it exists.
 *
 * For non-Window objects (e.g. a library's `.top()` method) return the object
 * unchanged so that `.top` resolves as a normal property and method calls
 * preserve their original `this` binding.
 */
export function wrapTopWindow(arg: { obj: unknown }): { top: unknown } {
    if (arg.obj != null && !isWindowLike(arg.obj)) {
        return arg.obj as { top: unknown };
    }
    return {
        top: hasOwnLikeProperty(arg.obj, "top")
            ? (arg.obj as { top: unknown }).top
            : undefined,
    };
}

/**
 * Server-side rule emits `$rewriter.wrap_parent_window({obj}).parent` in place
 * of `obj.parent`. Pass through the underlying property if it exists.
 *
 * For non-Window objects (e.g. jQuery's `.parent()` traversal method) return
 * the object unchanged so that `.parent` resolves as a normal property and
 * method calls preserve their original `this` binding. Without this guard,
 * `jqueryObj.parent()` becomes `{parent: fn}.parent()` with broken `this`.
 */
export function wrapParentWindow(arg: { obj: unknown }): { parent: unknown } {
    if (arg.obj != null && !isWindowLike(arg.obj)) {
        return arg.obj as { parent: unknown };
    }
    return {
        parent: hasOwnLikeProperty(arg.obj, "parent")
            ? (arg.obj as { parent: unknown }).parent
            : undefined,
    };
}

/**
 * Walks up the window chain to the outermost window. Used by the server-side
 * `process_server_cookies` machinery to identify the document the loaded
 * resource belongs to.
 */
export function getTopLevelWindow(start: Window): Window {
    let cursor = start;
    while (cursor.parent && cursor.parent !== cursor) {
        cursor = cursor.parent;
    }
    return cursor;
}
