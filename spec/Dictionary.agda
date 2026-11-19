{-# OPTIONS --safe #-}
-- Compression dictionaries (RFC 9842) under the proxy (Go:
-- proxy/fetch_headers.go noDictionaryOffer, noDictionaryRegistration).
--
-- A site registers a dictionary with Use-As-Dictionary and the browser
-- offers it back to that origin only (Available-Dictionary, Dictionary-ID,
-- and dcb / dcz in Accept-Encoding). On the proxy origin one site's
-- dictionary would be offered to every site, so none is registered: the
-- upstream sees a browser that holds no dictionary, as on a first visit.
--
--   * The response header is changed, not removed (scripts read the
--     origin's value through Crn-H): ", type=crn" is appended. A
--     dictionary of an unknown type is not registered, and in a
--     structured-field dictionary the last member of a name wins; a value
--     that does not parse stays one that does not.
--   * A request loses Available-Dictionary and Dictionary-ID, and
--     Accept-Encoding loses its dcb / dcz members (by name, before any
--     ";", optional whitespace — SP, HTAB — around it, any case). The
--     rest are kept in order joined by ", "; a value with no such member
--     is left as it is.
--
-- Checked against Chromium (dictionary-vs-chromium): a registered
-- dictionary makes Chromium offer it, the changed header never does, and
-- the Accept-Encoding a browser holding one sends, filtered, is that of a
-- browser holding none.
module Dictionary where

open import Data.Bool.Base using (Bool; true; false; _∨_; _∧_; not; if_then_else_)
open import Data.Char.Base using (Char; toℕ)
open import Data.List.Base using (List; []; _∷_; _++_; map; reverse)
open import Data.Nat.Base using (_≡ᵇ_)
open import Data.String.Base using (toList)

open import Url using (Str; eqStr; eqLower; is)

-- The response header's value as the browser is given it.
noRegistration : Str → Str
noRegistration v = v ++ toList ", type=crn"

-- Request headers a browser holding a dictionary adds.
offerHeader : Str → Bool
offerHeader n = eqLower n (toList "available-dictionary") ∨ eqLower n (toList "dictionary-id")

ows : Char → Bool
ows c = (toℕ c ≡ᵇ 32) ∨ (toℕ c ≡ᵇ 9)

dropOws : Str → Str
dropOws [] = []
dropOws (c ∷ cs) = if ows c then dropOws cs else c ∷ cs

trimOws : Str → Str
trimOws s = reverse (dropOws (reverse (dropOws s)))

splitComma : Str → List Str
splitComma s = go s []
  where
  go : Str → Str → List Str
  go [] acc = reverse acc ∷ []
  go (c ∷ cs) acc = if is 44 c then reverse acc ∷ go cs [] else go cs (c ∷ acc)

beforeSemi : Str → Str
beforeSemi [] = []
beforeSemi (c ∷ cs) = if is 59 c then [] else c ∷ beforeSemi cs

dictionaryCoding : Str → Bool
dictionaryCoding e = eqLower n (toList "dcb") ∨ eqLower n (toList "dcz")
  where
  n : Str
  n = trimOws (beforeSemi e)

anyCoding : List Str → Bool
anyCoding [] = false
anyCoding (e ∷ es) = dictionaryCoding e ∨ anyCoding es

kept : List Str → List Str
kept [] = []
kept (e ∷ es) = if dictionaryCoding e then kept es else trimOws e ∷ kept es

joinComma : List Str → Str
joinComma [] = []
joinComma (x ∷ []) = x
joinComma (x ∷ xs) = x ++ toList ", " ++ joinComma xs

acceptEncoding : Str → Str
acceptEncoding ae = if anyCoding (splitComma ae) then joinComma (kept (splitComma ae)) else ae
