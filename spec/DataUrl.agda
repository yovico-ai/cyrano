{-# OPTIONS --safe #-}
------------------------------------------------------------------------
-- A data: URL a script is given (<script src>, owner 2026-11-22): its
-- text is JavaScript the rewriter never saw, so a runtime reads it as the
-- browser does (Fetch "data: URL processor"), rewrites it, and gives the
-- script a data: URL of the rewritten text under the same MIME type —
-- not a blob:, so a page whose CSP admits data: and not blob: runs it
-- as directly (WordPress optimisers write inline scripts so;
-- vegrecipesofindia.com's PWA module imported its origin direct).
--
-- Read (Fetch §4.2.1, over the URL's serialization, as Chromium has it):
--   leading and trailing C0 controls and spaces off (a tab or newline
--   inside: outside the model), the scheme "data:"
--   in any case, no fragment, the opaque path's C0-control
--   percent-encoding; the MIME type is what precedes the first ",",
--   ASCII whitespace stripped; ";" spaces* "base64" (any case) at its end
--   makes the body forgiving-base64; the body is percent-decoded.
-- A URL that does not read (no ",", bad base64) is given as it is: it
-- fails as directly. One whose MIME text holds a "?" (its query's
-- encoding would differ) is outside the model and also given as is.
--
-- Rewritable: bytes that are ASCII, or UTF-8 under a MIME type naming no
-- charset or charset=utf-8 (the rewritten text is written back as UTF-8;
-- another charset is left as is).
------------------------------------------------------------------------

module DataUrl where

open import Data.Bool.Base using (Bool; true; false; _∧_; _∨_; not; if_then_else_)
open import Data.Char.Base using (Char; toℕ; fromℕ)
open import Data.List.Base using (List; []; _∷_; _++_; length; reverse)
open import Data.Maybe.Base using (Maybe; just; nothing)
open import Data.Nat.Base using (ℕ; zero; suc; _+_; _*_; _∸_; _/_; _%_; _<ᵇ_; _≡ᵇ_)
open import Data.Product.Base using (_×_; _,_)
open import Data.String.Base using (toList)

open import Url using (Str; is; within; isHex; hexVal; lowerAscii; encodeWith; c0Set; eqLower; any; splitOn; dropWhile; isC0OrSpace; isTabOrNewline)

------------------------------------------------------------------------
-- Pieces

isAsciiWs : Char → Bool
isAsciiWs c = is 9 c ∨ is 10 c ∨ is 12 c ∨ is 13 c ∨ is 32 c

dropWs : Str → Str
dropWs []       = []
dropWs (c ∷ cs) = if isAsciiWs c then dropWs cs else c ∷ cs

stripWs : Str → Str
stripWs s = reverse (dropWs (reverse (dropWs s)))

-- Up to the first c, and what follows it (nothing: no c).
cut : ℕ → Str → Str × Maybe Str
cut n []       = [] , nothing
cut n (c ∷ cs) with is n c
... | true  = [] , just cs
... | false with cut n cs
...   | (a , r) = (c ∷ a) , r

-- Percent-decoded bytes of an ASCII string.
pctBytes : Str → List ℕ
pctBytes []                = []
pctBytes (c ∷ a ∷ b ∷ rest) =
  if is 37 c ∧ isHex a ∧ isHex b then (hexVal a * 16 + hexVal b) ∷ pctBytes rest
  else toℕ c ∷ pctBytes (a ∷ b ∷ rest)
pctBytes (c ∷ rest)        = toℕ c ∷ pctBytes rest

-- Bytes as code points (isomorphic decode).
chars : List ℕ → Str
chars []       = []
chars (b ∷ bs) = fromℕ b ∷ chars bs

------------------------------------------------------------------------
-- Forgiving base64 (Infra)

b64Val : Char → Maybe ℕ
b64Val c =
  if within 65 90 c then just (toℕ c ∸ 65)
  else if within 97 122 c then just (toℕ c ∸ 71)
  else if within 48 57 c then just (toℕ c + 4)
  else if is 43 c then just 62
  else if is 47 c then just 63
  else nothing

-- Six-bit values, all or nothing.
sextets : Str → Maybe (List ℕ)
sextets []       = just []
sextets (c ∷ cs) with b64Val c | sextets cs
... | just v | just vs = just (v ∷ vs)
... | _      | _       = nothing

-- Bytes from groups of four sextets; the last group of two or three gives
-- one or two bytes (its leftover bits discarded).
fromSextets : List ℕ → List ℕ
fromSextets (a ∷ b ∷ c ∷ d ∷ rest) =
  ((a * 4 + b / 16) % 256) ∷ ((b * 16 + c / 4) % 256) ∷ ((c * 64 + d) % 256) ∷ fromSextets rest
fromSextets (a ∷ b ∷ c ∷ []) = ((a * 4 + b / 16) % 256) ∷ ((b * 16 + c / 4) % 256) ∷ []
fromSextets (a ∷ b ∷ [])     = ((a * 4 + b / 16) % 256) ∷ []
fromSextets _                = []

-- One or two "=" off the front of a reversed string.
drop2 : Str → Str
drop2 (x ∷ y ∷ r) = if is 61 x ∧ is 61 y then r else if is 61 x then y ∷ r else x ∷ y ∷ r
drop2 (x ∷ [])    = if is 61 x then [] else x ∷ []
drop2 []          = []

-- Up to two "=" off the end, when the length is a multiple of four.
unpad : Str → Str
unpad s = if length s % 4 ≡ᵇ 0 then reverse (drop2 (reverse s)) else s

forgivingBase64 : Str → Maybe (List ℕ)
forgivingBase64 s = decode (unpad (noWs s))
  where
  noWs : Str → Str
  noWs []       = []
  noWs (c ∷ cs) = if isAsciiWs c then noWs cs else c ∷ noWs cs
  decode : Str → Maybe (List ℕ)
  decode t with length t % 4 ≡ᵇ 1 | sextets t
  ... | true  | _       = nothing
  ... | false | nothing = nothing
  ... | false | just vs = just (fromSextets vs)

------------------------------------------------------------------------
-- The processor

record DataUrl : Set where
  constructor dataUrl
  field
    head : Str        -- the MIME type as written, ";base64" taken off
    body : List ℕ     -- the body's bytes
open DataUrl public

-- The MIME text and whether it ends in ";" spaces* "base64".
base64Suffix : Str → Str × Bool
base64Suffix m with reverse m
... | (a ∷ b ∷ c ∷ d ∷ e ∷ f ∷ rest) =
  if eqLower (a ∷ b ∷ c ∷ d ∷ e ∷ f ∷ []) (toList "46esab") then semi (dropSp rest) else m , false
  where
  dropSp : Str → Str
  dropSp []       = []
  dropSp (x ∷ xs) = if is 32 x then dropSp xs else x ∷ xs
  semi : Str → Str × Bool
  semi (x ∷ xs) = if is 59 x then reverse xs , true else m , false
  semi []       = m , false
... | _ = m , false

-- Chromium's own check (net/base/data_url.cc, measured: data-url-vs-
-- chromium): a parameter "charset=" (any case, ASCII whitespace around the
-- ";"-separated piece trimmed) whose value is not an HTTP token makes the
-- URL fail.
isToken : Str → Bool
isToken []       = false
isToken (c ∷ cs) = tok c ∧ rest cs
  where
  tok : Char → Bool
  tok x = within 97 122 x ∨ within 65 90 x ∨ within 48 57 x ∨ is 33 x ∨ within 35 39 x ∨ is 42 x ∨ is 43 x
        ∨ is 45 x ∨ is 46 x ∨ is 94 x ∨ is 95 x ∨ is 96 x ∨ is 124 x ∨ is 126 x
  rest : Str → Bool
  rest []       = true
  rest (y ∷ ys) = tok y ∧ rest ys

charsetOk : Str → Bool
charsetOk h = all′ (splitOn (is 59) h)
  where
  piece : Str → Bool
  piece p with stripWs p
  ... | (a ∷ b ∷ c ∷ d ∷ e ∷ f ∷ g ∷ i ∷ v) =
    if eqLower (a ∷ b ∷ c ∷ d ∷ e ∷ f ∷ g ∷ i ∷ []) (toList "charset=") then isToken v else true
  ... | _ = true
  all′ : List Str → Bool
  all′ []       = true
  all′ (p ∷ ps) = piece p ∧ all′ ps

-- The URL parser's leading and trailing C0 controls and spaces off. A
-- tab or newline left inside is outside the model: Chromium keeps them in
-- some data: URLs and removes them in others (measured:
-- data-url-vs-chromium), so such a URL is given as it is.
trimC0 : Str → Str
trimC0 s = reverse (dropWhile isC0OrSpace (reverse (dropWhile isC0OrSpace s)))

read : Str → Maybe DataUrl
read s = if any isTabOrNewline (trimC0 s) then nothing else scheme (trimC0 s)
  where
  afterComma : Str → Maybe Str → Maybe DataUrl
  afterComma mime nothing = nothing
  afterComma mime (just enc) = suffix (base64Suffix (stripWs mime))
    where
    decoded : Str → Maybe (List ℕ) → Maybe DataUrl
    decoded h nothing   = nothing
    decoded h (just bs) = just (dataUrl h bs)
    suffix : Str × Bool → Maybe DataUrl
    suffix (h , false) = just (dataUrl h (pctBytes enc))
    suffix (h , true)  = decoded h (forgivingBase64 (chars (pctBytes enc)))
  serialized : Str → Maybe DataUrl
  serialized r with cut 44 r
  ... | (mime , enc) = if any (is 63) mime ∨ not (charsetOk (stripWs mime)) then nothing else afterComma mime enc
  scheme : Str → Maybe DataUrl
  scheme (a ∷ b ∷ c ∷ d ∷ e ∷ rest) =
    if eqLower (a ∷ b ∷ c ∷ d ∷ e ∷ []) (toList "data:")
    then serialized (encodeWith c0Set (noFragment rest)) else nothing
    where
    noFragment : Str → Str
    noFragment t with cut 35 t
    ... | (u , _) = u
  scheme _ = nothing

------------------------------------------------------------------------
-- Whether the text may be rewritten (and written back as UTF-8)

-- RFC 3629: well-formed UTF-8.
cont : ℕ → Bool
cont b = (127 <ᵇ b) ∧ (b <ᵇ 192)

between : ℕ → ℕ → ℕ → Bool
between lo hi b = not (b <ᵇ lo) ∧ not (hi <ᵇ b)

validUtf8 : List ℕ → Bool
validUtf8 [] = true
validUtf8 (a ∷ rest) =
  if a <ᵇ 128 then validUtf8 rest
  else if between 194 223 a then two rest
  else if is′ 224 then three 160 191 rest
  else if between 225 236 a ∨ between 238 239 a then three 128 191 rest
  else if is′ 237 then three 128 159 rest
  else if is′ 240 then four 144 191 rest
  else if between 241 243 a then four 128 191 rest
  else if is′ 244 then four 128 143 rest
  else false
  where
  is′ : ℕ → Bool
  is′ n = a ≡ᵇ n
  two : List ℕ → Bool
  two (b ∷ r) = cont b ∧ validUtf8 r
  two []      = false
  three : ℕ → ℕ → List ℕ → Bool
  three lo hi (b ∷ c ∷ r) = between lo hi b ∧ cont c ∧ validUtf8 r
  three _ _ _ = false
  four : ℕ → ℕ → List ℕ → Bool
  four lo hi (b ∷ c ∷ d ∷ r) = between lo hi b ∧ cont c ∧ cont d ∧ validUtf8 r
  four _ _ _ = false

allAscii : List ℕ → Bool
allAscii []       = true
allAscii (b ∷ bs) = (b <ᵇ 128) ∧ allAscii bs

-- s contains t (ASCII case-insensitive).
containsLower : Str → Str → Bool
containsLower t []       = eqLower t []
containsLower t (c ∷ cs) = prefix t (c ∷ cs) ∨ containsLower t cs
  where
  prefix : Str → Str → Bool
  prefix []       _        = true
  prefix (x ∷ xs) []       = false
  prefix (x ∷ xs) (y ∷ ys) = eqLower (y ∷ []) (x ∷ []) ∧ prefix xs ys   -- the literal second

utf8Charset : Str → Bool
utf8Charset h = not (containsLower (toList "charset=") h) ∨ containsLower (toList "charset=utf-8") h

rewritable : DataUrl → Bool
rewritable d = allAscii (body d) ∨ (validUtf8 (body d) ∧ utf8Charset (head d))

------------------------------------------------------------------------
-- The URL the rewritten text is given under

b64Char : ℕ → Char
b64Char n =
  if n <ᵇ 26 then fromℕ (65 + n) else if n <ᵇ 52 then fromℕ (71 + n)
  else if n <ᵇ 62 then fromℕ (n ∸ 4) else if n ≡ᵇ 62 then '+' else '/'

base64 : List ℕ → Str
base64 (a ∷ b ∷ c ∷ rest) =
  b64Char (a / 4) ∷ b64Char ((a % 4) * 16 + b / 16) ∷ b64Char ((b % 16) * 4 + c / 64) ∷ b64Char (c % 64) ∷ base64 rest
base64 (a ∷ b ∷ []) = b64Char (a / 4) ∷ b64Char ((a % 4) * 16 + b / 16) ∷ b64Char ((b % 16) * 4) ∷ '=' ∷ []
base64 (a ∷ [])     = b64Char (a / 4) ∷ b64Char ((a % 4) * 16) ∷ '=' ∷ '=' ∷ []
base64 []           = []

-- "data:" <head> ";base64," <the bytes, base64>.
wrapped : Str → List ℕ → Str
wrapped h bytes = toList "data:" ++ h ++ toList ";base64," ++ base64 bytes

------------------------------------------------------------------------
-- Worked cases (checked by the type checker)

private
  open import Relation.Binary.PropositionalEquality using (_≡_; refl)

  -- base64, any case of the marker, spaces before it
  ex1 : read (toList "data:text/javascript;base64,YWI=") ≡ just (dataUrl (toList "text/javascript") (97 ∷ 98 ∷ []))
  ex1 = refl
  -- (the space before ";" stays: Fetch strips before taking the marker off)
  ex2 : read (toList " DATA:text/javascript ; BASE64,Y W I") ≡ just (dataUrl (toList "text/javascript ") (97 ∷ 98 ∷ []))
  ex2 = refl
  -- percent-decoded, the fragment off
  ex3 : read (toList "data:,a%20b#c") ≡ just (dataUrl [] (97 ∷ 32 ∷ 98 ∷ []))
  ex3 = refl
  -- non-ASCII text is its UTF-8 bytes
  ex4 : read (toList "data:,é") ≡ just (dataUrl [] (195 ∷ 169 ∷ []))
  ex4 = refl
  -- no comma, bad base64: given as is
  ex5 : read (toList "data:text/javascript") ≡ nothing
  ex5 = refl
  ex6 : read (toList "data:;base64,Y") ≡ nothing
  ex6 = refl
  -- the URL a rewritten script is given
  ex7 : wrapped (toList "text/javascript") (97 ∷ 98 ∷ []) ≡ toList "data:text/javascript;base64,YWI="
  ex7 = refl
  ex8 : rewritable (dataUrl (toList "text/javascript;charset=latin1") (233 ∷ [])) ≡ false
  ex8 = refl
  ex9 : rewritable (dataUrl (toList "text/javascript") (195 ∷ 169 ∷ [])) ≡ true
  ex9 = refl
  ex10 : rewritable (dataUrl (toList "text/plain;Charset=UTF-8") (195 ∷ 169 ∷ [])) ≡ true
  ex10 = refl
  ex11 : read (toList "data:text/javascript;charset=latin1YWI=,AA==") ≡ nothing
  ex11 = refl
  ex12 : read (toList "data:text/javascript; Charset=utf-8 ,a") ≡ just (dataUrl (toList "text/javascript; Charset=utf-8") (97 ∷ []))
  ex12 = refl
  ex13 : read (toList "data:,a\n\tb") ≡ nothing
  ex13 = refl
