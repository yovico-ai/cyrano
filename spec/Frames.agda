{-# OPTIONS --safe #-}
-- The origin a frame element's document is from, or is about to be from
-- (TS: patches/cross-origin-windows.ts pendingOrigin, used by
-- native/cross-origin.ts crossOriginView): page code that takes a frame's
-- contentWindow before its navigation commits must get the object it will
-- later see as a message's source — a browser has one WindowProxy for a
-- frame throughout — so the runtime decides at once whether the frame is
-- cross-origin, from the element.
--
--   * an iframe with a srcdoc attribute: about:srcdoc, its creator's origin;
--   * else its URL as the src (iframe, frame, embed) or data (object)
--     property reads it (the original URL, resolved): an http(s) URL's
--     origin is the frame's;
--   * a data: URL: an opaque origin, which the browser itself keeps
--     cross-origin (nothing for the runtime to do); so is an object's
--     javascript: URL, which the browser does not run (no document);
--   * anything else (none, about:blank, javascript:, blob:): its
--     creator's origin.
--
-- Checked against Chromium (frame-origin-vs-chromium): once the frame has
-- loaded, its document is reachable from the page exactly when this says
-- same-origin. Known gap: a frame redirected to another origin keeps the
-- origin of the URL it was given.
module Frames where

open import Data.Bool.Base using (Bool; true; false; _∨_; _∧_; if_then_else_)
open import Data.List.Base using (List; []; _∷_)
open import Data.Maybe.Base using (Maybe; just; nothing)
open import Data.String.Base using (toList)

open import Messaging using (take)
open import Url using (Str; eqStr; eqLower; parse; url; originText; scheme; auth; hostPort; Parsed)

data FrameOrigin : Set where
  originOf : Str → FrameOrigin   -- an http(s) URL's origin
  creator  : FrameOrigin         -- the creating document's
  opaqueF  : FrameOrigin         -- unreachable by the browser's own rules (data:)

-- object: an <object> (its data); srcdoc: an iframe's srcdoc attribute.
frameOrigin : Bool → Bool → Str → FrameOrigin
frameOrigin _ true  _   = creator
frameOrigin object false src =
  if eqLower (take 5 src) (toList "http:") ∨ eqLower (take 6 src) (toList "https:") then byParse (parse nothing src)
  else if eqLower (take 5 src) (toList "data:") ∨ (object ∧ eqLower (take 11 src) (toList "javascript:")) then opaqueF
  else creator
  where
  byParse : Parsed → FrameOrigin
  byParse (url u) = originOf (originText (scheme u) (hostPort (auth u)))
  byParse _       = creator

------------------------------------------------------------------------
-- What a document reads of its own origin (TS: patches/location.ts).
--
-- The browser gives a proxied document the sandbox it would have direct,
-- so its native `origin` reads "null" exactly when its origin is opaque
-- (a sandboxed frame, a CSP sandbox). Then, as direct: `self.origin` is
-- "null" and `document.domain` "" (HTML: an opaque origin has no host).
-- Else they are the original document's: its origin and its host (the
-- creator's for about:blank / about:srcdoc, `frameOrigin` creator).
-- `location.origin` is not among them: it is the URL's origin, opaque or
-- not (the location view). Checked against Chromium
-- (opaque-origin-vs-chromium).

opaqueByNative : Str → Bool
opaqueByNative nativeOrigin = eqStr nativeOrigin (toList "null")

selfOrigin : Str → Str → Str
selfOrigin nativeOrigin original = if opaqueByNative nativeOrigin then toList "null" else original

documentDomain : Str → Str → Str
documentDomain nativeOrigin host = if opaqueByNative nativeOrigin then [] else host
