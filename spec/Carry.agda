{-# OPTIONS --safe #-}
-- What the proxy carries to the runtime in response headers (Go:
-- proxy/original_headers.go, server/bodyrewriter.go; TS:
-- patches/response-headers.ts, patches/install.ts).
--
--   * Crn-H: the origin's value of every header the proxy changed, as a
--     JSON object from lowercase name to the values as sent ([…]), or null
--     (the origin sent none; the proxy added it). A script reads a header
--     natively as a ByteString — one character per byte — so each value is
--     written byte for byte: every byte outside printable ASCII, and " and
--     \, escaped (\u00XX); JSON.parse then gives exactly the native string,
--     whatever the bytes (Go's json.Marshal turned invalid UTF-8 into
--     U+FFFD: a Latin-1 byte read differently). Names in ascending order.
--   * Server-Timing "crnb": where the proxy changed a body, the origin's
--     sizes, encoded and decoded: crnb;desc="<encoded>-<decoded>". The
--     runtime answers encodedBodySize / decodedBodySize from it and hides
--     the metric. A metric of that name the origin sent itself is left as
--     it is (the proxy does not add its own then).
--
-- Checked against Chromium (carry-vs-chromium): JSON.parse of a value
-- written so equals the header as fetch shows it; the description of a
-- crnb metric is the text written.
module Carry where

open import Data.Bool.Base using (Bool; true; false; _∨_; _∧_; not; if_then_else_)
open import Data.Char.Base using (Char; toℕ; fromℕ)
open import Data.List.Base using (List; []; _∷_; _++_; concatMap)
open import Data.Maybe.Base using (Maybe; just; nothing)
open import Data.Nat.Base using (ℕ; _<ᵇ_; _/_; _%_; _+_)
open import Data.Product.Base using (_×_; _,_)
open import Data.String.Base using (toList)

open import Url using (Str; is; isDigit; showN; break)

hex : ℕ → Char
hex n = if n <ᵇ 10 then fromℕ (48 + n) else fromℕ (87 + n)

-- One byte of a header value (a character 0–255), as a JSON string writes it.
escByte : Char → Str
escByte c =
  if is 34 c then '\\' ∷ '"' ∷ []
  else if is 92 c then '\\' ∷ '\\' ∷ []
  else if (toℕ c <ᵇ 32) ∨ (126 <ᵇ toℕ c) then '\\' ∷ 'u' ∷ '0' ∷ '0' ∷ hex (toℕ c / 16 % 16) ∷ hex (toℕ c % 16) ∷ []
  else c ∷ []

-- A header value (its bytes, as characters 0–255) as a JSON string.
jsonBytes : Str → Str
jsonBytes v = '"' ∷ concatMap escByte v ++ '"' ∷ []

joinC : Str → List Str → Str
joinC sep []       = []
joinC sep (x ∷ []) = x
joinC sep (x ∷ xs) = x ++ sep ++ joinC sep xs

-- The Crn-H object, its names given in ascending order.
crnH : List (Str × Maybe (List Str)) → Str
crnH hs = '{' ∷ joinC (',' ∷ []) (entry hs) ++ '}' ∷ []
  where
  entry : List (Str × Maybe (List Str)) → List Str
  entry [] = []
  entry ((n , nothing) ∷ rest) = (jsonBytes n ++ toList ":null") ∷ entry rest
  entry ((n , just vs) ∷ rest) = (jsonBytes n ++ ':' ∷ '[' ∷ joinC (',' ∷ []) (mapJ vs) ++ ']' ∷ []) ∷ entry rest
    where
    mapJ : List Str → List Str
    mapJ []       = []
    mapJ (x ∷ xs) = jsonBytes x ∷ mapJ xs

-- The crnb metric, and its reading.
crnb : ℕ → ℕ → Str
crnb e d = toList "crnb;desc=\"" ++ showN e ++ '-' ∷ showN d ++ '"' ∷ []

digitsValue : Str → Maybe ℕ
digitsValue [] = nothing
digitsValue s = go s 0
  where
  go : Str → ℕ → Maybe ℕ
  go []       acc = just acc
  go (c ∷ cs) acc = if isDigit c then go cs (acc Data.Nat.Base.* 10 + (toℕ c Data.Nat.Base.∸ 48)) else nothing
    where import Data.Nat.Base

-- A crnb description: "<encoded>-<decoded>", both decimal.
crnbRead : Str → Maybe (ℕ × ℕ)
crnbRead s with break (is 45) s
... | (a , _ ∷ b) = both (digitsValue a) (digitsValue b)
  where
  both : Maybe ℕ → Maybe ℕ → Maybe (ℕ × ℕ)
  both (just x) (just y) = just (x , y)
  both _        _        = nothing
... | (a , []) = nothing
