{-# OPTIONS --safe #-}
-- A Refresh header's value and a <meta http-equiv=refresh content>, read
-- as Chromium reads them (Blink ParseHTTPRefresh; checked:
-- refresh-vs-chromium), and rewritten by the proxy so the refresh
-- navigates through it (Go: urlrewrite.RewriteRefresh, for the header and
-- the markup; the client: html-rewriter's <meta>).
--
-- Chromium departs from HTML's "shared declarative refresh steps": the
-- time is the leading run of digits and "." and must hold a digit (".5"
-- and "0.5.5" are times, "." is not); "url" is skipped only when "="
-- follows (whitespace around it aside), else the URL starts at "url"; a
-- quoted URL runs to the last matching quote (to the end when there is
-- none); the URL is trimmed of whitespace, and an empty one is a reload.
--
--   value = *WS time [ ( ";" / "," / WS ) *WS [ ";" / "," ] *WS url-part ]
--
-- Not a refresh: nothing but whitespace, no digit in the time, a
-- character after it that is not ";", "," or whitespace. Rewriting edits
-- the URL where it stands; anything else is left as written.
module Refresh where

open import Data.Bool.Base using (Bool; true; false; _∨_; _∧_; not; if_then_else_)
open import Data.Char.Base using (Char)
open import Data.List.Base using (List; []; _∷_; _++_; reverse)
open import Data.Maybe.Base using (Maybe; just; nothing)
open import Data.Nat.Base using (ℕ; zero; suc)
open import Data.Product.Base using (_×_; _,_)

open import Url using (Str; is; isDigit; lowerAscii)

data Reading : Set where
  notRefresh : Reading
  reload     : Reading
  navigate   : Str → Str → Str → Reading   -- before the URL, the URL, after it

ws : Char → Bool
ws c = is 9 c ∨ is 10 c ∨ is 12 c ∨ is 13 c ∨ is 32 c

-- Split off a prefix of characters p accepts: (prefix, rest).
span : (Char → Bool) → Str → Str × Str
span p [] = [] , []
span p (c ∷ cs) with p c
... | false = [] , c ∷ cs
... | true with span p cs
...   | a , b = c ∷ a , b

sepChar : Char → Bool
sepChar c = is 59 c ∨ is 44 c

anyDigit : Str → Bool
anyDigit []       = false
anyDigit (c ∷ cs) = isDigit c ∨ anyDigit cs

eqChar : Char → Char → Bool
eqChar a b = Data.Nat.Base._≡ᵇ_ (Data.Char.Base.toℕ a) (Data.Char.Base.toℕ b)
  where import Data.Nat.Base; import Data.Char.Base

-- Split at the last c: (before, c and after), or nothing.
splitLastC : Char → Str → Maybe (Str × Str)
splitLastC c s with span (λ d → not (eqChar d c)) (reverse s)
... | (_ , [])         = nothing
... | (tailR , q ∷ headR) = just (reverse headR , q ∷ reverse tailR)

-- Trim whitespace at both ends: (leading, middle, trailing).
trim3 : Str → Str × Str × Str
trim3 s with span ws s
... | (l , m) with span ws (reverse m)
...   | (tr , mr) = l , reverse mr , reverse tr

-- The URL, from its start (after "url=", or at "url" when no "=").
-- Returns what precedes it, it, and what follows.
fromStart : Str → Str × Str × Str
fromStart (q ∷ cs) =
  if is 39 q ∨ is 34 q then quotedUrl (splitLastC q cs) else plainUrl (q ∷ cs)
  where
  plainUrl : Str → Str × Str × Str
  plainUrl t with trim3 t
  ... | (l , m , r) = l , m , r
  quotedUrl : Maybe (Str × Str) → Str × Str × Str
  quotedUrl (just (inside , closing)) with trim3 inside
  ... | (l , m , r) = (q ∷ l) , m , (r ++ closing)
  quotedUrl nothing with trim3 cs
  ... | (l , m , r) = (q ∷ l) , m , r
fromStart [] = [] , [] , []

-- "url" *WS "=" *WS, else the URL starts at "url".
urlPart : Str → Str × Str × Str
urlPart (u ∷ r ∷ l ∷ rest) with is 117 (lowerAscii u) ∧ is 114 (lowerAscii r) ∧ is 108 (lowerAscii l)
... | false = fromStart (u ∷ r ∷ l ∷ rest)
... | true with span ws rest
...   | (w₁ , e ∷ rest₁) =
  if is 61 e then afterEq (u ∷ r ∷ l ∷ w₁ ++ e ∷ []) rest₁ else fromStart (u ∷ r ∷ l ∷ rest)
  where
  afterEq : Str → Str → Str × Str × Str
  afterEq pre t with span ws t
  ... | (w₂ , t₂) with fromStart t₂
  ...   | (p , m , q) = (pre ++ w₂ ++ p) , m , q
...   | (w₁ , []) = fromStart (u ∷ r ∷ l ∷ rest)
urlPart s = fromStart s

read : Str → Reading
read s with span ws s
... | (w₀ , []) = notRefresh
... | (w₀ , r₀) with span (λ c → isDigit c ∨ is 46 c) r₀
...   | (time , r₁) = if anyDigit time then afterTime r₁ else notRefresh
  where
  pre₀ : Str
  pre₀ = w₀ ++ time
  afterSep : Str → Str → Reading
  afterSep pre t with span ws t
  ... | (b , t₂) with urlPart t₂
  ...   | (p , [] , q) = reload
  ...   | (p , m ∷ ms , q) = navigate (pre ++ b ++ p) (m ∷ ms) q
  afterTime : Str → Reading
  afterTime [] = reload
  afterTime (c ∷ r₂) =
    if not (sepChar c ∨ ws c) then notRefresh else separators (c ∷ r₂)
    where
    separators : Str → Reading
    separators t with span ws t
    ... | (a , d ∷ t₁) = if sepChar d then afterSep (pre₀ ++ a ++ d ∷ []) t₁ else afterSep (pre₀ ++ a) (d ∷ t₁)
    ... | (a , []) = reload

-- The value rewritten: rw gives the URL's proxified form (nothing: kept).
rewriteRefresh : (Str → Maybe Str) → Str → Str
rewriteRefresh rw s with read s
... | navigate pre u post with rw u
...   | just v  = pre ++ v ++ post
...   | nothing = s
rewriteRefresh rw s | _ = s
