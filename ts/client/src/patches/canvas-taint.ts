// Canvas origin-clean, kept by the runtime (spec/Canvas.agda).
//
// Through the proxy every image is same-origin to the browser, so no canvas
// was ever tainted: getImageData, toDataURL, toBlob, convertToBlob read
// another site's pixels, WebGL uploaded them, a VideoFrame was made of them
// — where directly each throws Chromium's SecurityError. Fingerprinting
// scripts and pages that try/catch an export see the difference (round K's
// built-in survey).
//
// So the runtime judges each source as Chromium would for the page's
// origin (url/image-clean.ts: CORS asked, data:/blob:, or the document's
// origin) and keeps the flag: a canvas (element or OffscreenCanvas) a
// source that is not clean is drawn into, a pattern of one assigned as a
// fill or stroke style (at the assignment, as measured), an ImageBitmap of
// one (createImageBitmap, transferToImageBitmap) or placed by a
// bitmaprenderer. Setting width or height cleans a canvas again. The
// readers then throw what Chromium throws (canvas-taint-vs-chromium). The
// flags are one registry for the page tree (native/shared.ts): a canvas
// handed to a frame keeps its flag. Limits: redirects are not followed (a
// same-origin URL redirected elsewhere taints natively); a bitmap or
// canvas transferred to a worker arrives clean; a media element whose
// source changes after it first connects keeps the first judgment.

import { SafeWeakMap, SafeWeakSet, nO, nOP, nR, ncall } from "../native/intrinsics";
import { sharedData } from "../native/shared";
import { stacked } from "../native/stacked";
import { wrapAccessor, wrapConstructor, wrapMethod } from "../native/surface";
import { heldAttr, originalAttr } from "../native/originals";
import { imageClean } from "../url/image-clean";

type Flags = { canvases: SafeWeakSet<object>; bitmaps: SafeWeakSet<object>; patterns: SafeWeakSet<object> };

