{-# OPTIONS --safe #-}
-- Client hints (RFC 8942, UA-CH) as Chromium handles them, and what the
-- proxy does with them (Go: proxy/client_hints.go). Checked against
-- Chromium: hints-vs-chromium.
--
--   * Accept-CH is a Structured Fields list (RFC 8941 §4.2.1; its field
--     lines joined with ", "). Each member must be a token, or an inner
--     list of exactly one token (parameters are ignored); names match
--     case-insensitively. A list that does not parse, or a member of any
--     other kind (a string, a number, a boolean, a byte sequence, a longer
--     inner list), makes the header count for nothing.
--   * On a secure top-level navigation's response, a valid Accept-CH
--     replaces the origin's set (an empty one clears it); an invalid one,
--     or none, leaves it as it was.
--   * A request carries the low-entropy hints (sec-ch-ua, -mobile,
--     -platform) always, and another hint only when its target is secure,
--     its origin's set names it, and it is a top-level navigation or a
--     request to the page's own origin. The proxy drops the others: through
--     it every site is one origin to the browser, which would send one
--     site's hints to all.
module Hints where

open import Data.Bool.Base using (Bool; true; false; _∨_; _∧_; not; if_then_else_)
open import Data.Char.Base using (Char)
open import Data.List.Base using (List; []; _∷_; _++_; map; reverse)
open import Data.Maybe.Base using (Maybe; just; nothing)
open import Data.Nat.Base using (ℕ; zero; suc)
open import Data.Product.Base using (_×_; _,_)
open import Data.String.Base using (String; toList)

open import Url using (Str; is; isAlpha; isDigit; within; lowerAscii; eqStr)

open import Sf using (Bare; token; Member; item; inner; sfList; joinLines)


------------------------------------------------------------------------
-- Accept-CH.

-- The hint names (lowercase) an Accept-CH asks for, or nothing when it
-- counts for nothing.
acceptCH : List Str → Maybe (List Str)
acceptCH lines with sfList (joinLines lines)
... | nothing = nothing
... | just ms = names ms
  where
  names : List Member → Maybe (List Str)
  names [] = just []
  names (item (token t) ∷ rest) = cons (map lowerAscii t) (names rest)
    where
    cons : Str → Maybe (List Str) → Maybe (List Str)
    cons x (just xs) = just (x ∷ xs)
    cons x nothing   = nothing
  names (inner (token t ∷ []) ∷ rest) = cons (map lowerAscii t) (names rest)
    where
    cons : Str → Maybe (List Str) → Maybe (List Str)
    cons x (just xs) = just (x ∷ xs)
    cons x nothing   = nothing
  names (_ ∷ _) = nothing

-- The origin's set after a secure top-level navigation's response
-- (lines: its Accept-CH field lines; none at all: nothing changes).
updateSet : List Str → List Str → List Str
updateSet old []        = old
updateSet old (l ∷ ls) with acceptCH (l ∷ ls)
... | just new = new
... | nothing  = old

------------------------------------------------------------------------
-- Which hints a request carries upstream.

lowEntropy : Str → Bool
lowEntropy h = eqStr h (toList "sec-ch-ua") ∨ eqStr h (toList "sec-ch-ua-mobile") ∨ eqStr h (toList "sec-ch-ua-platform")

memberS : Str → List Str → Bool
memberS x []       = false
memberS x (y ∷ ys) = eqStr x y ∨ memberS x ys

-- hint: a hint header's name (lowercase); set: the target origin's;
-- secure: the target is https; navigation: a top-level document request;
-- samePage: the request's page is of the target's origin.
hintSent : Str → List Str → Bool → Bool → Bool → Bool
hintSent hint set secure navigation samePage =
  lowEntropy hint ∨ (secure ∧ (navigation ∨ samePage) ∧ memberS hint set)

------------------------------------------------------------------------
-- The low-entropy Sec-CH-UA a Chrome of major version m sends (UA-CH
-- "create arbitrary brands", as Chromium does it — user_agent_utils): the
-- GREASE brand "Not" c₁ "A" c₂ "Brand" with c₁, c₂ from
-- [ ( : - . / ) ; = ? _] at m and m + 1 (mod 11), its version 8 / 99 / 24
-- at m (mod 3); the three brands — GREASE, "Chromium", the product's —
-- placed by the permutation m (mod 6). Checked against Chromium
-- (hints-vs-chromium). The proxy sends it when the browser's request has
-- none (Go: upstream ensureClientHints).

open import Data.Nat.Base using (_%_)
open import Url using (showN)

greaseChar : ℕ → Char
greaseChar 0 = ' '
greaseChar 1 = '('
greaseChar 2 = ':'
greaseChar 3 = '-'
greaseChar 4 = '.'
greaseChar 5 = '/'
greaseChar 6 = ')'
greaseChar 7 = ';'
greaseChar 8 = '='
greaseChar 9 = '?'
greaseChar _ = '_'

greaseVersion : ℕ → Str
greaseVersion 0 = toList "8"
greaseVersion 1 = toList "99"
greaseVersion _ = toList "24"

-- The positions of (GREASE, Chromium, product) for m mod 6.
positions : ℕ → ℕ × ℕ × ℕ
positions 0 = 0 , 1 , 2
positions 1 = 0 , 2 , 1
positions 2 = 1 , 0 , 2
positions 3 = 1 , 2 , 0
positions 4 = 2 , 0 , 1
positions _ = 2 , 1 , 0

brandEntry : Str → Str → Str
brandEntry name v = '"' ∷ name ++ toList "\";v=\"" ++ v ++ '"' ∷ []

secChUa : ℕ → Str → Str
secChUa m product = place (positions (m % 6))
  where
  grease : Str
  grease = brandEntry (toList "Not" ++ greaseChar (m % 11) ∷ 'A' ∷ greaseChar ((suc m) % 11) ∷ toList "Brand") (greaseVersion (m % 3))
  chromium : Str
  chromium = brandEntry (toList "Chromium") (showN m)
  prod : Str
  prod = brandEntry product (showN m)
  at : ℕ → ℕ × ℕ × ℕ → Str
  at k (g , c , p) = if Data.Nat.Base._≡ᵇ_ g k then grease else if Data.Nat.Base._≡ᵇ_ c k then chromium else prod
    where import Data.Nat.Base
  place : ℕ × ℕ × ℕ → Str
  place ps = at 0 ps ++ toList ", " ++ at 1 ps ++ toList ", " ++ at 2 ps
