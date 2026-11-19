{-# OPTIONS --safe #-}
-- fetchLater's deferred-fetch quota, as Chromium keeps it (TS:
-- patches/fetch-later.ts deferredSize and the wrapper's check).
--
-- A deferred request counts against its destination origin's quota of
-- 64 KiB: the length of its URL without the fragment, of every entry of
-- its header list (name and value, the value trimmed; a name given twice
-- counts twice — not the combined value Headers iterates), of the body,
-- and 12 bytes more. A string body counts its UTF-16 code units (not its
-- UTF-8 bytes), URLSearchParams its serialization, a Blob or buffer its
-- bytes. A body the request is built from adds
-- the Content-Type it implies, when the headers have none: a string
-- "text/plain;charset=UTF-8", URLSearchParams
-- "application/x-www-form-urlencoded;charset=UTF-8", a Blob its type if it
-- has one, a buffer none. A request is refused (QuotaExceededError) when
-- what is already deferred to that origin and its own size exceed the
-- quota; the message names its size and what was left. A body given but
-- empty (a "" string, an empty Blob, buffer or URLSearchParams) is refused
-- before that, with a TypeError (Chromium: "body with unknown length").
--
-- Under the proxy every destination is the proxy's origin, so the runtime
-- keeps this count per original origin and refuses exactly where a direct
-- browser would. Checked against Chromium (fetch-later-vs-chromium).
module FetchLater where

open import Data.Bool.Base using (Bool; true; false; _∨_; _∧_; not; if_then_else_)
open import Data.List.Base using (List; []; _∷_; _++_; length; foldr)
open import Data.Maybe.Base using (Maybe; just; nothing)
open import Data.Nat.Base using (ℕ; _+_; _∸_; _≤ᵇ_)
open import Data.Product.Base using (_×_; _,_)
open import Data.String.Base using (toList)

open import Url using (Str; eqStr; eqLower; showN)

quota overhead : ℕ
quota = 65536
overhead = 12

data Body : Set where
  noBody text params buffer : Body
  blob : Str → Body          -- its type ("" for none)

impliedType : Body → Maybe Str
impliedType noBody   = nothing
impliedType text     = just (toList "text/plain;charset=UTF-8")
impliedType params   = just (toList "application/x-www-form-urlencoded;charset=UTF-8")
impliedType buffer   = nothing
impliedType (blob []) = nothing
impliedType (blob t)  = just t

hasType : List (Str × Str) → Bool
hasType [] = false
hasType ((k , _) ∷ hs) = eqLower k (toList "content-type") ∨ hasType hs

headerBytes : List (Str × Str) → ℕ
headerBytes = foldr (λ { (k , v) n → length k + length v + n }) 0

-- href: the URL without its fragment; hs: the header list; bodyLen: the
-- body's length as counted above.
deferredSize : Str → List (Str × Str) → Body → ℕ → ℕ
deferredSize href hs b bodyLen = length href + headerBytes hs + implied (impliedType b) + bodyLen + overhead
  where
  implied : Maybe Str → ℕ
  implied (just t) = if hasType hs then 0 else length (toList "content-type") + length t
  implied nothing  = 0

-- nothing: refused, a TypeError (an empty body); else the size.
requestSize : Str → List (Str × Str) → Body → ℕ → Maybe ℕ
requestSize href hs noBody n = just (deferredSize href hs noBody n)
requestSize href hs b 0 = nothing
requestSize href hs b n = just (deferredSize href hs b n)

-- used: what is deferred to the origin already. nothing: admitted;
-- just m: refused with message m.
admit : ℕ → ℕ → Maybe Str
admit used size =
  if used + size ≤ᵇ quota then nothing
  else just (toList "Failed to execute 'fetchLater' on 'Window': fetchLater exceeds its quota for the origin: got "
             ++ showN size ++ toList " bytes, expected less than " ++ showN (quota ∸ used) ++ toList " bytes.")
