{-# OPTIONS --safe #-}
------------------------------------------------------------------------
-- Subresource Integrity (W3C SRI §3.3; Chromium, measured: sri-vs-
-- chromium). Through the proxy a script or stylesheet is rewritten, so
-- its bytes can never match the page's `integrity`: both rewriters drop
-- the attribute, and nothing was checked — a tampered file ran (round K).
-- The check is the proxy's, on the origin's bytes: the element's URL
-- carries the metadata as a mark (Containment: integrityMark), the
-- proxy hashes the origin's body and fails the response — a network
-- error, nothing given to the browser — when it does not match.
--
--   * The metadata is split on ASCII whitespace; a token is
--     alg "-" value ["?" options], alg sha256, sha384 or sha512 (ASCII
--     case aside), value base64 or base64url (padding optional); every
--     other token is ignored. No valid token: nothing to check.
--   * Only the strongest algorithm's tokens count; the response passes
--     when its digest by that algorithm equals one of their values.
--   * The mark keeps those tokens canonical — alg lowercased, the value
--     base64url without padding — joined by "." (no "!" or "/": a mark's
--     alphabet), so it reads back as written.
------------------------------------------------------------------------

module Sri where

open import Data.Bool.Base using (Bool; true; false; _∧_; _∨_; not; if_then_else_)
open import Data.Char.Base using (Char)
open import Data.List.Base using (List; []; _∷_; _++_; map; reverse)
open import Data.Maybe.Base using (Maybe; just; nothing)
open import Data.Nat.Base using (ℕ; _<ᵇ_; _≡ᵇ_)
open import Data.Product.Base using (_×_; _,_)
open import Data.String.Base using (toList)

open import Url using (Str; is; isAlpha; isDigit; eqStr; lowerAscii; break; all; splitOn)

data Alg : Set where
  sha256 sha384 sha512 : Alg

algName : Alg → Str
algName sha256 = toList "sha256"
algName sha384 = toList "sha384"
algName sha512 = toList "sha512"

algOf : Str → Maybe Alg
algOf s = byName (map lowerAscii s)
  where
  byName : Str → Maybe Alg
  byName n = if eqStr n (toList "sha256") then just sha256
             else if eqStr n (toList "sha384") then just sha384
             else if eqStr n (toList "sha512") then just sha512 else nothing

rank : Alg → ℕ
rank sha256 = 1
rank sha384 = 2
rank sha512 = 3

isWS : Char → Bool
isWS c = is 32 c ∨ is 9 c ∨ is 10 c ∨ is 12 c ∨ is 13 c

-- A base64 / base64url value, made canonical: "+" "-", "/" "_", no "=".
canon : Str → Maybe Str
canon v = check (strip (reverse v))
  where
  strip : Str → Str
  strip ('=' ∷ r) = strip r
  strip r = reverse r
  ok : Char → Bool
  ok c = isAlpha c ∨ isDigit c ∨ is 43 c ∨ is 47 c ∨ is 45 c ∨ is 95 c
  one : Char → Char
  one '+' = '-'
  one '/' = '_'
  one c = c
  check : Str → Maybe Str
  check [] = nothing
  check s = if all ok s then just (map one s) else nothing

record Item : Set where
  constructor item
  field
    iAlg   : Alg
    iValue : Str      -- canonical
open Item public

-- One token: alg "-" value ["?" options].
itemOf : Str → Maybe Item
itemOf t with break (is 45) t
... | (a , []) = nothing
... | (a , (_ ∷ rest)) = both (algOf a) (canon (valuePart rest))
  where
  valuePart : Str → Str
  valuePart [] = []
  valuePart ('?' ∷ _) = []
  valuePart (c ∷ cs) = c ∷ valuePart cs
  both : Maybe Alg → Maybe Str → Maybe Item
  both (just x) (just v) = just (item x v)
  both _ _ = nothing

-- The valid items, in order.
items : Str → List Item
items s = go (splitOn isWS s)
  where
  go : List Str → List Item
  go [] = []
  go (t ∷ ts) with itemOf t
  ... | just i  = i ∷ go ts
  ... | nothing = go ts

-- The strongest algorithm's items.
strongest : List Item → List Item
strongest is′ = keep (top is′ 0)
  where
  top : List Item → ℕ → ℕ
  top [] n = n
  top (i ∷ r) n = top r (if n <ᵇ rank (iAlg i) then rank (iAlg i) else n)
  keep : ℕ → List Item
  keep n = go is′
    where
    go : List Item → List Item
    go [] = []
    go (i ∷ r) = if rank (iAlg i) ≡ᵇ n then i ∷ go r else go r

-- The mark's text: the strongest items, canonical, joined by ".";
-- nothing when there is nothing to check.
markOf : Str → Maybe Str
markOf s with strongest (items s)
... | [] = nothing
... | i ∷ is′ = just (join (i ∷ is′))
  where
  one : Item → Str
  one x = algName (iAlg x) ++ '-' ∷ iValue x
  join : List Item → Str
  join [] = []
  join (x ∷ []) = one x
  join (x ∷ xs) = one x ++ '.' ∷ join xs

-- The mark read back: its items (each token as `items` reads one).
markItems : Str → List Item
markItems m = go (splitOn (is 46) m)
  where
  go : List Str → List Item
  go [] = []
  go (t ∷ ts) with itemOf t
  ... | just i  = i ∷ go ts
  ... | nothing = go ts

-- Does a response pass: `digest a` is the canonical base64url digest of
-- its body by algorithm a.
passes : Str → (Alg → Str) → Bool
passes m digest = anyI (markItems m)
  where
  anyI : List Item → Bool
  anyI [] = false
  anyI (i ∷ r) = eqStr (digest (iAlg i)) (iValue i) ∨ anyI r

-- The proxy fails a response (W3C SRI §3.3.5; Fetch "main fetch": a
-- response that is not CORS-same-origin is not eligible) when the URL
-- carries a mark and the response is opaque — a cross-origin request in
-- no-cors mode (a script without crossorigin: measured, blocked though
-- its hash matches) — or its digest matches none of the mark's items.
fails : Maybe Str → Bool → (Alg → Str) → Bool
fails nothing  _        _      = false
fails (just m) eligible digest = not eligible ∨ not (passes m digest)

-- Where the browser checks an element's integrity: a script's src, a
-- link's href for a stylesheet, a preload or a modulepreload (HTML); an
-- SVG script has no integrity.
honored : Bool → Str → Str → List Str → Bool
honored svg tag attr rels =
  not svg ∧ ((eqStr tag (toList "script") ∧ eqStr attr (toList "src"))
            ∨ (eqStr tag (toList "link") ∧ eqStr attr (toList "href") ∧ anyRel rels))
  where
  anyRel : List Str → Bool
  anyRel [] = false
  anyRel (r ∷ rs) = eqStr r (toList "stylesheet") ∨ eqStr r (toList "preload") ∨ eqStr r (toList "modulepreload") ∨ anyRel rs
