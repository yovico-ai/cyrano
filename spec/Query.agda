{-# OPTIONS --safe #-}
-- Query values unproxified on the way upstream (Go:
-- urlrewrite.UnproxyQueryValues, applied by proxy/handler.go to every
-- request's query).
--
-- The upstream must see what a direct browser would send (the upstream
-- cannot tell). A page that puts a URL it was shown into a query — a
-- return address, an embed's page — may hand over a proxified one
-- (document.URL read natively, a redirect's Location): each query value
-- that, decoded, is a proxified URL is replaced by the original it stands
-- for, form-encoded; every other byte of the query is as the page wrote
-- it.
--
-- Parameters are "&"-separated; a parameter with no "=" is left alone.
-- Decoding is form decoding ("+" a space, %XX a byte; a "%" that does not
-- start an escape: the parameter is left alone). Encoding is Go's
-- QueryEscape: A–Z a–z 0–9 - _ . ~ as they are, a space as "+", every
-- other byte %XX (uppercase).
module Query where

open import Data.Bool.Base using (Bool; true; false; _∨_; _∧_; not; if_then_else_)
open import Data.Char.Base using (Char; toℕ; fromℕ)
open import Data.List.Base using (List; []; _∷_; _++_; concatMap)
open import Data.Maybe.Base using (Maybe; just; nothing)
open import Data.Nat.Base using (ℕ; _+_; _*_)
open import Data.Product.Base using (_×_; _,_)
open import Data.String.Base using (toList)

open import Url using (Str; is; isAlpha; isDigit; isHex; hexVal; splitOn; break; utf8; pctByte)
open import Containment using (Proxy; unwrap; Answer; emit; unwrapped)

-- Form decoding, strictly: nothing when a "%" does not start an escape.
-- The bytes decoded are read back as UTF-8 by the caller's unwrap through
-- the URL parser, which takes code points: here bytes become the code
-- points of their UTF-8 decoding where valid, else the byte itself.
formDecodeBytes : Str → Maybe (List ℕ)
formDecodeBytes []                 = just []
formDecodeBytes (c ∷ cs) with is 37 c
... | true = esc cs
  where
  cons : ℕ → Maybe (List ℕ) → Maybe (List ℕ)
  cons n (just ns) = just (n ∷ ns)
  cons n nothing   = nothing
  esc : Str → Maybe (List ℕ)
  esc (a ∷ b ∷ rest) = if isHex a ∧ isHex b then cons (hexVal a * 16 + hexVal b) (formDecodeBytes rest) else nothing
  esc _              = nothing
... | false = consAll (if is 43 c then 32 ∷ [] else utf8 (toℕ c)) (formDecodeBytes cs)
  where
  consAll : List ℕ → Maybe (List ℕ) → Maybe (List ℕ)
  consAll ns (just ms) = just (ns ++ ms)
  consAll ns nothing   = nothing

-- UTF-8 bytes back to code points (as Go reads a string: a byte that does
-- not start a well-formed sequence is U+FFFD).
utf8Decode : List ℕ → Str
utf8Decode [] = []
utf8Decode (b ∷ bs) =
  if b <ᵇ 128 then fromℕ b ∷ utf8Decode bs
  else if (191 <ᵇ b) ∧ (b <ᵇ 224) then two bs
  else if (223 <ᵇ b) ∧ (b <ᵇ 240) then three bs
  else if (239 <ᵇ b) ∧ (b <ᵇ 245) then four bs
  else fromℕ 65533 ∷ utf8Decode bs
  where
  open import Data.Nat.Base using (_<ᵇ_; _∸_)
  cont : ℕ → Bool
  cont c = (127 <ᵇ c) ∧ (c <ᵇ 192)
  two : List ℕ → Str
  two (c ∷ rest) = if cont c then fromℕ ((b ∸ 192) * 64 + (c ∸ 128)) ∷ utf8Decode rest else fromℕ 65533 ∷ utf8Decode (c ∷ rest)
  two [] = fromℕ 65533 ∷ []
  three : List ℕ → Str
  three (c ∷ d ∷ rest) = if cont c ∧ cont d then fromℕ (((b ∸ 224) * 64 + (c ∸ 128)) * 64 + (d ∸ 128)) ∷ utf8Decode rest else fromℕ 65533 ∷ utf8Decode (c ∷ d ∷ rest)
  three cs = fromℕ 65533 ∷ utf8Decode cs
  four : List ℕ → Str
  four (c ∷ d ∷ e ∷ rest) = if cont c ∧ cont d ∧ cont e then fromℕ ((((b ∸ 240) * 64 + (c ∸ 128)) * 64 + (d ∸ 128)) * 64 + (e ∸ 128)) ∷ utf8Decode rest else fromℕ 65533 ∷ utf8Decode (c ∷ d ∷ e ∷ rest)
  four cs = fromℕ 65533 ∷ utf8Decode cs

-- Go's QueryEscape of a string's UTF-8 bytes.
queryEscape : Str → Str
queryEscape s = concatMap one (concatMap (λ c → utf8 (toℕ c)) s)
  where
  plain : ℕ → Bool
  plain n = isAlpha (fromℕ n) ∨ isDigit (fromℕ n) ∨ is 45 (fromℕ n) ∨ is 95 (fromℕ n) ∨ is 46 (fromℕ n) ∨ is 126 (fromℕ n)
  one : ℕ → Str
  one n = if Data.Nat.Base._<ᵇ_ n 128 ∧ plain n then fromℕ n ∷ [] else if Data.Nat.Base._≡ᵇ_ n 32 then '+' ∷ [] else pctByte n
    where import Data.Nat.Base

joinAmp : List Str → Str
joinAmp []       = []
joinAmp (x ∷ []) = x
joinAmp (x ∷ xs) = x ++ '&' ∷ joinAmp xs

-- One parameter.
unproxyParam : Proxy → Str → Str
unproxyParam p part with break (is 61) part
... | (name , _ ∷ value) = byDecoded (formDecodeBytes value)
  where
  byUnwrap : Answer → Str
  byUnwrap (emit unwrapped o) = name ++ '=' ∷ queryEscape o
  byUnwrap _                  = part
  byDecoded : Maybe (List ℕ) → Str
  byDecoded (just bs) = byUnwrap (unwrap p (utf8Decode bs))
  byDecoded nothing   = part
... | (_ , []) = part

unproxyQuery : Proxy → Str → Str
unproxyQuery p q = joinAmp (Data.List.Base.map (unproxyParam p) (splitOn (is 38) q))
  where import Data.List.Base
