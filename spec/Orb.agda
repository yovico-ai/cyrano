{-# OPTIONS --safe #-}
------------------------------------------------------------------------
-- Opaque Response Blocking, as Chromium does it for a script (ORB "v0.1":
-- its CORB-era sniffers), and what the proxy does about it.
--
-- A page's <script> to another origin is a no-cors request: Chromium
-- blocks the response — the element gets a network error — when its MIME
-- type is one never served as script (PDF, protobuf, event streams…), or
-- when its body looks like HTML, XML or JSON. Through the proxy every
-- request is same-origin and nothing is blocked: a cross-origin JSON
-- answer ran as script (a load event and a SyntaxError where directly
-- there is an error event; Lenovo's /leid/assign, found 2026-11-20).
--
-- The decision (`blocks`), checked against Chromium (orb-vs-chromium:
-- a cross-origin script fails exactly when this blocks or the same
-- response fails same-origin):
--   * no Content-Type (or none ORB can read: Disposition takenMime, the
--     last type of a list) → never blocked;
--   * a never-sniffed type → blocked;
--   * a safelisted one (text/css, text/vtt, application/dash+xml…) and
--     the media types → not (a script of a media type fails anyway);
--   * otherwise — JavaScript types too, nosniff or not — by the first
--     1024 bytes: blocked when they sniff as HTML, XML or JSON, or begin
--     with a JSON parser breaker.
-- Sniffing: whitespace is space, tab, CR, LF (not VT, FF). HTML: after
-- whitespace, one of the signatures as an ASCII case-insensitive prefix
-- ("<b" takes "<bra>"), or a comment "<!--…-->" ended by CR or LF and
-- then again; a comment ended otherwise, or a signature cut off by the
-- window, decides nothing (not blocked). XML: "<?xml", case-sensitive,
-- after whitespace. JSON: "{", whitespace, a string (backslash escapes),
-- whitespace, ":". Parser breakers, at the very start: ")]}'", "{}&&",
-- "{} &&".
--
-- The proxy cannot see the page's mode: it forces crossorigin on scripts
-- (Attrs crossoriginValue), so the browser always asks in cors mode. It
-- blocks — breaks the connection — a cross-origin script response that
-- `blocks` and carries no Access-Control-Allow-Origin (`proxyBlocks`).
-- Without that header a cors-mode request fails its CORS check natively
-- anyway, so this is exact for no-cors and never wrong where the proxy
-- was right before (`exactNoCors`, `neverWorse`). Not covered: a
-- response with Access-Control-Allow-Origin (the mode decides), range
-- responses, other destinations (images, media).
------------------------------------------------------------------------
module Orb where

open import Data.Bool.Base using (Bool; true; false; _∨_; _∧_; not; if_then_else_)
open import Data.List.Base using (List; []; _∷_; take)
open import Data.Maybe.Base using (Maybe; just; nothing)
open import Data.String.Base using (String; toList)
open import Data.Char.Base using (Char)
open import Data.Nat.Base using (ℕ)
open import Relation.Binary.PropositionalEquality using (_≡_; refl)

open import Url using (Str; is; eqStr; lowerAscii)
open import Disposition using (inS; takenMime)

sniffWindow : ℕ
sniffWindow = 1024

------------------------------------------------------------------------
-- MIME classes (essences, lower-case)

neverSniffed : Str → Bool
neverSniffed m = inS m
  ( "application/gzip" ∷ "application/x-gzip" ∷ "application/zip" ∷ "application/x-zip-compressed"
  ∷ "application/pdf" ∷ "application/x-protobuf" ∷ "application/x-protobuffer"
  ∷ "application/msexcel" ∷ "application/mspowerpoint" ∷ "application/msword" ∷ "application/msword-template"
  ∷ "application/vnd.ms-excel" ∷ "application/vnd.ms-powerpoint" ∷ "application/vnd.ms-word"
  ∷ "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  ∷ "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ∷ "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  ∷ "multipart/byteranges" ∷ "multipart/signed" ∷ "text/event-stream" ∷ "text/csv" ∷ [])

safelisted : Str → Bool
safelisted m = inS m
  ( "text/css" ∷ "text/vtt" ∷ "image/svg+xml" ∷ "application/dash+xml"
  ∷ "application/vnd.apple.mpegurl" ∷ "audio/mpegurl" ∷ "audio/x-mpegurl" ∷ "application/x-mpegurl" ∷ [])

-- image/…, audio/…, video/…
media : Str → Bool
media m = pre (toList "image/") m ∨ pre (toList "audio/") m ∨ pre (toList "video/") m
  where
  pre : Str → Str → Bool
  pre [] _ = true
  pre (_ ∷ _) [] = false
  pre (p ∷ ps) (c ∷ cs) = eqStr (p ∷ []) (c ∷ []) ∧ pre ps cs

------------------------------------------------------------------------
-- Sniffers

data Sniff : Set where
  yes no maybe : Sniff

wsC : Char → Bool
wsC c = is 32 c ∨ is 9 c ∨ is 10 c ∨ is 13 c

skipWs : Str → Str
skipWs [] = []
skipWs (c ∷ cs) = if wsC c then skipWs cs else c ∷ cs

chEq : Char → Char → Bool
chEq a b = eqStr (a ∷ []) (b ∷ [])

-- p a prefix of s: yes; s ends inside p: maybe; else no. `ci`: ASCII
-- case-insensitive (p lower-case).
prefix : Bool → Str → Str → Sniff
prefix ci [] _ = yes
prefix ci (_ ∷ _) [] = maybe
prefix ci (p ∷ ps) (c ∷ cs) = if chEq p (if ci then lowerAscii c else c) then prefix ci ps cs else no

-- First of the list that is not `no`: yes wins over maybe.
anyOf : Bool → List String → Str → Sniff
anyOf ci [] s = no
anyOf ci (p ∷ ps) s with prefix ci (toList p) s
... | yes = yes
... | maybe = atLeastMaybe (anyOf ci ps s)
  where
  atLeastMaybe : Sniff → Sniff
  atLeastMaybe yes = yes
  atLeastMaybe _ = maybe
... | no = anyOf ci ps s

htmlSignatures : List String
htmlSignatures = "<!doctype html" ∷ "<script" ∷ "<html" ∷ "<head" ∷ "<iframe" ∷ "<h1" ∷ "<div" ∷ "<font"
  ∷ "<table" ∷ "<a" ∷ "<style" ∷ "<title" ∷ "<b" ∷ "<body" ∷ "<br" ∷ "<p" ∷ []

-- A comment "<!--" … "-->" followed by CR or LF: the rest after it;
-- else why not.
skipComment : Str → Maybe Str
skipComment s with prefix false (toList "<!--") s
... | yes = after (Data.List.Base.drop 4 s)
  where
  after : Str → Maybe Str
  after [] = nothing
  after (a ∷ []) = nothing
  after (a ∷ b ∷ []) = nothing
  after (a ∷ b ∷ c ∷ []) = nothing
  after (a ∷ b ∷ c ∷ d ∷ rest) =
    if is 45 a ∧ is 45 b ∧ is 62 c then (if is 10 d ∨ is 13 d then just (d ∷ rest) else nothing)
    else after (b ∷ c ∷ d ∷ rest)
... | _ = nothing

-- Fuel: each round consumes a comment (≥ 7 characters).
sniffHtmlF : ℕ → Str → Sniff
sniffHtmlF ℕ.zero _ = maybe
sniffHtmlF (ℕ.suc n) s with anyOf true htmlSignatures (skipWs s)
... | yes = yes
... | maybe = maybe
... | no with skipComment (skipWs s)
...   | just rest = sniffHtmlF n rest
...   | nothing = no

sniffHtml : Str → Sniff
sniffHtml s = sniffHtmlF sniffWindow s

sniffXml : Str → Sniff
sniffXml s = prefix false (toList "<?xml") (skipWs s)

-- "{" ws string ws ":"
sniffJson : Str → Sniff
sniffJson s = open₁ (skipWs s)
  where
  colon : Str → Sniff
  colon s' with skipWs s'
  ... | [] = maybe
  ... | (c ∷ _) = if is 58 c then yes else no
  str : Str → Sniff
  str [] = maybe
  str (c ∷ cs) = if is 92 c then esc cs else if is 34 c then colon cs else str cs
    where
    esc : Str → Sniff
    esc [] = maybe
    esc (_ ∷ r) = str r
  key : Str → Sniff
  key s' with skipWs s'
  ... | [] = maybe
  ... | (c ∷ cs) = if is 34 c then str cs else no
  open₁ : Str → Sniff
  open₁ [] = maybe
  open₁ (c ∷ cs) = if is 123 c then key cs else no

breaker : Str → Bool
breaker s = isYes (anyOf false (")]}'" ∷ "{}&&" ∷ "{} &&" ∷ []) s)
  where
  isYes : Sniff → Bool
  isYes yes = true
  isYes _ = false

------------------------------------------------------------------------
-- The decision, and the proxy's

yesOf : Sniff → Bool
yesOf yes = true
yesOf _ = false

sniffsBlocked : Str → Bool
sniffsBlocked body = breaker w ∨ yesOf (sniffHtml w) ∨ yesOf (sniffXml w) ∨ yesOf (sniffJson w)
  where
  w = take sniffWindow body

-- contentType: the response's Content-Type field value, if any.
blocks : Maybe Str → Str → Bool
blocks nothing _ = false
blocks (just ct) body with takenMime ct
... | nothing = false
... | just m = neverSniffed m ∨ (not (safelisted m) ∧ not (media m) ∧ sniffsBlocked body)

-- A cross-origin script response the proxy fails (a broken connection):
-- ORB blocks it and no Access-Control-Allow-Origin came with it. A
-- redirect is never judged — the browser follows it, and ORB looks at the
-- response it ends at (adform's trackpoint script: a 301 with an HTML
-- body; failed, it loaded directly).
proxyBlocks : Bool → Bool → Maybe Str → Bool → Str → Bool
proxyBlocks crossOrigin redirect ct hasAcao body = crossOrigin ∧ not redirect ∧ not hasAcao ∧ blocks ct body

------------------------------------------------------------------------
-- Why only without Access-Control-Allow-Origin (for a response that is
-- not a redirect: a redirect is never judged, natively or here, so there
-- is nothing to compare). Whether the script runs
-- (`mimeOk`: the same response would run same-origin), natively and
-- through the proxy, by the page's mode; `acaoOk`: the CORS check passes,
-- which needs the header (acaoOk = hasAcao ∧ k).

native : Bool → Bool → Bool → Bool → Bool
native noCors acaoOk blocked mimeOk = if noCors then not blocked ∧ mimeOk else acaoOk ∧ mimeOk

before after : Bool → Bool → Bool → Bool
before hasAcao blocked mimeOk = mimeOk
after hasAcao blocked mimeOk = not (not hasAcao ∧ blocked) ∧ mimeOk

exactNoCors : ∀ blocked mimeOk → after false blocked mimeOk ≡ native true false blocked mimeOk
exactNoCors true  true  = refl
exactNoCors true  false = refl
exactNoCors false true  = refl
exactNoCors false false = refl

-- Wherever the proxy answered as natively before, it still does.
neverWorse : Bool
neverWorse = all5 λ nc h k b m →
  implies (eqB (before h b m) (native nc (h ∧ k) b m)) (eqB (after h b m) (native nc (h ∧ k) b m))
  where
  eqB : Bool → Bool → Bool
  eqB true true = true
  eqB false false = true
  eqB _ _ = false
  implies : Bool → Bool → Bool
  implies true x = x
  implies false _ = true
  all1 : (Bool → Bool) → Bool
  all1 f = f true ∧ f false
  all5 : (Bool → Bool → Bool → Bool → Bool → Bool) → Bool
  all5 f = all1 λ a → all1 λ b → all1 λ c → all1 λ d → all1 λ e → f a b c d e

neverWorseHolds : neverWorse ≡ true
neverWorseHolds = refl
