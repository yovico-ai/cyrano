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
-- A rule set's content (rewriteRuleSet): every string of an array that is
-- the value of a "urls" member — a list rule's URLs, for prefetch and
-- prerender alike — is proxified, resolved against the rule set's base
-- (an inline set's document base; a fetched set's own URL); the rest is
-- left byte for byte. A script that read a link's href (the page's URL)
-- and wrote it into a list rule had the browser prefetch it from the
-- origin (immi-usa.com's "easyopt-speculation-live"). Both runtimes: the
-- server for an inline set in markup and a fetched one, the runtime for
-- text a script gives an inline set; read back as written.
-- Gap: an absolute "href_matches" pattern (the links a document rule
-- matches are proxified, so a relative pattern matches them as directly;
-- an absolute one naming the origin matches nothing). Text that is not
-- JSON at the token level is left as written (the browser ignores it).
------------------------------------------------------------------------

module Speculation where

open import Data.Bool.Base using (Bool; true; false; if_then_else_)
open import Data.Char.Base using (Char)
open import Data.List.Base using (List; []; _∷_; _++_)
open import Data.Maybe.Base using (Maybe; just; nothing)

open import Url using (Str; is; eqStr)
open import ImportMap using (tokenize; Tok; tok; TK; tString; tPunct; tWS; tLit; tBad; stringify)
open import Data.String.Base using (toList)
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

------------------------------------------------------------------------
-- A rule set's content.

data Frame : Set where
  urlsArray otherArray object : Frame

rewriteRuleSet : (Str → Maybe Str) → Str → Str
rewriteRuleSet rw s with tokenize s
... | nothing = s
... | just ts = go ts [] nothing nothing
  where
  inUrls : List Frame → Bool
  inUrls (urlsArray ∷ _) = true
  inUrls _ = false

  isUrlsKey : Maybe Str → Bool
  isUrlsKey (just k) = eqStr k (toList "urls")
  isUrlsKey nothing  = false

  pop : List Frame → List Frame
  pop (_ ∷ fs) = fs
  pop []       = []

  rewritten : Tok → Str
  rewritten t with rw (Tok.value t)
  ... | just u  = stringify u
  ... | nothing = Tok.text t

  -- frames open, the key of the value to come, the last string (a key
  -- when a ':' follows).
  go : List Tok → List Frame → Maybe Str → Maybe Str → Str
  go [] _ _ _ = []
  go (t ∷ rest) fs key prev with Tok.kind t
  ... | tWS     = Tok.text t ++ go rest fs key prev
  ... | tLit    = Tok.text t ++ go rest fs nothing nothing
  ... | tBad    = Tok.text t ++ go rest fs nothing nothing
  ... | tString = (if inUrls fs then rewritten t else Tok.text t) ++ go rest fs key (just (Tok.value t))
  ... | tPunct  = Tok.text t ++ punct (Tok.text t)
    where
    punct : Str → Str
    punct (':' ∷ []) = go rest fs prev nothing
    punct ('[' ∷ []) = go rest ((if isUrlsKey key then urlsArray else otherArray) ∷ fs) nothing nothing
    punct ('{' ∷ []) = go rest (object ∷ fs) nothing nothing
    punct (']' ∷ []) = go rest (pop fs) nothing nothing
    punct ('}' ∷ []) = go rest (pop fs) nothing nothing
    punct _          = go rest fs nothing nothing

private
  open import Relation.Binary.PropositionalEquality using (_≡_; refl)
  s′ = toList
  up2 : Str → Maybe Str
  up2 u = just (toList "P:" ++ u)

  rs1 : rewriteRuleSet up2 (s′ "{\"prefetch\":[{\"source\":\"list\",\"urls\":[\"https://a.example/b/\", \"/c\"],\"eagerness\":\"immediate\"}]}")
      ≡ s′ "{\"prefetch\":[{\"source\":\"list\",\"urls\":[\"P:https://a.example/b/\", \"P:/c\"],\"eagerness\":\"immediate\"}]}"
  rs1 = refl

  -- A document rule is left as it is; a "urls" key's string elsewhere too.
  rs2 : rewriteRuleSet up2 (s′ "{\"prefetch\":[{\"source\":\"document\",\"where\":{\"href_matches\":\"/*\"}}],\"tag\":\"urls\"}")
      ≡ s′ "{\"prefetch\":[{\"source\":\"document\",\"where\":{\"href_matches\":\"/*\"}}],\"tag\":\"urls\"}"
  rs2 = refl

  -- Not JSON: as written.
  rs3 : rewriteRuleSet up2 (s′ "{urls: ['x']}") ≡ s′ "{urls: ['x']}"
  rs3 = refl
