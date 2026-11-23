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
--     is HTML when its MIME type is HTML (XML when it is an XML type:
--     isXmlType, spec/XmlDoc.agda), or when it has none Chromium
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
open import Data.Product.Base using (_,_)
import Url
open import Data.Nat.Base using (ℕ; zero; suc)
open import Containment using (Dest; destScript; destStyle; destFrame; destInert; destImageSet)
open import Relation.Binary.PropositionalEquality using (_≡_; refl)

data Kind : Set where
  asJs asCss asHtml asXml asIs : Kind

kindName : Kind → String
kindName asJs   = "js"
kindName asCss  = "css"
kindName asHtml = "html"
kindName asXml  = "xml"
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
isHtmlType e = eqStr e (toList "text/html")

-- A document Chromium renders as an XML document (measured:
-- sniff-vs-chromium; it shows text/*+xml and the feeds application/rss+xml,
-- application/atom+xml as text, and downloads other types): text/xml,
-- application/xml, application/xhtml+xml, image/svg+xml — a feed in one of
-- them too. Such a document is rewritten as XML (spec/XmlDoc.agda; XHTML
-- too: the HTML rewriter's output need not be well-formed XML, and an
-- XHTML document that is not gets the browser's XML error page).
isXmlType : Str → Bool
isXmlType e = inS e ("text/xml" ∷ "application/xml" ∷ "application/xhtml+xml" ∷ "image/svg+xml" ∷ [])

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

-- Chromium's XML sniff (measured: sniff-vs-chromium): of an untyped or
-- unknown-typed document, after HTML sniffing, "<?xml" (this case only)
-- after the leading whitespace HTML sniffing skips is text/xml.
xmlMagic : Str → Bool
xmlMagic body = starts (toList "<?xml") (dropWhile sws body)
  where
  sws : _ → Bool
  sws c = is 32 c ∨ is 9 c ∨ is 10 c ∨ is 11 c ∨ is 12 c ∨ is 13 c
  starts : Str → Str → Bool
  starts [] _ = true
  starts (p ∷ ps) (c ∷ cs) = eqStr (p ∷ []) (c ∷ []) ∧ starts ps cs
  starts _ [] = false

-- dest: the URL's mark; sfd: Sec-Fetch-Dest (ASCII case aside; nothing:
-- the request had none); ct: the Content-Type (nothing: none); sn: what
-- the body's first bytes sniff as.
-- By the request alone (no mark, or the frame mark, which says nothing
-- of what the response is).
-- What the body's first bytes sniff as (sniffHtml, xmlMagic).
record Sniff : Set where
  constructor sniff
  field
    html xml : Bool
open Sniff public

sniffOf : Str → Sniff
sniffOf b = sniff (sniffHtml b) (xmlMagic b)

unmarked : Maybe Str → Maybe Str → Sniff → Kind
unmarked (just d₀) ct sn =
  if inS d ("script" ∷ "worker" ∷ "sharedworker" ∷ "serviceworker" ∷ "audioworklet" ∷ "paintworklet" ∷ []) then asJs
  else if eqStr d (toList "style") then asCss
  else if inS d ("document" ∷ "iframe" ∷ "frame" ∷ "embed" ∷ "object" ∷ []) then document ct
  else asIs
  where
  d : Str
  d = map lowerAscii d₀
  -- An untyped or unknown-typed document: HTML sniffed first, then XML's magic.
  sniffed : Kind
  sniffed = if html sn then asHtml else if xml sn then asXml else asIs
  document : Maybe Str → Kind
  document (just t) = byTaken (takenMime t)
    where
    byTaken : Maybe Str → Kind
    byTaken nothing  = sniffed
    byTaken (just m) =
      if isHtmlType m then asHtml
      else if isXmlType m then asXml
      else if unknownMime m then sniffed
      else asIs
  document nothing  = sniffed
unmarked nothing (just t) _ =
  if isHtmlType (essence t) then asHtml
  else if eqStr (essence t) (toList "application/xhtml+xml") then asXml
  else if isJsType (essence t) then asJs
  else if isCssType (essence t) then asCss
  else asIs
unmarked nothing nothing _ = asIs

responseKind : Maybe Dest → Maybe Str → Maybe Str → Sniff → Kind
responseKind (just destScript) _ _ _ = asJs
responseKind (just destStyle)  _ _ _ = asCss
responseKind (just destFrame)  sfd ct sn = unmarked sfd ct sn
responseKind (just destInert)  sfd ct sn = unmarked sfd ct sn
responseKind (just destImageSet) sfd ct sn = unmarked sfd ct sn
responseKind nothing           sfd ct sn = unmarked sfd ct sn

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

-- Whether a response's X-Content-Type-Options says nosniff (Fetch
-- "determine nosniff"): its field lines combined and split on ",", each
-- value HTTP-whitespace-trimmed; the first value, ASCII case aside, is
-- "nosniff" ("nosniff;x", "foo, nosniff" are not). Checked against
-- Chromium (quirks-sheets-vs-chromium). Go: proxy.hasNosniff.
nosniff : List Str → Bool
nosniff lines = first (Url.splitOn (is 44) (joinC lines))
  where
  joinC : List Str → Str
  joinC [] = []
  joinC (x ∷ []) = x
  joinC (x ∷ xs) = x Data.List.Base.++ (',' ∷ joinC xs)
  ws : _ → Bool
  ws c = is 32 c ∨ is 9 c
  trim : Str → Str
  trim t = reverse (dropWhile ws (reverse (dropWhile ws t)))
  first : List Str → Bool
  first [] = false
  first (v ∷ _) = eqStr (map lowerAscii (trim v)) (toList "nosniff")

-- Proxied (same-origin, nosniff added where `addNosniff` says) a sheet
-- applies exactly where it does directly.
proxied-sheet : ∀ quirks so ct ns → sheetApplies quirks true ct (ns ∨ addNosniff so ct ns) ≡ sheetApplies quirks so ct ns
proxied-sheet quirks so ct ns = appliesLaw (cssTyped ct) (untypedSheet ct) quirks so ns

------------------------------------------------------------------------
-- The destination a request is judged by (responseKind's sfd): its
-- Sec-Fetch-Dest — but a prefetch for no particular destination is one
-- for a navigation. `<link rel=prefetch>` (and an "instant page" script's)
-- asks with Sec-Fetch-Dest empty and Sec-Purpose: prefetch, and Chromium
-- serves the navigation to that URL from it while it is fresh (measured):
-- answered as data, the origin's page became the proxied document, every
-- subresource and its next link off the proxy (togaze.com). Judged as a
-- document, it is HTML only when it is (its type or sniff); a prefetched
-- script or JSON stays as sent, and the runtime's own fetch() of a URL
-- goes under another one (it never reuses the prefetch).
-- A prefetch: Sec-Purpose's first member is the token "prefetch"
-- (Structured Fields: up to ";" or ",", spaces and tabs around it).
isPrefetch : Str → Bool
isPrefetch v = eqStr (trim (upTo v)) (toList "prefetch")
  where
  upTo : Str → Str
  upTo [] = []
  upTo (c ∷ cs) = if Url.is 59 c ∨ Url.is 44 c then [] else c ∷ upTo cs
  dropWs : Str → Str
  dropWs [] = []
  dropWs (c ∷ cs) = if Url.is 32 c ∨ Url.is 9 c then dropWs cs else c ∷ cs
  trim : Str → Str
  trim s = Data.List.Base.reverse (dropWs (Data.List.Base.reverse (dropWs s)))

judgedDest : Maybe Str → Maybe Str → Maybe Str
judgedDest (just d) (just p) = if eqStr (map lowerAscii d) (toList "empty") ∧ isPrefetch p then just (toList "document") else just d
judgedDest sfd _ = sfd