export function patchCanvasTaint(
    targetWindow: Window,
    unwrapOne: (url: string) => string,
    docOrigin: () => string,
    base: () => URL,
): void {
    const g = targetWindow as unknown as Record<string, { prototype: object } | undefined> & { DOMException?: new (m: string, n: string) => Error };
    const flags = sharedData<Flags>("canvasTaint", () => ({ canvases: new SafeWeakSet(), bitmaps: new SafeWeakSet(), patterns: new SafeWeakSet() }));
    const DE = g.DOMException;
    if (!DE) return;
    const refuse = (message: string): never => { throw stacked(new DE(message, "SecurityError")); };
    const is = (v: unknown, name: string): boolean => {
        const C = g[name] as unknown as { prototype: object } | undefined;
        return !!C && typeof v === "object" && v !== null && (ncall(nOP.isPrototypeOf, C.prototype, v) as boolean);
    };
    const nativeGet = (name: string, key: string): ((this: unknown) => unknown) | undefined =>
        nO.getOwnPropertyDescriptor(g[name]?.prototype ?? {}, key)?.get as ((this: unknown) => unknown) | undefined;
    const imgSrc = nativeGet("HTMLImageElement", "currentSrc");
    const imgComplete = nativeGet("HTMLImageElement", "complete");
    const imgWidth = nativeGet("HTMLImageElement", "naturalWidth");
    const mediaSrc = nativeGet("HTMLMediaElement", "currentSrc");
    const mediaReady = nativeGet("HTMLMediaElement", "readyState");
    const mediaSrcAttr = nativeGet("HTMLMediaElement", "src");
    /** A media element's URL as it holds it: what it plays, else its src. */
    const mediaSrcOf = (el: Element): string => {
        const c = mediaSrc ? String(ncall(mediaSrc, el)) : "";
        return c !== "" ? c : mediaSrcAttr ? String(ncall(mediaSrcAttr, el)) : "";
    };
    const ctxCanvas2d = nativeGet("CanvasRenderingContext2D", "canvas");
    const ctxCanvasOff = nativeGet("OffscreenCanvasRenderingContext2D", "canvas");
    const ctxCanvasBr = nativeGet("ImageBitmapRenderingContext", "canvas");

    /** The crossorigin attribute as the page wrote it is there. */
    const corsAsked = (el: Element): boolean => {
        const rec = originalAttr(el, "crossorigin");
        return (rec ? rec.value : heldAttr(el, "crossorigin")) !== null;
    };
    const urlClean = (el: Element, held: string): boolean => {
        if (held === "") return true;
        let u = unwrapOne(held);
        try { u = new URL(u, base()).href; } catch { /* as it is */ }
        return imageClean(corsAsked(el), docOrigin(), u);
    };
    /** Whether drawing `src` leaves a canvas clean; "drawn" says whether anything would be drawn at all. */
    const clean = (src: unknown): boolean => {
        try {
            if (is(src, "HTMLImageElement")) {
                // an image not (yet) decoded draws nothing
                if (imgComplete && !ncall(imgComplete, src)) return true;
                if (imgWidth && !ncall(imgWidth, src)) return true;
                return urlClean(src as Element, imgSrc ? String(ncall(imgSrc, src)) : "");
            }
            if (is(src, "HTMLVideoElement")) {
                if (mediaReady && (ncall(mediaReady, src) as number) < 2) return true; // no current frame: nothing drawn
                return urlClean(src as Element, mediaSrc ? String(ncall(mediaSrc, src)) : "");
            }
            if (is(src, "SVGImageElement")) {
                const el = src as Element;
                return urlClean(el, heldAttr(el, "href") ?? heldAttr(el, "xlink:href") ?? "");
            }
            if (is(src, "HTMLCanvasElement") || is(src, "OffscreenCanvas")) return !flags.canvases.has(src as object);
            if (is(src, "ImageBitmap")) return !flags.bitmaps.has(src as object);
        } catch { /* judged clean */ }
        return true;
    };
    const kindOf = (src: unknown): "image" | "video" | "canvas" | "bitmap" | null =>
        is(src, "HTMLImageElement") || is(src, "SVGImageElement") ? "image"
            : is(src, "HTMLVideoElement") ? "video"
                : is(src, "HTMLCanvasElement") || is(src, "OffscreenCanvas") ? "canvas"
                    : is(src, "ImageBitmap") ? "bitmap" : null;

    // ── 2D contexts: what taints, what reads ──────────────────────────────
    const ctx2d: Array<[string, ((this: unknown) => unknown) | undefined]> = [
        ["CanvasRenderingContext2D", ctxCanvas2d], ["OffscreenCanvasRenderingContext2D", ctxCanvasOff],
    ];
    for (const [name, canvasOf] of ctx2d) {
        const proto = g[name]?.prototype;
        if (!proto || !canvasOf) continue;
        const taint = (ctx: unknown): void => { const c = ncall(canvasOf, ctx); if (c) flags.canvases.add(c as object); };
        wrapMethod<(...a: unknown[]) => unknown>(proto, "drawImage", (native, self, args) => {
            const r = nR.apply(native, self, args); // the native's own checks and errors first
            if (!clean(args[0])) taint(self);
            return r;
        });
        wrapMethod<(...a: unknown[]) => unknown>(proto, "createPattern", (native, self, args) => {
            const p = nR.apply(native, self, args);
            if (p && typeof p === "object" && !clean(args[0])) flags.patterns.add(p);
            return p;
        });
        for (const key of ["fillStyle", "strokeStyle"]) {
            if (!nO.getOwnPropertyDescriptor(proto, key)?.set) continue;
            wrapAccessor<unknown>(proto, key, {
                set: (set, self, v) => {
                    ncall(set, self, v);
                    if (typeof v === "object" && v !== null && flags.patterns.has(v)) taint(self);
                },
            });
        }
        wrapMethod<(...a: unknown[]) => unknown>(proto, "getImageData", (native, self, args) => {
            const c = ncall(canvasOf, self);
            if (args.length < 4 || !c || !flags.canvases.has(c as object)) return nR.apply(native, self, args);
            // the arguments converted, as natively, then refused before any
            // check of their values (measured: a zero size is not reached)
            for (let i = 0; i < 4; i++) Number(args[i]);
            return refuse(`Failed to execute 'getImageData' on '${name}': The canvas has been tainted by cross-origin data.`);
        });
    }
    const br = g["ImageBitmapRenderingContext"]?.prototype;
    if (br && ctxCanvasBr) {
        wrapMethod<(...a: unknown[]) => unknown>(br, "transferFromImageBitmap", (native, self, args) => {
            const unclean = typeof args[0] === "object" && args[0] !== null && flags.bitmaps.has(args[0]);
            const r = nR.apply(native, self, args);
            const c = ncall(ctxCanvasBr, self) as object | null;
            if (c) { if (unclean) flags.canvases.add(c); else flags.canvases.delete(c); }
            return r;
        });
    }

    // ── canvases: exports, and a size set cleans ──────────────────────────
    const el = g["HTMLCanvasElement"]?.prototype;
    if (el) {
        for (const key of ["toDataURL", "toBlob"]) {
            wrapMethod<(...a: unknown[]) => unknown>(el, key, (native, self, args) => {
                if (!flags.canvases.has(self as object) || (key === "toBlob" && typeof args[0] !== "function")) return nR.apply(native, self, args);
                return refuse(`Failed to execute '${key}' on 'HTMLCanvasElement': Tainted canvases may not be exported.`);
            });
        }
    }
    const off = g["OffscreenCanvas"]?.prototype;
    if (off) {
        wrapMethod<(...a: unknown[]) => unknown>(off, "convertToBlob", (native, self, args) => {
            if (!flags.canvases.has(self as object)) return nR.apply(native, self, args);
            const P = (targetWindow as unknown as { Promise: PromiseConstructor }).Promise;
            try { refuse(`Failed to execute 'convertToBlob' on 'OffscreenCanvas': Tainted "OffscreenCanvas" may not be exported.`); } catch (e) { return P.reject(e); }
            return undefined;
        });
        wrapMethod<(...a: unknown[]) => unknown>(off, "transferToImageBitmap", (native, self, args) => {
            const b = nR.apply(native, self, args);
            if (b && typeof b === "object" && flags.canvases.has(self as object)) flags.bitmaps.add(b);
            return b;
        });
    }
    for (const proto of [el, off]) {
        if (!proto) continue;
        for (const key of ["width", "height"]) {
            if (!nO.getOwnPropertyDescriptor(proto, key)?.set) continue;
            wrapAccessor<unknown>(proto, key, { set: (set, self, v) => { ncall(set, self, v); flags.canvases.delete(self as object); } });
        }
    }

    // ── bitmaps ───────────────────────────────────────────────────────────
    const nativeThen = (targetWindow as unknown as { Promise: PromiseConstructor }).Promise.prototype.then;
    if (typeof (targetWindow as unknown as { createImageBitmap?: unknown }).createImageBitmap === "function") {
        wrapMethod<(...a: unknown[]) => unknown>(targetWindow, "createImageBitmap", (native, self, args) => {
            const unclean = args.length > 0 && !clean(args[0]);
            const p = nR.apply(native, self, args) as Promise<unknown>;
            if (!unclean || !p || typeof (p as { then?: unknown }).then !== "function") return p;
            return ncall(nativeThen, p, (b: unknown) => { if (b && typeof b === "object") flags.bitmaps.add(b); return b; });
        });
    }

    // ── WebGL: a source that is not clean is refused ─────────────────────
    const glWords: Record<string, string> = { // by the source's kind
        image: "The image element contains cross-origin data, and may not be loaded.",
        canvas: "Tainted canvases may not be loaded.",
        bitmap: "The ImageBitmap contains cross-origin data, and may not be loaded.",
        video: "The video element contains cross-origin data, and may not be loaded.",
    };
    for (const name of ["WebGLRenderingContext", "WebGL2RenderingContext"]) {
        const proto = g[name]?.prototype;
        if (!proto) continue;
        for (const key of ["texImage2D", "texSubImage2D", "texImage3D", "texSubImage3D"]) {
            if (!ncall(nOP.hasOwnProperty, proto, key)) continue;
            wrapMethod<(...a: unknown[]) => unknown>(proto, key, (native, self, args) => {
                const src = args[args.length - 1];
                const kind = kindOf(src);
                if (kind && !clean(src)) refuse(`Failed to execute '${key}' on '${name}': ${glWords[kind]}`);
                return nR.apply(native, self, args);
            });
        }
    }

    // ── Web Audio: such media through createMediaElementSource is silence ─
    // (measured): the source's outputs go through a private zero gain, so
    // whatever it connects to — an analyser, the destination — hears
    // nothing; the node itself reads as natively. Judged when it connects.
    patchMediaSilence(g, (el) => urlClean(el, mediaSrcOf(el)));

    // ── VideoFrame ────────────────────────────────────────────────────────
    if (g["VideoFrame"]) {
        wrapConstructor<new (...a: unknown[]) => object>(targetWindow, "VideoFrame", (Native, args, newTarget) => {
            if (args.length && kindOf(args[0]) && !clean(args[0])) refuse("Failed to construct 'VideoFrame': VideoFrames can't be created from tainted sources.");
            return nR.construct(Native, args, newTarget as new (...a: unknown[]) => object);
        });
    }
}

