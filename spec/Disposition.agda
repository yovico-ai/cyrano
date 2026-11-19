{-# OPTIONS --safe #-}
-- What the proxy does with a response's body: rewrite it as JavaScript,
-- CSS or HTML, or pass it as the origin sent it (Go:
-- server/bodyrewriter.go responseKind). The Content-Type is never changed:
-- the browser decides what it runs, applies or renders, as it would
-- directly (owner, 2026-11-19); the proxy rewrites by what the request is
-- for.
--
--   * A URL the rewriter marked (spec/Containment.agda Dest: a <script
--     src>, a stylesheet, their preloads, @import, importScripts, module
--     specifiers) is rewritten as what it was marked for, whatever its
--     Content-Type: a script served as text/plain runs (Chromium), and
--     unrewritten its location reads and URLs would escape.
--   * Otherwise the request's Sec-Fetch-Dest says: script and the
--     worker destinations are JavaScript, style is CSS (whatever the
--     Content-Type, likewise); a document, frame, iframe, embed or object
--     is HTML when its MIME type's essence is HTML, or when it has no
--     Content-Type and its bytes sniff as HTML; a fetch() or XHR (empty)
--     is the page's data, as sent; any other destination too.
--   * A request with no Sec-Fetch-Dest (a client that sends none) goes by
--     the MIME type's essence.
--
-- A MIME type's essence (MIME Sniffing §4.4, as far as it decides here):
-- the Content-Type up to ";", HTTP whitespace trimmed, ASCII-lowercased.
module Disposition where

open import Data.Bool.Base using (Bool; true; false; _∨_; _∧_; not; if_then_else_)
open import Data.List.Base using (List; []; _∷_; map; reverse)
open import Data.Maybe.Base using (Maybe; just; nothing)
open import Data.String.Base using (String; toList)

open import Url using (Str; is; eqStr; lowerAscii; dropWhile; break)
open import Containment using (Dest; destScript; destStyle)

data Kind : Set where
  asJs asCss asHtml asIs : Kind

kindName : Kind → String
kindName asJs   = "js"
kindName asCss  = "css"
kindName asHtml = "html"
kindName asIs   = "none"

inS : Str → List String → Bool
inS x []       = false
inS x (y ∷ ys) = eqStr x (toList y) ∨ inS x ys

-- The essence of a Content-Type value.
essence : Str → Str
essence ct = map lowerAscii (trim (Data.Product.Base.proj₁ (break (is 59) ct)))
  where
  import Data.Product.Base
  ws : _ → Bool
  ws c = is 32 c ∨ is 9 c ∨ is 10 c ∨ is 13 c
  trim : Str → Str
  trim s = reverse (dropWhile ws (reverse (dropWhile ws s)))

isHtmlType isJsType isCssType : Str → Bool
isHtmlType e = inS e ("text/html" ∷ "application/xhtml+xml" ∷ [])
isCssType e = eqStr e (toList "text/css")
-- MIME Sniffing §4.6, the JavaScript MIME type essences.
isJsType e = inS e ("application/ecmascript" ∷ "application/javascript" ∷ "application/x-ecmascript"
  ∷ "application/x-javascript" ∷ "text/ecmascript" ∷ "text/javascript" ∷ "text/javascript1.0"
  ∷ "text/javascript1.1" ∷ "text/javascript1.2" ∷ "text/javascript1.3" ∷ "text/javascript1.4"
  ∷ "text/javascript1.5" ∷ "text/jscript" ∷ "text/livescript" ∷ "text/x-ecmascript"
  ∷ "text/x-javascript" ∷ [])

-- dest: the URL's mark; sfd: Sec-Fetch-Dest (ASCII case aside; nothing:
-- the request had none); ct: the Content-Type (nothing: none); sniffed: the
-- body's first bytes sniff as HTML.
responseKind : Maybe Dest → Maybe Str → Maybe Str → Bool → Kind
responseKind (just destScript) _ _ _ = asJs
responseKind (just destStyle)  _ _ _ = asCss
responseKind nothing (just d₀) ct sniffed =
  if inS d ("script" ∷ "worker" ∷ "sharedworker" ∷ "serviceworker" ∷ "audioworklet" ∷ "paintworklet" ∷ []) then asJs
  else if eqStr d (toList "style") then asCss
  else if inS d ("document" ∷ "iframe" ∷ "frame" ∷ "embed" ∷ "object" ∷ []) then document ct
  else asIs
  where
  d : Str
  d = map lowerAscii d₀
  document : Maybe Str → Kind
  document (just t) = if isHtmlType (essence t) then asHtml else asIs
  document nothing  = if sniffed then asHtml else asIs
responseKind nothing nothing (just t) _ =
  if isHtmlType (essence t) then asHtml
  else if isJsType (essence t) then asJs
  else if isCssType (essence t) then asCss
  else asIs
responseKind nothing nothing nothing _ = asIs
