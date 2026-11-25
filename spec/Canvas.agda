{-# OPTIONS --safe #-}
------------------------------------------------------------------------
-- Canvas origin-clean (HTML "Security with canvas elements"; Chromium,
-- measured: canvas-taint-vs-chromium).
--
-- Through the proxy every image is same-origin to the browser, so nothing
-- tainted a canvas: getImageData, toDataURL and the like read another
-- site's pixels where directly they throw, and fingerprinting scripts
-- (and pages that try/catch the export) see the difference. The runtime
-- (TS: patches/canvas-taint.ts) keeps the flag itself, by this judgment
-- of an image source and Chromium's propagation:
--
--   * An <img>, an SVG <image> or a <video> is origin-clean when its
--     request was CORS (a crossorigin attribute, as the page wrote it: a
--     CORS failure fails the load instead), or its URL — as the page
--     knows it — is a data: URL, a blob: URL (under the proxy every blob:
--     URL is the page's own), or of the document's origin. Not followed:
--     redirects (a same-origin URL redirected elsewhere taints natively).
--   * Drawing a source that is not clean taints the canvas (2D drawImage,
--     an OffscreenCanvas's too); so does assigning a pattern made from one
--     to fillStyle or strokeStyle — at the assignment, even if replaced
--     before anything is drawn (measured). A canvas, an OffscreenCanvas or
--     an ImageBitmap is clean as its flag is; createImageBitmap and
--     transferToImageBitmap carry the source's.
--   * Setting a canvas's width or height (any value, the same too) makes
--     it clean again; clearRect and reset() do not (measured).
--   * Web Audio: a media element that is not clean, given to
--     createMediaElementSource, plays silence into the graph (measured).
--   * A tainted canvas refuses getImageData, toDataURL, toBlob,
--     convertToBlob; WebGL's tex(Sub)Image refuses a source that is not
--     clean (a <video> too, as WebGL requires: headless Chromium refuses
--     it only sometimes); new VideoFrame too — each with Chromium's SecurityError
--     message (checked by canvas-taint-vs-chromium).
------------------------------------------------------------------------

module Canvas where

open import Data.Bool.Base using (Bool; true; false; _∨_; if_then_else_)
open import Data.String.Base using (toList)

open import Url using (Str; eqStr; eqLower; preprocess)
open import Messaging using (Origin; tuple; targetOriginOf; take)

-- cors: the element asked for CORS (a crossorigin attribute); doc: the
-- document's origin, serialized ("null" for an opaque one); u: the
-- source's URL, absolute, as the page knows it.
imageClean : Bool → Str → Str → Bool
imageClean cors doc u = cors ∨ eqLower (take 5 (preprocess u)) (toList "data:")
                             ∨ eqLower (take 5 (preprocess u)) (toList "blob:")
                             ∨ same (targetOriginOf u)
  where
  same : Origin → Bool
  same (tuple o) = eqStr o doc
  same _         = false
