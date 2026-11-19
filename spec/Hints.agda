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

------------------------------------------------------------------------
-- RFC 8941: a list, as far as deciding which members are tokens.

data Bare : Set where
  token : Str → Bare
  other : Bare               -- a string, a number, a boolean, a byte sequence

data Member : Set where
  item  : Bare → Member
  inner : List Bare → Member

isLcalpha : Char → Bool
isLcalpha = within 97 122

tchar : Char → Bool
tchar c = isAlpha c ∨ isDigit c ∨ is 33 c ∨ is 35 c ∨ is 36 c ∨ is 37 c ∨ is 38 c ∨ is 39 c ∨ is 42 c ∨ is 43 c
        ∨ is 45 c ∨ is 46 c ∨ is 94 c ∨ is 95 c ∨ is 96 c ∨ is 124 c ∨ is 126 c

b64 : Char → Bool
b64 c = isAlpha c ∨ isDigit c ∨ is 43 c ∨ is 47 c ∨ is 61 c

-- Each step takes fuel (the input's length is enough).
Parse : Set → Set
Parse A = Str → Maybe (A × Str)

spanP : (Char → Bool) → Str → Str × Str
spanP p [] = [] , []
spanP p (c ∷ cs) with p c
... | false = [] , c ∷ cs
... | true with spanP p cs
...   | a , b = c ∷ a , b

-- A number: -? digits [ "." digits ] (the lengths are not checked: a
-- hint list holds none).
number : Parse Bare
number s with spanP isDigit (strip s)
  where
  strip : Str → Str
  strip (c ∷ cs) = if is 45 c then cs else c ∷ cs
  strip []       = []
... | ([] , _) = nothing
... | (_ ∷ _ , c ∷ rest) =
  if is 46 c then frac (spanP isDigit rest) else just (other , c ∷ rest)
  where
  frac : Str × Str → Maybe (Bare × Str)
  frac ([] , _)       = nothing
  frac (_ ∷ _ , rest₁) = just (other , rest₁)
... | (_ ∷ _ , []) = just (other , [])

-- A string, after its opening quote.
stringRest : ℕ → Parse Bare
stringRest zero _ = nothing
stringRest (suc n) [] = nothing
stringRest (suc n) (c ∷ cs) =
  if is 34 c then just (other , cs)
  else if is 92 c then escaped cs
  else if within 32 126 c then stringRest n cs
  else nothing
  where
  escaped : Str → Maybe (Bare × Str)
  escaped (d ∷ ds) = if is 34 d ∨ is 92 d then stringRest n ds else nothing
  escaped []       = nothing

bare : ℕ → Parse Bare
bare n [] = nothing
bare n (c ∷ cs) =
  if is 45 c ∨ isDigit c then number (c ∷ cs)
  else if is 34 c then stringRest n cs
  else if isAlpha c ∨ is 42 c then tok (spanP (λ d → tchar d ∨ is 58 d ∨ is 47 d) cs)
  else if is 58 c then bytes (spanP b64 cs)
  else if is 63 c then boolean cs
  else nothing
  where
  tok : Str × Str → Maybe (Bare × Str)
  tok (t , rest) = just (token (c ∷ t) , rest)
  bytes : Str × Str → Maybe (Bare × Str)
  bytes (_ , d ∷ rest) = if is 58 d then just (other , rest) else nothing
  bytes (_ , [])       = nothing
  boolean : Str → Maybe (Bare × Str)
  boolean (d ∷ rest) = if is 48 d ∨ is 49 d then just (other , rest) else nothing
  boolean []         = nothing

-- Parameters: *( ";" *SP key [ "=" bare ] ).
params : ℕ → Str → Maybe Str
params zero s = just s
params (suc n) (c ∷ cs) =
  if is 59 c then key (spanP (is 32) cs) else just (c ∷ cs)
  where
  keyRest : Char → Bool
  keyRest d = isLcalpha d ∨ isDigit d ∨ is 95 d ∨ is 45 d ∨ is 46 d ∨ is 42 d
  value : Str → Maybe Str
  value (e ∷ es) = if is 61 e then valued (bare n es) else params n (e ∷ es)
    where
    valued : Maybe (Bare × Str) → Maybe Str
    valued (just (_ , r)) = params n r
    valued nothing        = nothing
  value [] = just []
  key : Str × Str → Maybe Str
  key (_ , k ∷ ks) = if isLcalpha k ∨ is 42 k then afterKey (spanP keyRest ks) else nothing
    where
    afterKey : Str × Str → Maybe Str
    afterKey (_ , r) = value r
  key (_ , []) = nothing
params (suc n) [] = just []

-- An inner list, after "(".
innerRest : ℕ → List Bare → Str → Maybe (List Bare × Str)
innerRest zero _ _ = nothing
innerRest (suc n) acc s with spanP (is 32) s
... | (_ , []) = nothing
... | (sp , c ∷ cs) =
  if is 41 c then closed (params n cs)
  else if not (isEmpty sp) ∨ isEmpty acc then one (bare n (c ∷ cs))
  else nothing
  where
  isEmpty : {A : Set} → List A → Bool
  isEmpty []      = true
  isEmpty (_ ∷ _) = false
  closed : Maybe Str → Maybe (List Bare × Str)
  closed (just r) = just (reverse acc , r)
  closed nothing  = nothing
  one : Maybe (Bare × Str) → Maybe (List Bare × Str)
  one (just (b , r)) with params n r
  ... | just r′ = innerRest n (b ∷ acc) r′
  ... | nothing = nothing
  one nothing = nothing

member : ℕ → Parse Member
member n (c ∷ cs) =
  if is 40 c then fromInner (innerRest n [] cs) else fromItem (bare n (c ∷ cs))
  where
  fromInner : Maybe (List Bare × Str) → Maybe (Member × Str)
  fromInner (just (bs , r)) = just (inner bs , r)
  fromInner nothing         = nothing
  fromItem : Maybe (Bare × Str) → Maybe (Member × Str)
  fromItem (just (b , r)) with params n r
  ... | just r′ = just (item b , r′)
  ... | nothing = nothing
  fromItem nothing = nothing
member n [] = nothing

ows : Char → Bool
ows c = is 32 c ∨ is 9 c

-- The members, the leading SP already gone.
members : ℕ → Str → Maybe (List Member)
members zero _ = nothing
members (suc n) s with member n s
... | nothing = nothing
... | just (m , r) with spanP ows r
...   | (_ , []) = just (m ∷ [])
...   | (_ , c ∷ r₁) = if is 44 c then rest (spanP ows r₁) else nothing
  where
  rest : Str × Str → Maybe (List Member)
  rest (_ , []) = nothing                    -- a trailing comma
  rest (_ , t) with members n t
  ... | just ms = just (m ∷ ms)
  ... | nothing = nothing

len : Str → ℕ
len []       = zero
len (_ ∷ cs) = suc (len cs)

-- A field value: leading and trailing SP discarded; empty is an empty list.
sfList : Str → Maybe (List Member)
sfList s with spanP (is 32) s
... | (_ , t) with reverse (Data.Product.Base.proj₂ (spanP (is 32) (reverse t)))
  where import Data.Product.Base
...   | [] = just []
...   | u ∷ us = members (suc (len (u ∷ us))) (u ∷ us)

------------------------------------------------------------------------
-- Accept-CH.

joinLines : List Str → Str
joinLines []       = []
joinLines (x ∷ []) = x
joinLines (x ∷ xs) = x ++ ',' ∷ ' ' ∷ joinLines xs

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