/** Silences MediaElementAudioSourceNodes of media that is not clean (see above). */
function patchMediaSilence(g: Record<string, { prototype: object } | undefined>, clean: (el: Element) => boolean): void {
    const AC = g["AudioContext"]?.prototype;
    const AN = g["AudioNode"]?.prototype as Record<string, unknown> | undefined;
    const BAC = g["BaseAudioContext"]?.prototype as Record<string, unknown> | undefined;
    if (!AC || !AN || !BAC) return;
    const nativeConnect = AN["connect"] as Fn, nativeDisconnect = AN["disconnect"] as Fn;
    const createGain = BAC["createGain"] as Fn;
    const contextOf = nO.getOwnPropertyDescriptor(AN, "context")?.get as Fn | undefined;
    const gainParam = nO.getOwnPropertyDescriptor(g["GainNode"]?.prototype ?? {}, "gain")?.get as Fn | undefined;
    const valueSet = nO.getOwnPropertyDescriptor(g["AudioParam"]?.prototype ?? {}, "value")?.set as Fn | undefined;
    if (!nativeConnect || !nativeDisconnect || !createGain || !contextOf || !gainParam || !valueSet) return;
    const media = new SafeWeakMap<object, Element>();   // source node → its element
    const muted = new SafeWeakMap<object, object>();    // source node → its zero gain
    wrapMethod<Fn>(AC, "createMediaElementSource", (native, self, args) => {
        const node = nR.apply(native, self, args);
        if (node && typeof node === "object" && args[0] && typeof args[0] === "object") media.set(node, args[0] as Element);
        return node;
    });
    /** The zero gain a silenced source plays through, made at its first connection; null when it is clean. */
    const zeroOf = (node: object): object | null => {
        const z = muted.get(node);
        if (z) return z;
        const el = media.get(node);
        if (!el || clean(el)) return null;
        const gn = ncall(createGain, ncall(contextOf, node)) as object;
        ncall(valueSet, ncall(gainParam, gn), 0);
        ncall(nativeConnect, node, gn);
        muted.set(node, gn);
        return gn;
    };
    wrapMethod<Fn>(AN, "connect", (native, self, args) => {
        // another output than the only one: the native's IndexSizeError
        if (!media.has(self as object) || (args.length > 1 && args[1] !== undefined && Number(args[1]) !== 0)) return nR.apply(native, self, args);
        const z = zeroOf(self as object);
        if (!z) return nR.apply(native, self, args);
        return nR.apply(native, z, [args[0], 0, ...args.slice(2)]);
    });
    wrapMethod<Fn>(AN, "disconnect", (native, self, args) => {
        const z = muted.get(self as object);
        if (!z) return nR.apply(native, self, args);
        if (args.length === 0) return nR.apply(native, z, []);
        if (typeof args[0] === "number") return Number(args[0]) !== 0 ? nR.apply(native, self, args) : nR.apply(native, z, []);
        if (args.length > 1 && args[1] !== undefined && Number(args[1]) !== 0) return nR.apply(native, self, args);
        return nR.apply(native, z, [args[0], ...(args.length > 1 ? [0, ...args.slice(2)] : [])]);
    });
}

type Fn = (...a: unknown[]) => unknown;
