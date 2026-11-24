{-# OPTIONS --safe #-}
------------------------------------------------------------------------
-- A URL's query in a document's encoding (round I: in a legacy-encoded
-- page — Shift_JIS, EUC-KR, GBK, windows-1251/1252 — the browser encodes
-- an element URL's query in the document's encoding; through the proxy
-- the rewriters gave the UTF-8 percent-encoding: the origin got other
-- bytes).
--
-- WHATWG URL, query state with an encoding: "percent-encode after
-- encoding" — each code point through the encoder; one it cannot encode
-- is "&#" decimal ";" (its HTML error mode); then each byte not in the
-- query percent-encode set as itself, the others as %XX (upper case). The
-- set: C0 controls, space, ", #, <, >, a byte ≥ 0x7F, and for a special
-- scheme also '.
--
-- Where it applies (both runtimes): a document whose encoding is declared
-- and is not UTF-8 — its element attribute URLs, navigations and XHR; not
-- CSS's url(), fetch(), WebSocket, workers (UTF-8 always). The proxified
-- URL keeps the original query, so its query is the input's own query
-- (after "?", before "#", tabs and newlines removed) encoded so; a query
-- of ASCII only is left as the UTF-8 path gives it. The encoder is a
-- parameter (latin1 below: the model the conformance tests use).
------------------------------------------------------------------------

module Encoding where

open import Data.Bool.Base using (Bool; true; false; _∨_; _∧_; not; if_then_else_)
open import Data.Char.Base using (Char; toℕ; fromℕ)
open import Data.List.Base using (List; []; _∷_; _++_; concatMap)
open import Data.Maybe.Base using (Maybe; just; nothing)
open import Data.Nat.Base using (ℕ; _+_; _<ᵇ_; _≡ᵇ_; _/_; _%_)
open import Data.Nat.Show using (show)
open import Data.String.Base using (toList)

open import Url using (Str; is)

-- An encoder: a code point's bytes, or nothing when it cannot encode it.
Encoder : Set
Encoder = Char → Maybe (List ℕ)

latin1 : Encoder
latin1 c = if toℕ c <ᵇ 256 then just (toℕ c ∷ []) else nothing

private
  hexU : ℕ → Char
  hexU k = if k <ᵇ 10 then fromℕ (48 + k) else fromℕ (55 + k)

  inSet : Bool → ℕ → Bool
  inSet special b = (b <ᵇ 33) ∨ (b ≡ᵇ 34) ∨ (b ≡ᵇ 35) ∨ (b ≡ᵇ 60) ∨ (b ≡ᵇ 62) ∨ not (b <ᵇ 127)
                    ∨ (special ∧ (b ≡ᵇ 39))

  byte : Bool → ℕ → Str
  byte special b = if inSet special b then '%' ∷ hexU (b / 16) ∷ hexU (b % 16) ∷ [] else fromℕ b ∷ []

  ascii : Str → List ℕ
  ascii [] = []
  ascii (c ∷ cs) = toℕ c ∷ ascii cs

  bytesOf : Encoder → Char → List ℕ
  bytesOf enc c with enc c
  ... | just bs = bs
  ... | nothing = ascii (toList "&#" ++ toList (show (toℕ c)) ++ toList ";")

encodeQuery : Encoder → Bool → Str → Str
encodeQuery enc special q = concatMap (byte special) (concatMap (bytesOf enc) q)

-- Whether a query needs it: it holds a code point beyond ASCII.
nonAscii : Str → Bool
nonAscii []       = false
nonAscii (c ∷ cs) = not (toℕ c <ᵇ 128) ∨ nonAscii cs
