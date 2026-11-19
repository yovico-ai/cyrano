{-# OPTIONS --safe #-}
-- The URLs in CSS text, and the CSS cyrano hands the browser.
--
-- Reading is CSS Syntax Level 3 §4 (tokenization), as far as finding URLs
-- needs it: comments, whitespace, strings, escapes, names, numbers (for
-- dimensions: "1url(x)" is no URL), hashes, at-keywords, functions, url
-- tokens and bad-urls. Newlines are \n, \r\n, \r and \f, read where they
-- stand (no preprocessing, so untouched text comes back byte for byte).
--
-- The URLs a browser fetches (checked against Chromium, css-vs-chromium):
--   * a url token: url(x), url( x ) — its value, escapes decoded;
--   * the string argument of a url() function: url("x"), URL( 'x' );
--   * the string after @import (comments and whitespace between);
--   * a string directly inside image-set() / -webkit-image-set().
-- A bad-url, a bad string and any other string are not URLs.
--
-- Rewriting: each such URL goes through containment (rewriteUrl). One that
-- is kept as written (data:, an anchor, already proxified) keeps its exact
-- text; any other is written url("…") for a url token and "…" for a
-- string, the value escaped as CSSOM serializes a string. Everything else
-- is the input's own text.
--
-- Implemented by go/src/internal/cssrewrite and ts/client/src/css/rewriter.ts.
module Css where

open import Data.Bool.Base using (Bool; true; false; _∧_; _∨_; not; if_then_else_)
open import Data.Char.Base using (Char; toℕ; fromℕ)
open import Data.List.Base using (List; []; _∷_; _++_; reverse; length)
open import Data.Maybe.Base using (Maybe; just; nothing)
open import Data.Nat.Base using (ℕ; zero; suc; _+_; _*_; _<ᵇ_; _≤ᵇ_; _∸_)
open import Data.Product.Base using (_×_; _,_; proj₁; proj₂)
open import Data.String.Base using (toList)

open import Url using (Str; is; within; isDigit; isAlpha; lowerAscii; eqStr)

------------------------------------------------------------------------
-- Code points (§4.2).

isNewline : Char → Bool
isNewline c = is 10 c ∨ is 13 c ∨ is 12 c

isWhitespace : Char → Bool
isWhitespace c = isNewline c ∨ is 9 c ∨ is 32 c

isHexDigitC : Char → Bool
isHexDigitC c = isDigit c ∨ within 65 70 c ∨ within 97 102 c

isIdentStart : Char → Bool
isIdentStart c = isAlpha c ∨ is 95 c ∨ (127 <ᵇ (toℕ c))

isNameChar : Char → Bool
isNameChar c = isIdentStart c ∨ isDigit c ∨ is 45 c

isNonPrintable : Char → Bool
isNonPrintable c = within 0 8 c ∨ is 11 c ∨ within 14 31 c ∨ is 127 c

-- Two code points are a valid escape: '\' not followed by a newline (§4.3.8).
validEscape : Str → Bool
validEscape ('\\' ∷ c ∷ _) = not (isNewline c)
validEscape ('\\' ∷ [])    = true -- '\' at EOF: an escape (U+FFFD)
validEscape _              = false

-- Would start an ident sequence (§4.3.9).
startsIdent : Str → Bool
startsIdent ('-' ∷ c ∷ cs) = isIdentStart c ∨ is 45 c ∨ validEscape (c ∷ cs)
startsIdent (c ∷ cs)       = isIdentStart c ∨ validEscape (c ∷ cs)
startsIdent []             = false

-- Would start a number (§4.3.10).
startsNumber : Str → Bool
startsNumber (c ∷ d ∷ e ∷ _) =
  if is 43 c ∨ is 45 c then (isDigit d ∨ (is 46 d ∧ isDigit e))
  else if is 46 c then isDigit d else isDigit c
startsNumber (c ∷ d ∷ []) =
  if is 43 c ∨ is 45 c then isDigit d else if is 46 c then isDigit d else isDigit c
startsNumber (c ∷ []) = isDigit c
startsNumber [] = false

------------------------------------------------------------------------
-- Consuming. Each consumer returns (the source text taken, its value, the
-- rest).

record Taken : Set where
  constructor taken
  field
    src  : Str   -- the input's own text
    val  : Str   -- its value (escapes decoded)
    rest : Str
open Taken

hexValue : Char → ℕ
hexValue c = if isDigit c then toℕ c ∸ 48 else if within 65 70 c then toℕ c ∸ 55 else toℕ c ∸ 87

replacement : Char
replacement = fromℕ 65533

-- An escape, after its '\' (§4.3.7): up to six hex digits and one
-- whitespace (\r\n counts as one), or the next code point.
consumeEscape : Str → Taken
consumeEscape [] = taken [] (replacement ∷ []) []
consumeEscape (c ∷ cs) =
  if isHexDigitC c then hexRun 5 (c ∷ []) (hexValue c) cs
  else taken (c ∷ []) (c ∷ []) cs
  where
  codePoint : ℕ → Char
  codePoint n = if (n ≡ᵇ′ 0) ∨ ((55295 <ᵇ n) ∧ (n <ᵇ 57344)) ∨ (1114111 <ᵇ n) then replacement else fromℕ n
    where
    _≡ᵇ′_ : ℕ → ℕ → Bool
    a ≡ᵇ′ b = (a ≤ᵇ b) ∧ (b ≤ᵇ a)

  endHex : Str → ℕ → Str → Taken
  endHex acc n ('\r' ∷ '\n' ∷ ds) = taken (reverse acc ++ '\r' ∷ '\n' ∷ []) (codePoint n ∷ []) ds
  endHex acc n (d ∷ ds) =
    if isWhitespace d then taken (reverse (d ∷ acc)) (codePoint n ∷ []) ds
    else taken (reverse acc) (codePoint n ∷ []) (d ∷ ds)
  endHex acc n [] = taken (reverse acc) (codePoint n ∷ []) []

  hexRun : ℕ → Str → ℕ → Str → Taken
  hexRun (suc k) acc n (d ∷ ds) =
    if isHexDigitC d then hexRun k (d ∷ acc) (n * 16 + hexValue d) ds else endHex acc n (d ∷ ds)
  hexRun _ acc n ds = endHex acc n ds

-- A name (§4.3.12).
consumeName : ℕ → Str → Taken
consumeName zero    s = taken [] [] s
consumeName (suc f) ('\\' ∷ cs) with validEscape ('\\' ∷ cs)
... | true  = let e = consumeEscape cs ; n = consumeName f (rest e)
              in taken ('\\' ∷ src e ++ src n) (val e ++ val n) (rest n)
... | false = taken [] [] ('\\' ∷ cs)
consumeName (suc f) (c ∷ cs) =
  if isNameChar c then (let n = consumeName f cs in taken (c ∷ src n) (c ∷ val n) (rest n))
  else taken [] [] (c ∷ cs)
consumeName (suc f) [] = taken [] [] []

-- A string, after its opening quote (§4.3.5); false: a bad string.
consumeString : ℕ → Char → Str → Taken × Bool
consumeString zero q s = taken [] [] s , true
consumeString (suc f) q [] = taken [] [] [] , true
consumeString (suc f) q (c ∷ cs) =
  if eqC c q then (taken (c ∷ []) [] cs , true)
  else if isNewline c then (taken [] [] (c ∷ cs) , false)
  else if is 92 c then escaped cs
  else more (c ∷ []) (c ∷ []) cs
  where
  eqC : Char → Char → Bool
  eqC a b = eqStr (a ∷ []) (b ∷ [])

  more : Str → Str → Str → Taken × Bool
  more s v r with consumeString f q r
  ... | (t , ok) = taken (s ++ src t) (v ++ val t) (rest t) , ok

  escaped : Str → Taken × Bool
  escaped [] = taken ('\\' ∷ []) [] [] , true
  escaped ('\r' ∷ '\n' ∷ ds) = more ('\\' ∷ '\r' ∷ '\n' ∷ []) [] ds
  escaped (d ∷ ds) =
    if isNewline d then more ('\\' ∷ d ∷ []) [] ds
    else (let e = consumeEscape (d ∷ ds) in more ('\\' ∷ src e) (val e) (rest e))

-- The remnants of a bad url (§4.3.14), up to and with its ')'.
consumeRemnants : ℕ → Str → Str × Str
consumeRemnants zero s = [] , s
consumeRemnants (suc f) [] = [] , []
consumeRemnants (suc f) (')' ∷ cs) = ')' ∷ [] , cs
consumeRemnants (suc f) ('\\' ∷ cs) with validEscape ('\\' ∷ cs)
... | true  = let e = consumeEscape cs ; r = consumeRemnants f (rest e) in ('\\' ∷ src e ++ proj₁ r) , proj₂ r
... | false = let r = consumeRemnants f cs in ('\\' ∷ proj₁ r) , proj₂ r
consumeRemnants (suc f) (c ∷ cs) = let r = consumeRemnants f cs in (c ∷ proj₁ r) , proj₂ r

dropWS : Str → Str × Str
dropWS (c ∷ cs) = if isWhitespace c then (let r = dropWS cs in (c ∷ proj₁ r) , proj₂ r) else [] , c ∷ cs
dropWS [] = [] , []

-- A url token's body, after "url(" and its whitespace (§4.3.6); false: bad url.
consumeUrl : ℕ → Str → Taken × Bool
consumeUrl zero s = taken [] [] s , true
consumeUrl (suc f) [] = taken [] [] [] , true
consumeUrl (suc f) (')' ∷ cs) = taken (')' ∷ []) [] cs , true
consumeUrl (suc f) (c ∷ cs) =
  if isWhitespace c then afterWS (dropWS (c ∷ cs))
  else if is 34 c ∨ is 39 c ∨ is 40 c ∨ isNonPrintable c then bad (c ∷ cs)
  else if is 92 c then escape cs
  else more (c ∷ []) (c ∷ []) cs
  where
  more : Str → Str → Str → Taken × Bool
  more s v r with consumeUrl f r
  ... | (t , ok) = taken (s ++ src t) (v ++ val t) (rest t) , ok

  bad : Str → Taken × Bool
  bad s = let r = consumeRemnants f s in taken (proj₁ r) [] (proj₂ r) , false

  afterWS : Str × Str → Taken × Bool
  afterWS (w , []) = taken w [] [] , true
  afterWS (w , ')' ∷ r) = taken (w ++ ')' ∷ []) [] r , true
  afterWS (w , r) = let b = consumeRemnants f r in taken (w ++ proj₁ b) [] (proj₂ b) , false

  escape : Str → Taken × Bool
  escape r with validEscape ('\\' ∷ r)
  ... | true  = let e = consumeEscape r in more ('\\' ∷ src e) (val e) (rest e)
  ... | false = bad ('\\' ∷ r)

-- A number's text (§4.3.11): extent only.
consumeNumber : Str → Str × Str
consumeNumber s with sign s
  where
  sign : Str → Str × Str
  sign (c ∷ cs) = if is 43 c ∨ is 45 c then (c ∷ []) , cs else [] , c ∷ cs
  sign [] = [] , []
... | (sg , r1) with digits r1
  where
  digits : Str → Str × Str
  digits (c ∷ cs) = if isDigit c then (let r = digits cs in (c ∷ proj₁ r) , proj₂ r) else [] , c ∷ cs
  digits [] = [] , []
... | (d1 , r2) with frac r2
  where
  digits′ : Str → Str × Str
  digits′ (c ∷ cs) = if isDigit c then (let r = digits′ cs in (c ∷ proj₁ r) , proj₂ r) else [] , c ∷ cs
  digits′ [] = [] , []

  frac : Str → Str × Str
  frac ('.' ∷ d ∷ cs) = if isDigit d then (let r = digits′ (d ∷ cs) in ('.' ∷ proj₁ r) , proj₂ r) else [] , '.' ∷ d ∷ cs
  frac s = [] , s
... | (d2 , r3) with expo r3
  where
  digits″ : Str → Str × Str
  digits″ (c ∷ cs) = if isDigit c then (let r = digits″ cs in (c ∷ proj₁ r) , proj₂ r) else [] , c ∷ cs
  digits″ [] = [] , []

  expo : Str → Str × Str
  expo (e ∷ s ∷ d ∷ cs) =
    if (is 69 e ∨ is 101 e) ∧ (is 43 s ∨ is 45 s) ∧ isDigit d
    then (let r = digits″ (d ∷ cs) in (e ∷ s ∷ proj₁ r) , proj₂ r)
    else if (is 69 e ∨ is 101 e) ∧ isDigit s then (let r = digits″ (s ∷ d ∷ cs) in (e ∷ proj₁ r) , proj₂ r)
    else [] , e ∷ s ∷ d ∷ cs
  expo (e ∷ d ∷ []) = if (is 69 e ∨ is 101 e) ∧ isDigit d then (e ∷ d ∷ []) , [] else [] , e ∷ d ∷ []
  expo s = [] , s
... | (ex , r4) = (sg ++ d1 ++ d2 ++ ex) , r4

------------------------------------------------------------------------
-- Tokens.

data Kind : Set where
  kWS kComment kString kBadString kUrl kBadUrl kFunction kAtKeyword kIdent kOther : Kind

record Tok : Set where
  constructor tok
  field
    kind  : Kind
    text  : Str   -- the input's own text
    value : Str   -- a string's or url's value, a name's (lowercase for matching)
open Tok

lowerAll : Str → Str
lowerAll []       = []
lowerAll (c ∷ cs) = lowerAscii c ∷ lowerAll cs

-- One token (§4.3.1) from a non-empty input; the rest.
token : Str → Tok × Str
token [] = tok kOther [] [] , []
token ('/' ∷ '*' ∷ cs) = comment ('*' ∷ '/' ∷ []) cs
  where
  comment : Str → Str → Tok × Str
  comment acc ('*' ∷ '/' ∷ r) = tok kComment (reverse ('/' ∷ '*' ∷ acc)) [] , r
  comment acc (d ∷ r) = comment (d ∷ acc) r
  comment acc [] = tok kComment (reverse acc) [] , []
token (c ∷ cs) =
  if isWhitespace c then (let w = dropWS (c ∷ cs) in tok kWS (proj₁ w) [] , proj₂ w)
  else if is 34 c ∨ is 39 c then str (consumeString (suc (length cs)) c cs)
  else if is 35 c ∧ (startsName cs) then
    (let n = consumeName (suc (length cs)) cs in tok kOther (c ∷ src n) [] , rest n)
  else if (is 43 c ∨ is 45 c ∨ is 46 c) ∧ startsNumber (c ∷ cs) then numeric (c ∷ cs)
  else if isDigit c then numeric (c ∷ cs)
  else if is 45 c ∧ startsCDC cs then tok kOther (c ∷ '-' ∷ '>' ∷ []) [] , drop2 cs
  else if is 64 c ∧ startsIdent cs then
    (let n = consumeName (suc (length cs)) cs in tok kAtKeyword (c ∷ src n) (lowerAll (val n)) , rest n)
  else if startsIdent (c ∷ cs) then identLike (c ∷ cs)
  else tok kOther (c ∷ []) [] , cs
  where
  startsName : Str → Bool
  startsName (d ∷ ds) = isNameChar d ∨ validEscape (d ∷ ds)
  startsName [] = false

  startsCDC : Str → Bool
  startsCDC ('-' ∷ '>' ∷ _) = true
  startsCDC _ = false

  drop2 : Str → Str
  drop2 (_ ∷ _ ∷ r) = r
  drop2 r = r

  str : Taken × Bool → Tok × Str
  str (t , true)  = tok kString (c ∷ src t) (val t) , rest t
  str (t , false) = tok kBadString (c ∷ src t) [] , rest t

  numeric : Str → Tok × Str
  numeric s with consumeNumber s
  ... | (num , r) =
    if startsIdent r then (let n = consumeName (suc (length r)) r in tok kOther (num ++ src n) [] , rest n)
    else tok kOther num [] , r

  -- An ident-like token (§4.3.4): an ident, a function, or a url.
  identLike : Str → Tok × Str
  identLike s with consumeName (suc (length s)) s
  ... | n = afterName (rest n)
    where
    isUrlName : Bool
    isUrlName = eqStr (lowerAll (val n)) (toList "url")

    quoteAfterWS : Str → Bool
    quoteAfterWS (d ∷ ds) = if isWhitespace d then quoteAfterWS ds else is 34 d ∨ is 39 d
    quoteAfterWS [] = false

    afterName : Str → Tok × Str
    afterName ('(' ∷ r) =
      if isUrlName ∧ not (quoteAfterWS r) then urlTok (dropWS r)
      else tok kFunction (src n ++ '(' ∷ []) (lowerAll (val n)) , r
      where
      urlTok : Str × Str → Tok × Str
      urlTok (w , r′) with consumeUrl (suc (length r′)) r′
      ... | (t , true)  = tok kUrl (src n ++ '(' ∷ w ++ src t) (val t) , rest t
      ... | (t , false) = tok kBadUrl (src n ++ '(' ∷ w ++ src t) [] , rest t
    afterName r = tok kIdent (src n) (lowerAll (val n)) , r

-- Every token takes at least one code point: the input's length is fuel
-- enough (what would be left over is one plain token).
tokenize : Str → List Tok
tokenize s = go (length s) s
  where
  go : ℕ → Str → List Tok
  go _       []      = []
  go zero    r       = tok kOther r [] ∷ []
  go (suc f) (c ∷ cs) with token (c ∷ cs)
  ... | (t , r) = t ∷ go f r

------------------------------------------------------------------------
-- Which tokens are URLs.

data Role : Set where
  asUrl asString plain : Role   -- a url token's value; a string that is a URL; neither

-- Which tokens are URLs: a url token; the first string directly inside a
-- url() function; a string after @import; a string directly inside
-- image-set(). Open functions and blocks are a stack (innermost first):
-- just a function's name, or nothing for ( [ {.
roles : List Tok → List Role
roles ts = go ts false []
  where
  isImageSet : Str → Bool
  isImageSet v = eqStr v (toList "image-set") ∨ eqStr v (toList "-webkit-image-set")

  inUrlFn : List (Maybe Str) → Bool
  inUrlFn (just v ∷ _) = eqStr v (toList "url")
  inUrlFn _ = false

  inImageSet : List (Maybe Str) → Bool
  inImageSet (just v ∷ _) = isImageSet v
  inImageSet _ = false

  -- url("x") takes one string.
  afterString : List (Maybe Str) → List (Maybe Str)
  afterString (just v ∷ st) = if eqStr v (toList "url") then just (toList "url-used") ∷ st else just v ∷ st
  afterString st = st

  pop : List (Maybe Str) → List (Maybe Str)
  pop (_ ∷ st) = st
  pop [] = []

  opens : Str → Bool
  opens (c ∷ []) = is 40 c ∨ is 91 c ∨ is 123 c
  opens _ = false

  closes : Str → Bool
  closes (c ∷ []) = is 41 c ∨ is 93 c ∨ is 125 c
  closes _ = false

  -- imp: the last significant token was @import.
  go : List Tok → Bool → List (Maybe Str) → List Role
  go [] _ _ = []
  go (t ∷ ts′) imp st with kind t
  ... | kWS        = plain ∷ go ts′ imp st
  ... | kComment   = plain ∷ go ts′ imp st
  ... | kUrl       = asUrl ∷ go ts′ false st
  ... | kString    = (if imp ∨ inUrlFn st ∨ inImageSet st then asString else plain) ∷ go ts′ false (afterString st)
  ... | kAtKeyword = plain ∷ go ts′ (eqStr (value t) (toList "import")) st
  ... | kFunction  = plain ∷ go ts′ false (just (value t) ∷ st)
  ... | _          = plain ∷ go ts′ false (if opens (text t) then nothing ∷ st else if closes (text t) then pop st else st)

------------------------------------------------------------------------
-- Writing.

hexDigitOf : ℕ → Char
hexDigitOf n = if n <ᵇ 10 then fromℕ (48 + n) else fromℕ (87 + n)

hexOf : ℕ → Str
hexOf n = go 8 n []
  where
  go : ℕ → ℕ → Str → Str
  go zero    m acc = acc
  go (suc k) m acc with m <ᵇ 16
  ... | true  = hexDigitOf m ∷ acc
  ... | false = go k (Data.Nat.Base._/_ m 16) (hexDigitOf (Data.Nat.Base._%_ m 16) ∷ acc)

-- CSSOM "serialize a string": quoted with ", escaping " and \ and the
-- control characters.
serializeString : Str → Str
serializeString s = '"' ∷ esc s ++ '"' ∷ []
  where
  esc : Str → Str
  esc [] = []
  esc (c ∷ cs) =
    if is 0 c then replacement ∷ esc cs
    else if within 1 31 c ∨ is 127 c then '\\' ∷ hexOf (toℕ c) ++ ' ' ∷ esc cs
    else if is 34 c ∨ is 92 c then '\\' ∷ c ∷ esc cs
    else c ∷ esc cs

-- The rewritten CSS, given what containment makes of a URL (nothing: kept
-- as written).
rewriteCss : (Str → Maybe Str) → Str → Str
rewriteCss rw s = emit (tokenize s) (roles (tokenize s))
  where
  emit : List Tok → List Role → Str
  emit (t ∷ ts) (asUrl ∷ rs) with rw (value t)
  ... | just u  = toList "url(" ++ serializeString u ++ ')' ∷ [] ++ emit ts rs
  ... | nothing = text t ++ emit ts rs
  emit (t ∷ ts) (asString ∷ rs) with rw (value t)
  ... | just u  = serializeString u ++ emit ts rs
  ... | nothing = text t ++ emit ts rs
  emit (t ∷ ts) (_ ∷ rs) = text t ++ emit ts rs
  emit (t ∷ ts) [] = text t ++ emit ts []
  emit [] _ = []

-- The URLs a stylesheet names, in order (what a browser would fetch, as
-- far as the text decides).
cssUrls : Str → List Str
cssUrls s = pick (tokenize s) (roles (tokenize s))
  where
  pick : List Tok → List Role → List Str
  pick (t ∷ ts) (asUrl ∷ rs)    = value t ∷ pick ts rs
  pick (t ∷ ts) (asString ∷ rs) = value t ∷ pick ts rs
  pick (t ∷ ts) (_ ∷ rs)        = pick ts rs
  pick _ _ = []
