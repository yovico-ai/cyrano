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
 */
export function wrapTopWindow(arg: { obj: unknown }): { top: unknown } {
    return {
        top: hasOwnLikeProperty(arg.obj, "top")
            ? (arg.obj as { top: unknown }).top
            : undefined,
    };
}

/**
 * Server-side rule emits `$rewriter.wrap_parent_window({obj}).parent` in place
 * of `obj.parent`. Pass through the underlying property if it exists.
 */
export function wrapParentWindow(arg: { obj: unknown }): { parent: unknown } {
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
