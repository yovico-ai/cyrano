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
open import Data.List.Base using (List; []; _∷_; _++_; concatMap; map; reverse)
open import Data.Maybe.Base using (Maybe; just; nothing)
open import Data.Nat.Base using (ℕ; _<ᵇ_; _/_; _%_; _+_)
open import Data.Product.Base using (_×_; _,_)
open import Data.String.Base using (toList)

open import Url using (Str; is; isDigit; showN; break; splitOn; eqStr; lowerAscii)

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

------------------------------------------------------------------------
-- The length the browser is told. An HTTP/2 stream that ends with fewer
-- body bytes than its Content-Length declared (Akamai's 403s on
-- api.nike.com: "2", and no DATA) is taken by Chrome as the response it
-- is, the bytes that came; over the proxy's HTTP/1.1 the browser would
-- fail it (ERR_CONTENT_LENGTH_MISMATCH). So for such a response the
-- browser is told the length that came — scripts still read the origin's
-- Content-Length (Crn-H). Over HTTP/1.1 a short body is a cut connection,
-- which the browser fails natively too: left as it is. (Go reads the
-- whole of such a body before answering only up to 64 KiB.)

framedLength : Bool → ℕ → ℕ → ℕ
framedLength http2 declared came = if http2 ∧ (came <ᵇ declared) then came else declared

------------------------------------------------------------------------
-- Vary, as the browser is told it. Natively a response that varies on
-- Origin is cached once per requesting origin; through the proxy every
-- request is the proxy's own, sends no Origin, and one cached copy went to
-- every page (bbc.com was handed bbc.co.uk's, failed CORS and sent the
-- reader back). Where Vary lists Origin (ASCII case-insensitively, as one
-- of its comma-separated tokens, OWS around), the browser is told
-- Crn-I besides — the runtime's header naming the requesting page, which
-- differs where Origin would (Crn-H keeps the origin's Vary for scripts).
-- "*" already keeps nothing: left as written.

varyLists : Str → Str → Bool
varyLists tok v = anyTok (splitOn (is 44) v)
  where
  trimO : Str → Str
  trimO s = rev (dropW (rev (dropW s)))
    where
    dropW : Str → Str
    dropW [] = []
    dropW (c ∷ cs) = if is 32 c ∨ is 9 c then dropW cs else c ∷ cs
    rev : Str → Str
    rev = reverse
  anyTok : List Str → Bool
  anyTok [] = false
  anyTok (t ∷ ts) = eqStr (map lowerAscii (trimO t)) (map lowerAscii tok) ∨ anyTok ts

varyForBrowser : Str → Str
varyForBrowser v = if varyLists (toList "origin") v ∧ not (varyLists (toList "crn-i") v) then v ++ toList ", Crn-I" else v

-- The origin's reason phrase, for statusText (TS: response-headers.ts;
-- Go: proxy.carryOriginalHeaders): the browser talks HTTP/2 to the proxy,
-- which has none, where an HTTP/1.x origin's response directly has its
-- status line's phrase (round I: fetch / XHR statusText read "" for
-- neverssl.com's "Not Found"). Carried in crnH under the name ":status-text",
-- which no header can have (":" is no token character); an HTTP/2 or /3
-- origin has none directly either. http1: the origin spoke HTTP/1.x.
statusText : Data.Bool.Base.Bool → Str → Maybe Str
statusText Data.Bool.Base.false _  = nothing
statusText Data.Bool.Base.true  [] = nothing
statusText Data.Bool.Base.true  p  = just p
