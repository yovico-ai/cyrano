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

------------------------------------------------------------------------
-- Who embeds a framed document (Go: proxy/frame_ancestors.go): the
-- document the proxy judges its frame-ancestors and X-Frame-Options
-- against (spec/Csp.agda frameAncestors, xfoAllows). Natively that is the
-- frame's parent, whoever started the navigation. The proxy sees the
-- Referer — the parent's when the parent gives the frame its URL, the
-- frame's own previous document when the frame navigates itself (a link,
-- a form, a script of its own). The URL tells them apart: a document
-- gives its frames marked URLs (Containment destFrame; Attrs urlDest),
-- its own navigations are unmarked.
--
--   marked:   the frame's URL carries the frame mark;
--   recorded: the embedder recorded for the Referer's document when it
--             was itself loaded as a frame (nothing: it was not);
--   referer:  the Referer's document.
--
-- A marked navigation, or one from a document that is no frame, is
-- embedded by the Referer's document; an unmarked one from a frame's
-- document keeps that frame's embedder. (support.microsoft.com's silent
-- sign-in frame comes back from login.microsoftonline.com by a form POST:
-- it was judged against login.microsoftonline.com and refused; its parent
-- is support.microsoft.com.) Not told apart: a framed document navigating
-- a frame of its own by name (a link's or form's target) — unmarked, it is
-- taken for the document navigating itself.
embedderOf : Bool → Maybe Str → Str → Str
embedderOf true  _        referer = referer
embedderOf false (just e) referer = e
embedderOf false nothing  referer = referer

------------------------------------------------------------------------
-- A frame in which no script runs: an iframe whose sandbox attribute has
-- no allow-scripts (its tokens split on ASCII whitespace, compared ASCII
-- case-insensitively). Natively nothing runs there, and the runtime's
-- bootstrap would be the only script — blocked, with a console message
-- (Microsoft's company-target sync frame). The document holding the
-- iframe says so in the frame's mark (`frameDest`: destInert in place of
-- destFrame), and the proxy gives such a document no runtime
-- (`inertFrame`), nor the documents that frame then navigates itself to:
-- the sandbox stays with the frame. (As for a CSP under which no script
-- runs: Csp noScriptsRun.) Not covered: a sandbox attribute changed
-- after the frame's URL was given and the frame was inserted.

open import Containment using (Dest; destFrame; destInert)
open import Data.Bool.Base using (not)
open import Data.Char.Base using (Char)
open import Url using (is; lowerAscii)
open import Data.List.Base using (map)

sandboxAllowsScripts : Str → Bool
sandboxAllowsScripts s = go s []
  where
  ws : Char → Bool
  ws c = is 9 c ∨ is 10 c ∨ is 12 c ∨ is 13 c ∨ is 32 c
  isAllow : Str → Bool
  isAllow rev = eqStr (map lowerAscii (Data.List.Base.reverse rev)) (toList "allow-scripts")
  -- acc: the current token, reversed
  go : Str → Str → Bool
  go [] acc = isAllow acc
  go (c ∷ cs) acc = if ws c then (isAllow acc ∨ go cs []) else go cs (c ∷ acc)

-- sandbox: the iframe's sandbox attribute, when it has one.
frameDest : Maybe Str → Dest
frameDest nothing  = destFrame
frameDest (just s) = if sandboxAllowsScripts s then destFrame else destInert

-- Whether a framed document being navigated to gets no runtime.
--   markInert: its URL carries the inert mark; marked: it carries a frame
--   mark of either kind; recorded: the Referer's document was itself
--   recorded as an inert frame's.
inertFrame : Bool → Bool → Bool → Bool
inertFrame markInert marked recorded = markInert ∨ (not marked ∧ recorded)

