{-# OPTIONS --safe #-}
-- localStorage per original origin, with each origin's own quota (owner,
-- 2026-11-21: "if we do it smart we can wrap and map into indexdb").
--
-- Every proxied site shares the proxy origin's one localStorage, so all of
-- them shared one quota: sports-reference.com's 2 MB caches threw
-- QuotaExceededError through the proxy and not directly. Chromium gives
-- each storage key (spec/Storage.agda partitionKey) its own: keys plus
-- values, counted in UTF-16 code units, at most 5 242 880 (measured).
--
-- The store, per partition p:
--   * `all` — every entry of every partition, kept in IndexedDB (whose
--     quota is the disk's): what a partition holds;
--   * `hot` — the entries also kept in the native localStorage, which is
--     read synchronously: what a page sees before IndexedDB answers.
-- A page reads its partition from `all` once IndexedDB has answered, from
-- `hot` before (the first moments of a page load). Writes go to both.
-- When the native store is full, entries of *other* partitions leave `hot`
-- (least recently used first) — they stay in `all`; the current
-- partition's leave only when no other partition's remain.
--
-- So (proved below): what a partition holds does not depend on `hot` —
-- eviction changes no partition's contents; a write's QuotaExceededError
-- depends only on the writer's own partition, as natively; and the only
-- difference left is the first moments of a load after eviction, when an
-- evicted entry reads as missing (a cache miss, never data lost).
--
-- TS: ts/client/src/patches/storage.ts (localStorage); checked in Chromium
-- (local-store-vs-chromium).
module LocalStore where

open import Data.Bool.Base using (Bool; true; false; _∧_; _∨_; not; if_then_else_)
open import Data.List.Base using (List; []; _∷_; filterᵇ; map; length; foldr; _++_)
open import Data.Maybe.Base using (Maybe; just; nothing)
open import Data.Nat.Base using (ℕ; _+_; _≤ᵇ_)
open import Data.Product.Base using (_×_; _,_; proj₁; proj₂)
open import Relation.Binary.PropositionalEquality using (_≡_; refl)

open import Url using (Str; eqStr)

-- Chromium's per-storage-key quota, in UTF-16 code units (keys + values).
quota : ℕ
quota = 5242880

record Entry : Set where
  constructor entry
  field
    part : Str
    key  : Str
    val  : Str

open Entry

record Store : Set where
  constructor store
  field
    all : List Entry          -- IndexedDB: every entry (one per part and key)
    hot : List (Str × Str)    -- which (part, key) the native store also holds

open Store

ofPart : Str → List Entry → List Entry
ofPart p = filterᵇ (λ e → eqStr (part e) p)

-- What a partition holds (once IndexedDB has answered).
contents : Str → Store → List Entry
contents p s = ofPart p (all s)

isHot : Store → Entry → Bool
isHot s e = foldr (λ pk acc → (eqStr (proj₁ pk) (part e) ∧ eqStr (proj₂ pk) (key e)) ∨ acc) false (hot s)

-- What it reads before IndexedDB answers: its entries the native store holds.
early : Str → Store → List Entry
early p s = filterᵇ (isHot s) (contents p s)

-- A partition's size as Chromium counts it.
size : Str → Store → ℕ
size p s = foldr (λ e n → length (key e) + length (val e) + n) 0 (contents p s)

-- Its size with k set to v.
without : Str → Str → List Entry → List Entry
without p k = filterᵇ (λ e → not (eqStr (part e) p ∧ eqStr (key e) k))

sizeAfter : Str → Str → Str → Store → ℕ
sizeAfter p k v s = length k + length v + foldr (λ e n → length (key e) + length (val e) + n) 0 (ofPart p (without p k (all s)))

-- setItem succeeds exactly when the partition stays within its own quota
-- (fitsWithin: under any quota q — the logic, checked by conformance with
-- small ones; the quota itself is Chromium's, checked in Chromium).
fitsWithin : ℕ → Str → Str → Str → Store → Bool
fitsWithin q p k v s = sizeAfter p k v s ≤ᵇ q

fits : Str → Str → Str → Store → Bool
fits = fitsWithin quota

-- Eviction: some (part, key) leave the native store. `all` is untouched.
evict : List (Str × Str) → Store → Store
evict hot' s = store (all s) hot'

-- Eviction changes no partition's contents.
evict-keeps : ∀ p h s → contents p (evict h s) ≡ contents p s
evict-keeps p h s = refl

-- Nor any partition's size, so no write's QuotaExceededError.
evict-keeps-quota : ∀ p k v h s → fits p k v (evict h s) ≡ fits p k v s
evict-keeps-quota p k v h s = refl

-- Whether a write fits depends only on the writer's own entries: two stores
-- whose `all` agree on p agree on it, whatever other partitions hold.
fits-own : ∀ p k v s t → ofPart p (without p k (all s)) ≡ ofPart p (without p k (all t)) →
           fits p k v s ≡ fits p k v t
fits-own p k v s t eq rewrite eq = refl
