{-# OPTIONS --safe #-}
-- Rewriting a srcset attribute: every candidate URL is rewritten and its
-- descriptor kept as written.
--
-- Implemented by go/src/internal/htmlrewrite/srcset.go (rewriteSrcset)
-- and ts/client/src/patches/srcset.ts (rewriteSrcsetAttribute). Both say
-- they follow the HTML Standard's "parse a srcset attribute"; this module
-- is that algorithm, as far as it decides where each URL starts and ends:
--
--   * A URL ends at ASCII whitespace (tab, LF, FF, CR, space); commas
--     inside it are part of it (Cloudflare /cdn-cgi/image/w=640,q=75/…).
--   * A URL that ends in commas ends its candidate: the commas are
--     separators, and what follows is the next candidate's URL.
--   * Otherwise the descriptor runs to the next comma that is not inside
--     parentheses.
--
-- Ours, to confirm: the descriptor is kept as written (inner whitespace
-- untouched, outer whitespace trimmed) rather than re-tokenized; the
-- candidates are written back joined by ", "; the browser's validation
-- of descriptors (dropping invalid candidates) is not applied — a
-- candidate the browser would ignore is rewritten all the same.
module Srcset where

open import Data.Bool.Base using (Bool; true; false; _∨_; if_then_else_)
open import Data.Char.Base using (Char; fromℕ)
open import Data.List.Base using (List; []; _∷_; _++_; reverse)
open import Data.Product.Base using (_×_; _,_)

open import Url using (Str; is; dropWhile)

isWS : Char → Bool
isWS c = is 9 c ∨ is 10 c ∨ is 12 c ∨ is 13 c ∨ is 32 c

isComma : Char → Bool
isComma = is 44

record Candidate : Set where
  constructor candidate
  field
    cUrl  : Str
    cDesc : Str
open Candidate public

-- Where the tokenizer is.
data State : Set where
  between    : State                        -- before a URL: whitespace and commas
  inUrl      : Str → State                  -- reading a URL (reversed)
  inDesc     : Str → Bool → Str → State     -- URL, inside "(", descriptor so far (reversed)

trimEnd : Str → Str                          -- on a reversed string: trim its end
trimEnd = dropWhile isWS

-- A URL token (reversed) ends: if it ends in commas, they end the
-- candidate too.
endUrl : Str → (Candidate → List Candidate → List Candidate) → List Candidate → State × List Candidate
endUrl (c ∷ cs) push acc =
  if isComma c then (between , push (candidate (reverse (dropWhile isComma (c ∷ cs))) []) acc)
  else (inDesc (reverse (c ∷ cs)) false [] , acc)
endUrl [] push acc = between , acc

push : Candidate → List Candidate → List Candidate
push = _∷_

endDesc : Str → Str → List Candidate → List Candidate
endDesc u d acc = candidate u (reverse (trimEnd d)) ∷ acc

-- One character at a time; `acc` is the candidates so far, reversed.
scan : State → Str → List Candidate → List Candidate
scan between [] acc = reverse acc
scan between (c ∷ cs) acc =
  if isWS c ∨ isComma c then scan between cs acc else scan (inUrl (c ∷ [])) cs acc
scan (inUrl u) [] acc with endUrl u push acc
... | inDesc url _ _ , acc′ = reverse (candidate url [] ∷ acc′)
... | _              , acc′ = reverse acc′
scan (inUrl u) (c ∷ cs) acc =
  if isWS c then next (endUrl u push acc) else scan (inUrl (c ∷ u)) cs acc
  where
  next : State × List Candidate → List Candidate
  next (st , acc′) = scan st cs acc′
scan (inDesc u paren d) [] acc = reverse (endDesc u d acc)
scan (inDesc u true d) (c ∷ cs) acc =
  if is 41 c then scan (inDesc u false (c ∷ d)) cs acc
  else scan (inDesc u true (c ∷ d)) cs acc
scan (inDesc u false d) (c ∷ cs) acc =
  if isComma c then scan between cs (endDesc u d acc)
  else if is 40 c then scan (inDesc u true (c ∷ d)) cs acc
  else if isWS c then (descWS d)
  else scan (inDesc u false (c ∷ d)) cs acc
  where
  -- whitespace before the descriptor starts is skipped
  descWS : Str → List Candidate
  descWS []      = scan (inDesc u false []) cs acc
  descWS (x ∷ xs) = scan (inDesc u false (c ∷ x ∷ xs)) cs acc

candidates : Str → List Candidate
candidates s = scan between s []

joinWith : Str → List Str → Str
joinWith sep []           = []
joinWith sep (x ∷ [])     = x
joinWith sep (x ∷ y ∷ ys) = x ++ sep ++ joinWith sep (y ∷ ys)

render : (Str → Str) → Candidate → Str
render f (candidate u [])       = f u
render f (candidate u (d ∷ ds)) = f u ++ fromℕ 32 ∷ d ∷ ds

mapS : (Candidate → Str) → List Candidate → List Str
mapS f []       = []
mapS f (c ∷ cs) = f c ∷ mapS f cs

rewriteSrcset : (Str → Str) → Str → Str
rewriteSrcset f s = joinWith (fromℕ 44 ∷ fromℕ 32 ∷ []) (mapS (render f) (candidates s))
