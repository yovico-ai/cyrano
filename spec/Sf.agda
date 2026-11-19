{-# OPTIONS --safe #-}
-- RFC 8941 Structured Field Values: lists and dictionaries, as far as the
-- headers cyrano reads need them (Accept-CH: Hints.agda; Permissions-Policy:
-- Permissions.agda). Parameters are read and dropped; a number's lengths
-- are not checked. Checked against Chromium through those modules.
module Sf where

open import Data.Bool.Base using (Bool; true; false; _∨_; _∧_; not; if_then_else_)
open import Data.Char.Base using (Char)
open import Data.List.Base using (List; []; _∷_; _++_; map; reverse)
open import Data.Maybe.Base using (Maybe; just; nothing)
open import Data.Nat.Base using (ℕ; zero; suc)
open import Data.Product.Base using (_×_; _,_)

open import Url using (Str; is; isAlpha; isDigit; within)

------------------------------------------------------------------------
------------------------------------------------------------------------
-- Bare items: a token's and a string's text; any other kind as other.

data Bare : Set where
  token  : Str → Bare
  string : Str → Bare        -- its characters, escapes undone
  other  : Bare              -- a number, a boolean, a byte sequence

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

-- A string, after its opening quote (acc: its characters so far, reversed).
stringRest : ℕ → Str → Parse Bare
stringRest zero _ _ = nothing
stringRest (suc n) acc [] = nothing
stringRest (suc n) acc (c ∷ cs) =
  if is 34 c then just (string (reverse acc) , cs)
  else if is 92 c then escaped cs
  else if within 32 126 c then stringRest n (c ∷ acc) cs
  else nothing
  where
  escaped : Str → Maybe (Bare × Str)
  escaped (d ∷ ds) = if is 34 d ∨ is 92 d then stringRest n (d ∷ acc) ds else nothing
  escaped []       = nothing

bare : ℕ → Parse Bare
bare n [] = nothing
bare n (c ∷ cs) =
  if is 45 c ∨ isDigit c then number (c ∷ cs)
  else if is 34 c then stringRest n [] cs
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
-- Dictionaries (§4.2.2): key [ "=" member ] (no "=": the boolean true,
-- with parameters), members as in a list. A key repeated takes the later
-- value, in the earlier place.

isKeyStart : Char → Bool
isKeyStart c = isLcalpha c ∨ is 42 c

isKeyChar : Char → Bool
isKeyChar d = isLcalpha d ∨ isDigit d ∨ is 95 d ∨ is 45 d ∨ is 46 d ∨ is 42 d

eqS : Str → Str → Bool
eqS [] [] = true
eqS (a ∷ as) (b ∷ bs) = (Data.Char.Base._≈ᵇ_ a b) ∧ eqS as bs
  where import Data.Char.Base
eqS _ _ = false

setKey : Str → Member → List (Str × Member) → List (Str × Member)
setKey k m [] = (k , m) ∷ []
setKey k m ((k′ , m′) ∷ rest) = if eqS k k′ then (k , m) ∷ rest else (k′ , m′) ∷ setKey k m rest

dictEntry : ℕ → Parse (Str × Member)
dictEntry n (c ∷ cs) with isKeyStart c
... | false = nothing
... | true with spanP isKeyChar cs
...   | (k , '=' ∷ rest) = byMember (member n rest)
  where
  byMember : Maybe (Member × Str) → Maybe ((Str × Member) × Str)
  byMember (just (m , r)) = just ((c ∷ k , m) , r)
  byMember nothing        = nothing
...   | (k , rest) = byParams (params n rest)
  where
  byParams : Maybe Str → Maybe ((Str × Member) × Str)
  byParams (just r) = just ((c ∷ k , item other) , r)
  byParams nothing  = nothing
dictEntry n [] = nothing

dictMembers : ℕ → List (Str × Member) → Str → Maybe (List (Str × Member))
dictMembers zero _ _ = nothing
dictMembers (suc n) acc s with dictEntry n s
... | nothing = nothing
... | just ((k , m) , r) with spanP ows r
...   | (_ , []) = just (setKey k m acc)
...   | (_ , c ∷ r₁) = if is 44 c then rest (spanP ows r₁) else nothing
  where
  rest : Str × Str → Maybe (List (Str × Member))
  rest (_ , []) = nothing
  rest (_ , t)  = dictMembers n (setKey k m acc) t

sfDict : Str → Maybe (List (Str × Member))
sfDict s with spanP (is 32) s
... | (_ , t) with reverse (Data.Product.Base.proj₂ (spanP (is 32) (reverse t)))
  where import Data.Product.Base
...   | [] = just []
...   | u ∷ us = dictMembers (suc (len (u ∷ us))) [] (u ∷ us)

-- Field lines are joined with ", " before parsing.
joinLines : List Str → Str
joinLines []       = []
joinLines (x ∷ []) = x
joinLines (x ∷ xs) = x ++ ',' ∷ ' ' ∷ joinLines xs
