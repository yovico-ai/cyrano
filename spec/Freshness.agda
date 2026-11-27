{-# OPTIONS --safe #-}
-- How long a response stays fresh in the browser's (private) cache —
-- RFC 9111 §4.2 as Chrome's cache applies it — and what the browser is
-- told of a body the proxy rewrote (Go: internal/rewritecache, freshness.go).
--
-- A rewritten script or stylesheet went to the browser under the origin's
-- Cache-Control (often immutable for a year): after the rewriter changed,
-- a browser ran the old rewrite against the new runtime. Now the browser
-- is told a lifetime of at most the cap, and the body's ETag names the
-- rewriter's version; when it asks again within the origin's own lifetime
-- the proxy answers 304 itself (as the browser's cache would have, asking
-- the origin nothing), and after it the origin is asked with its own
-- validators. A script reads the origin's headers (Crn-H).
--
--   * Directives: a comma list (commas inside quotes are not separators)
--     of name [= value], names case-insensitive, a value a token or a
--     quoted string. no-store: not kept at all. no-cache: kept, but every
--     use revalidated (lifetime 0). max-age=<digits>: the lifetime (the
--     first that reads; s-maxage is a shared cache's, not the browser's).
--   * Else Expires: the lifetime is Expires − Date (0 when Expires is past
--     or does not read: RFC 9111 §5.3). Else, with Last-Modified, a tenth
--     of Date − Last-Modified (the heuristic). Else 0.
--   * Fresh for the lifetime less the response's age (its Age header, or
--     how long ago its Date was, whichever is more).
--   * The browser is told max-age = min(remaining, cap), or no-cache with
--     it when the origin said no-cache; no-store is left as the origin
--     sent it (nothing is kept).
--
-- Outside the model: date parsing (IMF-fixdate, RFC 850, asctime: Go's
-- http.ParseTime gives the seconds), must-revalidate / stale-while-
-- revalidate (lifetime as above; never served stale), Vary.
module Freshness where

open import Data.Bool.Base using (Bool; true; false; if_then_else_)
open import Data.List.Base using (List; []; _∷_; _++_; map)
open import Data.Maybe.Base using (Maybe; just; nothing)
open import Data.Nat.Base using (ℕ; zero; suc; _∸_; _<ᵇ_; _/_)
open import Data.Product.Base using (_×_; _,_)
open import Data.String.Base using (toList)
open import Relation.Binary.PropositionalEquality using (_≡_; refl)

open import Url using (Str; is; eqStr; break; showN)
open import Carry using () renaming (digitsValue to digitsOf)
open import Alpn using (trim; lower; unquoted; splitList)

------------------------------------------------------------------------
-- Directives.

Dir : Set
Dir = Str × Maybe Str

directive : Str → Dir
directive d with break (is 61) (trim d)
... | (n , []) = (lower (trim n) , nothing)
... | (n , _ ∷ v) = (lower (trim n) , just (value (trim v)))
  where
  value : Str → Str
  value v with unquoted v
  ... | just u  = u
  ... | nothing = v

directives : Str → List Dir
directives cc = keep (map directive (splitList cc))
  where
  keep : List Dir → List Dir
  keep [] = []
  keep (([] , _) ∷ ds) = keep ds
  keep (d ∷ ds) = d ∷ keep ds

has : Str → List Dir → Bool
has n [] = false
has n ((m , _) ∷ ds) = if eqStr n m then true else has n ds

-- The first max-age whose value reads.
maxAge : List Dir → Maybe ℕ
maxAge [] = nothing
maxAge ((m , just v) ∷ ds) with eqStr (toList "max-age") m | digitsOf v
... | true | just n = just n
... | _    | _      = maxAge ds
maxAge ((m , nothing) ∷ ds) = maxAge ds

------------------------------------------------------------------------
-- Freshness.

data Fresh : Set where
  noStore : Fresh
  fresh   : Bool → ℕ → Fresh   -- no-cache?, seconds left

min : ℕ → ℕ → ℕ
min a b = if a <ᵇ b then a else b

max : ℕ → ℕ → ℕ
max a b = if a <ᵇ b then b else a

-- The lifetime: cc, Expires − Date (just 0 when past or unreadable;
-- nothing without Expires), Date − Last-Modified (nothing without one).
lifetime : List Dir → Maybe ℕ → Maybe ℕ → ℕ
lifetime ds e lm with maxAge ds
... | just n  = n
... | nothing with e
...   | just d  = d
...   | nothing with lm
...     | just a  = a / 10
...     | nothing = 0

-- cc, Expires − Date, Date − Last-Modified, Age header, now − Date.
freshness : Str → Maybe ℕ → Maybe ℕ → ℕ → ℕ → Fresh
freshness cc e lm ageHdr sinceDate with directives cc
... | ds = if has (toList "no-store") ds then noStore
           else if has (toList "no-cache") ds then fresh true 0
           else fresh false (lifetime ds e lm ∸ max ageHdr sinceDate)

-- The Cache-Control the browser is told (nothing: the origin's stands).
browserCC : Fresh → ℕ → Maybe Str
browserCC noStore _ = nothing
browserCC (fresh true _) _ = just (toList "no-cache, max-age=0")
browserCC (fresh false n) cap = just (toList "max-age=" ++ showN (min n cap))

------------------------------------------------------------------------
-- Examples.

private
  f1 : freshness (toList "public, max-age=31536000, immutable") nothing nothing 0 0 ≡ fresh false 31536000
  f1 = refl
  f2 : browserCC (freshness (toList "max-age=31536000, immutable") nothing nothing 0 0) 3600 ≡ just (toList "max-age=3600")
  f2 = refl
  f3 : freshness (toList "Max-Age=60, max-age=10") nothing nothing 0 0 ≡ fresh false 60
  f3 = refl
  f4 : freshness (toList "max-age=x, max-age=10") nothing nothing 0 0 ≡ fresh false 10
  f4 = refl
  f5 : freshness (toList "no-store, max-age=60") nothing nothing 0 0 ≡ noStore
  f5 = refl
  f6 : freshness (toList "") (just 300) nothing 0 0 ≡ fresh false 300
  f6 = refl
  f7 : freshness (toList "") nothing (just 1000) 0 0 ≡ fresh false 100
  f7 = refl
  f8 : freshness (toList "max-age=100") nothing nothing 30 10 ≡ fresh false 70
  f8 = refl
  f9 : freshness (toList "private=\"a, no-store\", max-age=5") nothing nothing 0 0 ≡ fresh false 5
  f9 = refl
  f10 : browserCC (freshness (toList "no-cache") nothing nothing 0 0) 3600 ≡ just (toList "no-cache, max-age=0")
  f10 = refl
