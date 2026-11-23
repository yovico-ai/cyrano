{-# OPTIONS --safe #-}
------------------------------------------------------------------------
-- A cookie's Expires date, as Chromium reads it (owner 2026-11-23).
--
-- Chromium does not follow RFC 6265bis §5.1.1 here but its own
-- ParseCookieExpirationTime (net/cookies/cookie_util.cc), which this is,
-- checked against Chromium (cookie-date-vs-chromium: cookieStore.get
-- reports the expiry the browser stored for each string):
--
--   * the string is cut into tokens at the delimiters — tab, and every
--     ASCII punctuation character but ':' (space included);
--   * a token not starting with a digit names the month when it is the
--     first such that begins (ASCII case aside) with a month's three
--     letters ("October", "Janué"); others are ignored;
--   * a token starting with a digit and holding a ':' is the time when no
--     time was found yet and it reads as sscanf "%2u:%2u:%2u" — 1 or 2
--     digits, ':', 1 or 2 digits, ':', 1 or 2 digits, anything after —
--     whatever the values ("9:99:9" is taken, and then fails);
--   * any other token starting with a digit is the day when none was
--     found yet and it is at most 2 octets long (UTF-8: "1é" is 3), else
--     the year when none was found yet and it is at most 5 octets — each
--     the value of its leading digits (atoi: "1x" is 1);
--   * without all four, no date (the cookie is a session cookie);
--   * a year 70–99 is 1900 more, 0–69 2000 more;
--   * a date that is no calendar date (day 0, 30 February, 24:00, a 60th
--     second) is none — at any year, never saturated;
--   * any other is that instant, proleptic Gregorian, UTC.
--
-- The instant is in seconds after the epoch; one before it is 0 (in the
-- past either way: the caller caps the future at 400 days).
------------------------------------------------------------------------

module CookieDate where

open import Data.Bool.Base using (Bool; true; false; _∧_; _∨_; not; if_then_else_)
open import Data.Char.Base using (Char; toℕ)
open import Data.List.Base using (List; []; _∷_; reverse)
open import Data.Maybe.Base using (Maybe; just; nothing)
open import Data.Nat.Base using (ℕ; zero; suc; _+_; _*_; _∸_; _<ᵇ_; _≤ᵇ_; _/_; _%_)
open import Data.Product.Base using (_×_; _,_)
open import Data.String.Base using (String; toList)

open import Url using (Str; is; within; isDigit; lowerAscii)
open import Cookies using (octets)

------------------------------------------------------------------------
-- Tokens.

-- "\t !\"#$%&'()*+,-./;<=>?@[\\]^_`{|}~": tab, and ASCII punctuation but ':'.
delimiter : Char → Bool
delimiter c = is 9 c ∨ within 32 47 c ∨ within 59 64 c ∨ within 91 96 c ∨ within 123 126 c

tokens : Str → List Str
tokens s = go s [] []
  where
  -- cur: the token so far, reversed; acc: the tokens, reversed.
  flush : Str → List Str → List Str
  flush []      acc = acc
  flush (c ∷ r) acc = reverse (c ∷ r) ∷ acc
  go : Str → Str → List Str → List Str
  go []       cur acc = reverse (flush cur acc)
  go (c ∷ cs) cur acc = if delimiter c then go cs [] (flush cur acc) else go cs (c ∷ cur) acc

digitVal : Char → ℕ
digitVal c = toℕ c ∸ 48

-- atoi: the value of the leading digits.
atoi : Str → ℕ
atoi s = go s 0
  where
  go : Str → ℕ → ℕ
  go []       n = n
  go (c ∷ cs) n = if isDigit c then go cs (n * 10 + digitVal c) else n

-- %2u: 1 or 2 digits, then the rest.
upTo2 : Str → Maybe (ℕ × Str)
upTo2 (a ∷ b ∷ r) = if isDigit a then (if isDigit b then just (digitVal a * 10 + digitVal b , r) else just (digitVal a , b ∷ r)) else nothing
upTo2 (a ∷ [])    = if isDigit a then just (digitVal a , []) else nothing
upTo2 []          = nothing

colon : Str → Maybe Str
colon (c ∷ r) = if is 58 c then just r else nothing
colon []      = nothing

-- sscanf "%2u:%2u:%2u" == 3
timeOf : Str → Maybe (ℕ × ℕ × ℕ)
timeOf s with upTo2 s
... | nothing = nothing
... | just (h , r1) with colon r1
...   | nothing = nothing
...   | just r2 with upTo2 r2
...     | nothing = nothing
...     | just (m , r3) with colon r3
...       | nothing = nothing
...       | just r4 with upTo2 r4
...         | nothing = nothing
...         | just (sec , _) = just (h , m , sec)

hasColon : Str → Bool
hasColon []       = false
hasColon (c ∷ cs) = is 58 c ∨ hasColon cs

months : List String
months = "jan" ∷ "feb" ∷ "mar" ∷ "apr" ∷ "may" ∷ "jun" ∷ "jul" ∷ "aug" ∷ "sep" ∷ "oct" ∷ "nov" ∷ "dec" ∷ []

-- The month (1–12) a token begins with.
monthOf : Str → Maybe ℕ
monthOf t = go months 1
  where
  begins : Str → Str → Bool
  begins []       _        = true
  begins (_ ∷ _)  []       = false
  begins (p ∷ ps) (c ∷ cs) = is (toℕ p) (lowerAscii c) ∧ begins ps cs
  go : List String → ℕ → Maybe ℕ
  go []       _ = nothing
  go (m ∷ ms) i = if begins (toList m) t then just i else go ms (suc i)

------------------------------------------------------------------------
-- The fields found.

record Found : Set where
  constructor mkFound
  field
    fDay   : Maybe ℕ
    fMonth : Maybe ℕ
    fTime  : Maybe (ℕ × ℕ × ℕ)
    fYear  : Maybe ℕ
open Found

none : Found
none = mkFound nothing nothing nothing nothing

isNothing : ∀ {A : Set} → Maybe A → Bool
isNothing nothing  = true
isNothing (just _) = false

step : Found → Str → Found
step f []      = f
step f (c ∷ cs) =
  if not (isDigit c) then
    (if isNothing (fMonth f) then mkFound (fDay f) (monthOf t) (fTime f) (fYear f) else f)
  else if hasColon t then
    (if isNothing (fTime f) then mkFound (fDay f) (fMonth f) (timeOf t) (fYear f) else f)
  else if isNothing (fDay f) ∧ (octets t ≤ᵇ 2) then mkFound (just (atoi t)) (fMonth f) (fTime f) (fYear f)
  else if isNothing (fYear f) ∧ (octets t ≤ᵇ 5) then mkFound (fDay f) (fMonth f) (fTime f) (just (atoi t))
  else f
  where
  t : Str
  t = c ∷ cs

fields : List Str → Found → Found
fields []       f = f
fields (t ∷ ts) f = fields ts (step f t)

------------------------------------------------------------------------
-- The calendar.

leap : ℕ → Bool
leap y = (y % 4 ≡ᵇ 0) ∧ (not (y % 100 ≡ᵇ 0) ∨ (y % 400 ≡ᵇ 0))
  where
  open import Data.Nat.Base using (_≡ᵇ_)

daysIn : ℕ → ℕ → ℕ
daysIn y 2 = if leap y then 29 else 28
daysIn y 4 = 30
daysIn y 6 = 30
daysIn y 9 = 30
daysIn y 11 = 30
daysIn y _ = 31

-- Days in the months before m.
before : ℕ → ℕ → ℕ
before y zero          = 0
before y (suc zero)    = 0
before y (suc (suc k)) = before y (suc k) + daysIn y (suc k)

-- Leap years in [1, n].
leapsTo : ℕ → ℕ
leapsTo n = n / 4 ∸ n / 100 + n / 400

-- Seconds after the epoch of a calendar instant (0 before it).
instant : ℕ → ℕ → ℕ → ℕ → ℕ → ℕ → ℕ
instant y mo d h mi s =
  if y <ᵇ 1970 then 0
  else (days * 86400 + h * 3600 + mi * 60 + s)
  where
  days : ℕ
  days = 365 * (y ∸ 1970) + (leapsTo (y ∸ 1) ∸ leapsTo 1969) + before y mo + (d ∸ 1)

valid : ℕ → ℕ → ℕ → ℕ → ℕ → ℕ → Bool
valid y mo d h mi s = (1 ≤ᵇ mo) ∧ (mo ≤ᵇ 12) ∧ (1 ≤ᵇ d) ∧ (d ≤ᵇ daysIn y mo) ∧ (h ≤ᵇ 23) ∧ (mi ≤ᵇ 59) ∧ (s ≤ᵇ 59)

fullYear : ℕ → ℕ
fullYear y = if (70 ≤ᵇ y) ∧ (y ≤ᵇ 99) then y + 1900 else if y ≤ᵇ 69 then y + 2000 else y

------------------------------------------------------------------------
-- The date: seconds after the epoch (0 before it), or nothing.

cookieDate : Str → Maybe ℕ
cookieDate s with fields (tokens s) none
... | mkFound (just d) (just mo) (just (h , mi , sec)) (just y0) =
  if valid y mo d h mi sec then just (instant y mo d h mi sec) else nothing
  where
  y : ℕ
  y = fullYear y0
... | _ = nothing

------------------------------------------------------------------------
-- Checks.

private
  open import Relation.Binary.PropositionalEquality using (_≡_; refl)

  ex1 : cookieDate (toList "Wed, 21 Oct 2026 07:28:00 GMT") ≡ just 1792567680
  ex1 = refl
  ex2 : cookieDate (toList "30 Feb 2027 00:00:00") ≡ nothing
  ex2 = refl
  ex3 : cookieDate (toList "1x Jan 2027 1:2:3x") ≡ just 1798765323
  ex3 = refl
  ex4 : cookieDate (toList "29 Feb 2028 0:0:0") ≡ just 1835395200
  ex4 = refl
  ex5 : cookieDate (toList "9:99:9 1:2:3 1 Jan 2027") ≡ nothing
  ex5 = refl
  ex6 : cookieDate (toList "1 Jan 1969 0:0:0") ≡ just 0
  ex6 = refl
