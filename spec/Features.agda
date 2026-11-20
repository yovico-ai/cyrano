{-# OPTIONS --safe #-}
-- window.open's features string as Chromium tokenizes it (third_party/
-- blink window_features.cc; TS: patches/window-open.ts), for the
-- attributionsrc features: each names a URL (percent-encoded) the browser
-- itself requests for Attribution Reporting — outside the proxy, unless
-- the runtime proxifies it.
--
-- A separator is ASCII whitespace (SP, HTAB, LF, VT, FF, CR), "=" or ",".
-- Repeatedly: skip separators; the key runs to the next separator; then
-- separators up to an "=" are skipped, stopping at a "," or anything
-- else; only at an "=" is there a value: it and the separators after it
-- are skipped, again stopping at a ",", and the value runs to the next
-- separator ("a b=c" is a, then b=c). A key is compared ASCII
-- case-insensitively; an attributionsrc's value keeps its case, and every
-- non-empty one is requested (several may be given).
--
-- `mapSources f s` is s with each such value v replaced by f v and every
-- other character as it was: the runtime gives f = encode ∘ proxify ∘
-- decode. Checked against Chromium (features-vs-chromium): over random
-- features strings the sources Chromium requests are `sources`.
module Features where

open import Data.Bool.Base using (Bool; true; false; _∨_; _∧_; not; if_then_else_)
open import Data.Char.Base using (Char; toℕ)
open import Data.List.Base using (List; []; _∷_; _++_; length; map; null)
open import Data.Nat.Base using (ℕ; zero; suc; _≡ᵇ_)
open import Data.Product.Base using (_×_; _,_)
open import Data.String.Base using (toList)

open import Url using (Str; eqStr; is; lowerAscii)

sep : Char → Bool
sep c = is 32 c ∨ is 9 c ∨ is 10 c ∨ is 11 c ∨ is 12 c ∨ is 13 c ∨ is 61 c ∨ is 44 c

span : (Char → Bool) → Str → Str × Str
span p [] = [] , []
span p (c ∷ cs) with p c
... | false = [] , c ∷ cs
... | true with span p cs
...   | a , b = c ∷ a , b

isSource : Str → Bool
isSource k = eqStr (map lowerAscii k) (toList "attributionsrc")

-- One feature: what precedes its value, its key, its value, and the rest.
record Feature : Set where
  constructor feature
  field
    before : Str
    key    : Str
    value  : Str
    rest   : Str

next : Str → Feature
next s with span sep s
... | seps , r1 with span (λ c → not (sep c)) r1
...   | k , r2 with span (λ c → sep c ∧ not (is 61 c) ∧ not (is 44 c)) r2
...     | skipped , r3 = valueOf r3
  where
  valueOf : Str → Feature
  valueOf (c ∷ cs) with is 61 c
  ... | true with span (λ d → sep d ∧ not (is 44 d)) (c ∷ cs)
  ...   | sp , r4 with span (λ d → not (sep d)) r4
  ...     | v , r5 = feature (seps ++ k ++ skipped ++ sp) k v r5
  valueOf (c ∷ cs) | false = feature (seps ++ k ++ skipped) k [] (c ∷ cs)
  valueOf [] = feature (seps ++ k ++ skipped) k [] []

mapSourcesN : ℕ → (Str → Str) → Str → Str
mapSourcesN zero    f s = s
mapSourcesN (suc n) f [] = []
mapSourcesN (suc n) f s@(_ ∷ _) with next s
... | feature b k v r = b ++ (if isSource k ∧ not (null v) then f v else v) ++ mapSourcesN n f r

mapSources : (Str → Str) → Str → Str
mapSources f s = mapSourcesN (suc (length s)) f s

sourcesN : ℕ → Str → List Str
sourcesN zero _ = []
sourcesN (suc n) [] = []
sourcesN (suc n) s@(_ ∷ _) with next s
... | feature _ k v r = (if isSource k ∧ not (null v) then v ∷ [] else []) ++ sourcesN n r

sources : Str → List Str
sources s = sourcesN (suc (length s)) s
