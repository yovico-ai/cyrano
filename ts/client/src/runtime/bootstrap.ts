// `init(targetWindow, config).inject()` — the function the entry script
// publishes as `window.$rewriter_init`.
//
// The two-step shape (init then inject) is for parity with what the server's
// head-injection script expects. It also makes it easy to construct the API
// without immediately patching globals (useful in tests).

import type { ClientConfig } from "../config";
import type { RewriterApi } from "./api-types";
import { createRewriterApi } from "./api";
import { installPatches } from "../patches/install";

export interface RewriterBootstrap {
    inject(): RewriterApi;
}

export function init(
    targetWindow: Window,
    config: ClientConfig,
): RewriterBootstrap {
    const api = createRewriterApi(targetWindow, config);
    return {
        inject(): RewriterApi {
            installPatches(targetWindow, () => api.get_base_url(), config);
            return api;
        },
    };
}
