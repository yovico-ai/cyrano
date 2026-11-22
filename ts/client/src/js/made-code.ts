// Options for rewriting code the page makes at run time (eval, Function).
//
// Natively, import() in such code resolves against the script that made
// it: Usercentrics does `new Function("u", "return import(u)")` in its
// module and imports "./DefaultData-….js" through it (app.usercentrics.eu
// on halespropertymanagement.com). Rewritten, the call went through the
// runtime with no script URL and resolved against the page. The rewritten
// import() is now handed the maker's original URL, as a server-rewritten
// script's is. Found from the stack only when the source names `import`.

import { sIncludes } from "../native/intrinsics";
import { callerScriptUrl } from "../native/error-stack";
import { defaultJsRewriteOptions, type JsRewriteOptions } from "./rewriter";

export function madeCodeOptions(realm: object, source: string, extra: Partial<JsRewriteOptions> = {}): JsRewriteOptions {
    const o: JsRewriteOptions = { ...defaultJsRewriteOptions(), ...extra };
    if (sIncludes(source, "import")) {
        const u = callerScriptUrl(realm);
        if (u !== null) o.baseUrl = u;
    }
    return o;
}
