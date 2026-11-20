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
--     is HTML when its MIME type is HTML, or when it has none Chromium
--     takes (no Content-Type, one without "/", */*, unknown/unknown,
--     application/unknown) and its bytes sniff as HTML (sniffHtml); a fetch() or XHR (empty)
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
import Url
open import Data.Nat.Base using (ℕ; zero; suc)
open import Containment using (Dest; destScript; destStyle)
open import Relation.Binary.PropositionalEquality using (_≡_; refl)

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

------------------------------------------------------------------------
-- A document's type and sniffing, as Chromium does them (checked:
-- sniff-vs-chromium). The value is a comma-separated list; of each item
-- the MIME type is read — HTTP whitespace skipped, up to ";" or
-- whitespace, lowercased — and the last one with a "/" that is not */* is
-- taken (te xt,text/html is HTML). None taken, or unknown/unknown,
-- application/unknown: the type is sniffed. Anything else with a "/" is
-- taken as it is (/html, text/ are not sniffed).

chromiumMime : Str → Str
chromiumMime ct = map lowerAscii (Data.Product.Base.proj₁ (break stop (dropWhile ws ct)))
  where
  import Data.Product.Base
  ws : _ → Bool
  ws c = is 32 c ∨ is 9 c ∨ is 10 c ∨ is 13 c
  stop : _ → Bool
  stop c = is 59 c ∨ ws c

unknownMime : Str → Bool
unknownMime m = inS m ("unknown/unknown" ∷ "application/unknown" ∷ [])

-- The type Chromium takes from a Content-Type value, if any.
takenMime : Str → Maybe Str
takenMime ct = lastOf (Url.splitOn (is 44) ct) nothing
  where
  lastOf : List Str → Maybe Str → Maybe Str
  lastOf [] acc = acc
  lastOf (x ∷ xs) acc =
    lastOf xs (if Url.any (is 47) (chromiumMime x) ∧ not (eqStr (chromiumMime x) (toList "*/*")) then just (chromiumMime x) else acc)

-- The HTML sniff (Chromium's, looser than MIME Sniffing §7.1): in the
-- first 512 bytes, after ASCII whitespace (vertical tab too), one of these
-- prefixes, ASCII case aside, with nothing required after it ("<bx" is
-- HTML).
htmlPrefixes : List String
htmlPrefixes = "<!doctype html" ∷ "<script" ∷ "<html" ∷ "<!--" ∷ "<head" ∷ "<iframe" ∷ "<h1" ∷ "<div"
  ∷ "<font" ∷ "<table" ∷ "<a" ∷ "<style" ∷ "<title" ∷ "<b" ∷ "<body" ∷ "<br" ∷ "<p" ∷ []

sniffHtml : Str → Bool
sniffHtml body = anyP htmlPrefixes
  where
  take : ℕ → Str → Str
  take zero _ = []
  take (suc n) [] = []
  take (suc n) (c ∷ cs) = c ∷ take n cs
  sws : _ → Bool
  sws c = is 32 c ∨ is 9 c ∨ is 10 c ∨ is 11 c ∨ is 12 c ∨ is 13 c
  rest : Str
  rest = dropWhile sws (take 512 body)
  starts : Str → Str → Bool
  starts [] _ = true
  starts (p ∷ ps) (c ∷ cs) = Data.Char.Base._≈ᵇ_ p (lowerAscii c) ∧ starts ps cs
    where import Data.Char.Base
  starts _ [] = false
  anyP : List String → Bool
  anyP []       = false
  anyP (p ∷ ps) = starts (toList p) rest ∨ anyP ps

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
  document (just t) = byTaken (takenMime t)
    where
    byTaken : Maybe Str → Kind
    byTaken nothing  = if sniffed then asHtml else asIs
    byTaken (just m) = if isHtmlType m then asHtml else if unknownMime m ∧ sniffed then asHtml else asIs
  document nothing  = if sniffed then asHtml else asIs
responseKind nothing nothing (just t) _ =
  if isHtmlType (essence t) then asHtml
  else if isJsType (essence t) then asJs
  else if isCssType (essence t) then asCss
  else asIs
responseKind nothing nothing nothing _ = asIs

------------------------------------------------------------------------
-- Whether a stylesheet applies (Chromium, checked: quirks-sheets-vs-
-- chromium): of type text/css (its essence), or — without
-- X-Content-Type-Options: nosniff — untyped (no Content-Type, or an empty
-- one), or any type in a quirks-mode document when the sheet is
-- same-origin. Under the proxy every sheet is same-origin, so a
-- cross-origin sheet of another type would apply in a quirks document
-- where directly it does not: the proxy adds nosniff to it (`addNosniff`;
-- Go: proxy addStylesheetNosniff), and then it applies exactly where it
-- would directly, in either mode (`proxied-sheet`, below). Not covered: a
-- Content-Type listing several types ("text/css,text/plain"), which Blink
-- reads by its first and, cross-origin under nosniff, ORB by its last.

applies : Bool → Bool → Bool → Bool → Bool → Bool
applies css untyped quirks sameOrigin nosniff = css ∨ (not nosniff ∧ (untyped ∨ (quirks ∧ sameOrigin)))

added : Bool → Bool → Bool → Bool → Bool
added css untyped sameOrigin nosniff = not sameOrigin ∧ not nosniff ∧ not css ∧ not untyped

cssTyped untypedSheet : Maybe Str → Bool
cssTyped (just t) = isCssType (essence t)
cssTyped nothing  = false
untypedSheet (just t) = Data.List.Base.null (essence t)
untypedSheet nothing  = true

sheetApplies : Bool → Bool → Maybe Str → Bool → Bool
sheetApplies quirks so ct ns = applies (cssTyped ct) (untypedSheet ct) quirks so ns

addNosniff : Bool → Maybe Str → Bool → Bool
addNosniff so ct ns = added (cssTyped ct) (untypedSheet ct) so ns

appliesLaw : ∀ c u q so ns → applies c u q true (ns ∨ added c u so ns) ≡ applies c u q so ns
appliesLaw true true true true true = refl
appliesLaw true true true true false = refl
appliesLaw true true true false true = refl
appliesLaw true true true false false = refl
appliesLaw true true false true true = refl
appliesLaw true true false true false = refl
appliesLaw true true false false true = refl
appliesLaw true true false false false = refl
appliesLaw true false true true true = refl
appliesLaw true false true true false = refl
appliesLaw true false true false true = refl
appliesLaw true false true false false = refl
appliesLaw true false false true true = refl
appliesLaw true false false true false = refl
appliesLaw true false false false true = refl
appliesLaw true false false false false = refl
appliesLaw false true true true true = refl
appliesLaw false true true true false = refl
appliesLaw false true true false true = refl
appliesLaw false true true false false = refl
appliesLaw false true false true true = refl
appliesLaw false true false true false = refl
appliesLaw false true false false true = refl
appliesLaw false true false false false = refl
appliesLaw false false true true true = refl
appliesLaw false false true true false = refl
appliesLaw false false true false true = refl
appliesLaw false false true false false = refl
appliesLaw false false false true true = refl
appliesLaw false false false true false = refl
appliesLaw false false false false true = refl
appliesLaw false false false false false = refl

-- Proxied (same-origin, nosniff added where `addNosniff` says) a sheet
-- applies exactly where it does directly.
proxied-sheet : ∀ quirks so ct ns → sheetApplies quirks true ct (ns ∨ addNosniff so ct ns) ≡ sheetApplies quirks so ct ns
proxied-sheet quirks so ct ns = appliesLaw (cssTyped ct) (untypedSheet ct) quirks so ns
