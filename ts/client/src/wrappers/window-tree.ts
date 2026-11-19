// Wrappers for window-tree references: `top`, `parent`, and the helper to
// walk up to the outermost window.
//
// All pages we serve live in the same proxy origin, so a page reading
// `window.top` is normally already the rewritten window — no unwrap needed.
// For the cases where it isn't (cross-origin iframes, ad slots that escaped
// the rewrite), we can't safely "unwrap" anyway: cross-origin reads throw,
// so the safest thing is to return values as-is and let same-origin policy
// surface its own errors.

import { crossOriginView, isView } from "../native/cross-origin";
import { isWindowObject } from "../native/brand";

// A window (or the stand-in for a cross-origin one), told apart without
// reading any of the object's properties (native/brand.ts): anything else
// is returned as it is, its own `top` / `parent` read once, as written.
function isWindowLike(obj: unknown): obj is Window {
    return isWindowObject(obj) || isView(obj);
}

/**
 * Server-side rule emits `$rewriter.wrap_get_top_window(top)` in place of
 * bare `top` (and `parent`) reads: the window, or its cross-origin view
 * (native/cross-origin.ts).
 */
export function wrapGetTopWindow(top: Window, viewer?: object): Window {
    return crossOriginView(top, null, viewer);
}

/**
 * Server-side rule emits `$rewriter.wrap_top_window({obj}).top` in place of
 * `obj.top`. Pass through the underlying property if it exists.
 *
 * For non-Window objects (e.g. a library's `.top()` method) return the object
 * unchanged so that `.top` resolves as a normal property and method calls
 * preserve their original `this` binding.
 */
export function wrapTopWindow(arg: { obj: unknown }, viewer?: object): { top: unknown } {
    // null / undefined too: the access then throws the native TypeError.
    if (!isWindowLike(arg.obj)) {
        return arg.obj as { top: unknown };
    }
    return { top: crossOriginView((arg.obj as { top: unknown }).top, null, viewer) };
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
export function wrapParentWindow(arg: { obj: unknown }, viewer?: object): { parent: unknown } {
    // null / undefined too: the access then throws the native TypeError.
    if (!isWindowLike(arg.obj)) {
        return arg.obj as { parent: unknown };
    }
    return { parent: crossOriginView((arg.obj as { parent: unknown }).parent, null, viewer) };
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
