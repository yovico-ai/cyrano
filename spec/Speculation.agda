{-# OPTIONS --safe #-}
------------------------------------------------------------------------
-- The Speculation-Rules response header (owner 2026-11-22; chadscafe.com's
-- rules file was fetched from its origin): a structured-field list whose
-- string members are URLs of rule sets, resolved against the response's
-- URL; the browser fetches each (Sec-Fetch-Dest: speculationrules) and
-- ignores any other member.
--
-- Rewritten (Go: urlrewrite.RewriteSpeculationRules), when the value
-- parses as a list (Sf.sfList) holding a string: each string member
-- proxified (one that does not resolve stays as written), written as an
-- sf-string; other members, which the browser ignores, are dropped. A
-- value that does not parse, or names no URL, is left as sent (the
-- browser fetches nothing for it). The page reads the origin's value
-- (Crn-H).
--
-- Known gap: a rule set's own content (its "urls" lists, "href_matches"
-- patterns, inline <script type=speculationrules>) is not rewritten; the
-- links a document rule matches are proxified already.
------------------------------------------------------------------------

module Speculation where

open import Data.Bool.Base using (Bool; true; false; if_then_else_)
open import Data.Char.Base using (Char)
open import Data.List.Base using (List; []; _∷_; _++_)
open import Data.Maybe.Base using (Maybe; just; nothing)

open import Url using (Str; is)
open import Sf using (sfList; Member; item; inner; Bare; string; token; other)

-- An sf-string: quoted, "\" and """ escaped.
sfQuote : Str → Str
sfQuote s = '"' ∷ esc s
  where
  esc : Str → Str
  esc []       = '"' ∷ []
  esc (c ∷ cs) = if is 92 c ∨′ is 34 c then '\\' ∷ c ∷ esc cs else c ∷ esc cs
    where
    _∨′_ : Bool → Bool → Bool
    true  ∨′ _ = true
    false ∨′ b = b

-- The URLs the list names, in order.
urls : List Member → List Str
urls []                       = []
urls (item (string s) ∷ ms)   = s ∷ urls ms
urls (_ ∷ ms)                 = urls ms

joinSf : List Str → Str
joinSf []       = []
joinSf (s ∷ []) = s
joinSf (s ∷ ss) = s ++ ',' ∷ ' ' ∷ joinSf ss

rewriteSpeculationRules : (Str → Maybe Str) → Str → Str
rewriteSpeculationRules rw h = from (sfList h)
  where
  one : Str → Str
  one u with rw u
  ... | just v  = sfQuote v
  ... | nothing = sfQuote u
  each : List Str → List Str
  each []       = []
  each (u ∷ us) = one u ∷ each us
  from : Maybe (List Member) → Str
  from nothing   = h
  from (just ms) with urls ms
  ... | []      = h
  ... | u ∷ us  = joinSf (each (u ∷ us))

private
  open import Relation.Binary.PropositionalEquality using (_≡_; refl)
  open import Data.String.Base using (toList)
  up : Str → Maybe Str
  up u = just (toList "P" ++ u)
  ex1 : rewriteSpeculationRules up (toList "\"/a.json\", tok, \"b\";x=1") ≡ toList "\"P/a.json\", \"Pb\""
  ex1 = refl
  ex2 : rewriteSpeculationRules up (toList "\"unterminated") ≡ toList "\"unterminated"
  ex2 = refl
  ex3 : rewriteSpeculationRules up (toList "tok") ≡ toList "tok"
  ex3 = refl
