{-# OPTIONS --safe #-}
-- CSS selectors on URL attributes in the DOM's lookup methods (TS:
-- patches/selectors.ts widenSelector). An element holds its URL
-- attributes proxied, so a selector naming the page's URL would find
-- nothing; each [attr="V"], [attr^="V"] on a URL attribute also admits the
-- value as the element holds it:
--
--     [src="V"]   →  :is([src="V"],[src="proxied(V)"])
--     [href^="V"] →  :is([href^="V"],[href^="proxied(V)"])
--
-- [attr*="//host/…"] and [attr$="//host/…"], with or without the end of a
-- scheme before "//" ("ps://host/…"), admit the proxied URL's /cyrano/…
-- part; a bare scheme prefix ([href^="https"]) every proxied URL of the
-- scheme, marked or not; any other *= or $= value is left alone (a part or
-- the end of the original URL past its host is still one of the proxied
-- URL). Each proxied value is admitted unmarked and marked js and css, as
-- an element's URL may be held (a script's src: /cyrano/https!js/…).
-- On srcset and imagesrcset (a URL list) an = or ^= value with no ASCII
-- whitespace or comma is the first candidate's URL, or its beginning, and
-- is widened as a URL is (Adobe's Edge Delivery finds a fragment's images
-- by source[srcset^="./media_"] to fix their base); any other test on
-- them is left alone.
-- Not covered: a relative value in a *= or $= test (the element holds it
-- resolved); a relative ^= prefix ending in "." of a path going on with
-- "." ([src^="."] on ../up.js: "." resolves to the directory, the path to
-- its parent); a URL carrying a referrer-policy mark. Checked against Chromium: selectors-
-- vs-chromium — an element holding a proxied URL is matched by the widened
-- selector exactly when the page's selector matches the page's URL, for a
-- page that writes the URL in one form (a page writing it relative in the
-- attribute and absolute in the selector now matches where directly it
-- would not: the known widening).
module Selectors where

open import Data.Bool.Base using (Bool; true; false; _∨_; _∧_; not; if_then_else_)
open import Data.Char.Base using (Char; toℕ; fromℕ)
open import Data.List.Base using (List; []; _∷_; _++_; reverse; map; concatMap)
open import Data.Maybe.Base using (Maybe; just; nothing)
open import Data.Nat.Base using (ℕ; zero; suc; _+_; _*_; _<ᵇ_)
open import Data.Product.Base using (_×_; _,_; proj₁; proj₂)
open import Data.String.Base using (String; toList)

open import Url using (Str; is; isAlpha; isDigit; isHex; hexVal; within; lowerAscii; eqStr; eqLower; isEmpty; break)
import Url

-- The page's URL rewriting (nothing: it throws, or the spec does not decide).
RW : Set
RW = Str → Maybe Str

startsWithL : Str → Str → Bool   -- ASCII case aside
startsWithL [] _ = true
startsWithL (p ∷ ps) (c ∷ cs) = Data.Char.Base._≈ᵇ_ (lowerAscii p) (lowerAscii c) ∧ startsWithL ps cs
  where import Data.Char.Base
startsWithL _ [] = false

indexOf : Str → Str → Maybe Str   -- the suffix starting at the first occurrence
indexOf pat [] = if isEmpty pat then just [] else nothing
indexOf pat (c ∷ cs) = if startsExact pat (c ∷ cs) then just (c ∷ cs) else indexOf pat cs
  where
  startsExact : Str → Str → Bool
  startsExact [] _ = true
  startsExact (p ∷ ps) (d ∷ ds) = Data.Char.Base._≈ᵇ_ p d ∧ startsExact ps ds
    where import Data.Char.Base
  startsExact _ [] = false

-- JavaScript's \s, for the ASCII the generator uses.
jsWS : Char → Bool
jsWS c = is 32 c ∨ is 9 c ∨ is 10 c ∨ is 11 c ∨ is 12 c ∨ is 13 c

isWordC : Char → Bool
isWordC c = isAlpha c ∨ isDigit c ∨ is 95 c

spanC : (Char → Bool) → Str → Str × Str
spanC p [] = [] , []
spanC p (c ∷ cs) = if p c then (c ∷ proj₁ (spanC p cs)) , proj₂ (spanC p cs) else [] , c ∷ cs

dropWS : Str → Str
dropWS s = proj₂ (spanC jsWS s)

------------------------------------------------------------------------
-- [ name op value flag? ]

data Op : Set where
  eq pre sub suf : Op

opText : Op → Str
opText eq  = toList "="
opText pre = toList "^="
opText sub = toList "*="
opText suf = toList "$="

record AttrSel : Set where
  constructor attrSel
  field
    name  : Str
    op    : Op
    raw   : Str           -- the value as written (escapes in)
    flag  : Maybe Char
open AttrSel

-- A quoted value after its quote q: the characters up to the closing q
-- (a backslash takes the next one), and the rest.
quoted : Char → Str → Maybe (Str × Str)
quoted q [] = nothing
quoted q (c ∷ cs) =
  if Data.Char.Base._≈ᵇ_ c q then just ([] , cs)
  else if is 92 c then esc cs
  else cons c (quoted q cs)
  where
  import Data.Char.Base
  cons : Char → Maybe (Str × Str) → Maybe (Str × Str)
  cons x (just (v , r)) = just (x ∷ v , r)
  cons x nothing        = nothing
  esc : Str → Maybe (Str × Str)
  esc (d ∷ ds) = cons '\\' (cons d (quoted q ds))
  esc []       = nothing

parseAttr : Str → Maybe AttrSel
parseAttr ('[' ∷ s₀) with dropWS s₀
... | [] = nothing
... | c ∷ cs =
  if isAlpha c ∨ is 95 c then afterName (c ∷ proj₁ (spanC (λ d → isWordC d ∨ is 45 d) cs)) (dropWS (proj₂ (spanC (λ d → isWordC d ∨ is 45 d) cs)))
  else nothing
  where
  close : Str → Bool
  close s with dropWS s
  ... | ']' ∷ [] = true
  ... | _ = false
  finish : Str → Op → Str → Str → Maybe AttrSel
  finish n o v r with dropWS r
  ... | f ∷ r′ = if (is 105 f ∨ is 73 f ∨ is 115 f ∨ is 83 f) ∧ close r′ then just (attrSel n o v (just f))
                 else if close (f ∷ r′) then just (attrSel n o v nothing) else nothing
  ... | [] = nothing
  value : Str → Op → Str → Maybe AttrSel
  value n o ('"' ∷ r) with quoted '"' r
  ... | just (v , r′) = finish n o v r′
  ... | nothing = nothing
  value n o ('\'' ∷ r) with quoted '\'' r
  ... | just (v , r′) = finish n o v r′
  ... | nothing = nothing
  value n o r with spanC (λ d → not (jsWS d ∨ is 93 d ∨ is 34 d ∨ is 39 d)) r
  ... | ([] , _) = nothing
  ... | (v , r′) = finish n o v r′
  afterName : Str → Str → Maybe AttrSel
  afterName n ('=' ∷ r) = value n eq (dropWS r)
  afterName n ('^' ∷ '=' ∷ r) = value n pre (dropWS r)
  afterName n ('*' ∷ '=' ∷ r) = value n sub (dropWS r)
  afterName n ('$' ∷ '=' ∷ r) = value n suf (dropWS r)
  afterName n _ = nothing
parseAttr _ = nothing

-- CSS escapes undone: \ and 1–6 hex digits (one whitespace after them
-- dropped), or \ and any character. (The generator keeps code points
-- valid: an invalid one throws in the runtime, which keeps the selector.)
unescape : Str → Str
unescape [] = []
unescape ('\\' ∷ c ∷ cs) = if isHex c then hex 5 (hexVal c) cs else c ∷ unescape cs
  where
  done : ℕ → Str → Str
  done n (d ∷ ds) = fromℕ n ∷ (if jsWS d then unescape ds else unescape (d ∷ ds))
  done n [] = fromℕ n ∷ []
  hex : ℕ → ℕ → Str → Str
  hex (suc k) n (d ∷ ds) = if isHex d then hex k (n * 16 + hexVal d) ds else done n (d ∷ ds)
  hex _ n ds = done n ds
unescape (c ∷ cs) = c ∷ unescape cs

urlAttr : Str → Bool
urlAttr n = anyS (map toList ("src" ∷ "href" ∷ "action" ∷ "formaction" ∷ "poster" ∷ "data" ∷ "background" ∷ "cite" ∷ "manifest" ∷ "ping"
  ∷ "attributionsrc" ∷ "xlink:href" ∷ []))
  where
  anyS : List Str → Bool
  anyS [] = false
  anyS (x ∷ xs) = eqStr (map lowerAscii n) x ∨ anyS xs

srcsetAttr : Str → Bool
srcsetAttr n = eqStr (map lowerAscii n) (toList "srcset") ∨ eqStr (map lowerAscii n) (toList "imagesrcset")

-- No ASCII whitespace, no comma: one URL of a srcset's first candidate.
oneUrl : Str → Bool
oneUrl [] = true
oneUrl (c ∷ cs) = not (is 32 c ∨ is 9 c ∨ is 10 c ∨ is 12 c ∨ is 13 c ∨ is 44 c) ∧ oneUrl cs

skipped : Str → Bool
skipped v = isEmpty v ∨ startsWithL (toList "#") v ∨ anyP ("data:" ∷ "blob:" ∷ "javascript:" ∷ "mailto:" ∷ "tel:" ∷ "about:" ∷ [])
  where
  anyP : List String → Bool
  anyP [] = false
  anyP (p ∷ ps) = startsWithL (toList p) v ∨ anyP ps

-- *=: a value naming a host after "//" — (http|https:)? // c rest, c not
-- / ? # or whitespace, no line break anywhere after.
filterS : (Str → Bool) → List Str → List Str
filterS p [] = []
filterS p (x ∷ xs) = if p x then x ∷ filterS p xs else filterS p xs

endsWithL : Str → Str → Bool
endsWithL e s = startsWithL (reverse e) (reverse s)

lineBreak : Char → Bool
lineBreak c = is 10 c ∨ is 13 c ∨ is 8232 c ∨ is 8233 c

noBreak : Str → Bool
noBreak [] = true
noBreak (c ∷ cs) = not (lineBreak c) ∧ noBreak cs

hostRest : List Str → Str → Maybe (List Str × Str)
hostRest [] _ = nothing
hostRest scs (c ∷ cs) = if not (is 47 c ∨ is 63 c ∨ is 35 c ∨ jsWS c) ∧ noBreak (c ∷ cs) then just (scs , c ∷ cs) else nothing
hostRest scs [] = nothing

-- A value naming a host after "//": (the end of) a scheme or nothing, then
-- "://", or just "//"; the schemes it can be the end of.
hostAfterSlashes : Str → Maybe (List Str × Str)
hostAfterSlashes v with spanC isAlpha v
... | (letters , ':' ∷ '/' ∷ '/' ∷ r) = hostRest (filterS (λ sc → endsWithL letters sc) (toList "https" ∷ toList "http" ∷ [])) r
... | ([] , '/' ∷ '/' ∷ r) = hostRest (toList "https" ∷ toList "http" ∷ []) r
... | _ = nothing

-- A proxied URL as an element may hold it: unmarked, marked js, marked css.
withMarks : Str → List Str
withMarks p = byAt (splitAt (toList "/cyrano/") [] p)
  where
  -- the text before the first "/cyrano/" (reversed acc) and after it
  splitAt : Str → Str → Str → Maybe (Str × Str)
  splitAt pat acc [] = nothing
  splitAt pat acc (c ∷ cs) = if startsWithL pat (c ∷ cs) ∧ exact pat (c ∷ cs) then just (reverse acc , dropN pat (c ∷ cs)) else splitAt pat (c ∷ acc) cs
    where
    exact : Str → Str → Bool
    exact [] _ = true
    exact (a ∷ as) (b ∷ bs) = Data.Char.Base._≈ᵇ_ a b ∧ exact as bs
      where import Data.Char.Base
    exact _ [] = false
    dropN : Str → Str → Str
    dropN [] s = s
    dropN (_ ∷ ps) (_ ∷ ss) = dropN ps ss
    dropN _ [] = []
  byAt : Maybe (Str × Str) → List Str
  byAt nothing = p ∷ []
  byAt (just (before , after)) with break (is 47) after
  ... | (seg , '/' ∷ tail) =
    if Url.any (is 33) seg then p ∷ []
    else p ∷ (before ++ toList "/cyrano/" ++ seg ++ toList "!js/" ++ tail) ∷ (before ++ toList "/cyrano/" ++ seg ++ toList "!css/" ++ tail) ∷ []
  ... | _ = p ∷ []

bareScheme : Str → Bool   -- https?:?/?/? , case aside
bareScheme v = any (map toList ("http" ∷ "http:" ∷ "http:/" ∷ "http://" ∷ "http/" ∷ "http//" ∷ "https" ∷ "https:" ∷ "https:/" ∷ "https://" ∷ "https/" ∷ "https//" ∷ []))
  where
  any : List Str → Bool
  any [] = false
  any (x ∷ xs) = eqLower v x ∨ any xs

-- The test written for an alternative value.
quoteValue : Str → Str
quoteValue [] = []
quoteValue (c ∷ cs) =
  if is 92 c then '\\' ∷ '\\' ∷ quoteValue cs
  else if is 34 c then '\\' ∷ '"' ∷ quoteValue cs
  else if is 10 c then '\\' ∷ 'a' ∷ ' ' ∷ quoteValue cs
  else c ∷ quoteValue cs

joinComma : List Str → Str
joinComma [] = []
joinComma (x ∷ []) = x
joinComma (x ∷ xs) = x ++ ',' ∷ joinComma xs

-- One bracket, widened (the same text when it is not a URL test).
widenAttribute : RW → Str → Str → Str
widenAttribute rw proxyBase whole with parseAttr whole
... | nothing = whole
... | just a =
  if skipped v then whole
  else if urlAttr (name a) then byOp (op a)
  else if srcsetAttr (name a) ∧ oneUrl v ∧ eqOrPre (op a) then byOp (op a)
  else whole
  where
  v : Str
  v = unescape (raw a)
  eqOrPre : Op → Bool
  eqOrPre eq  = true
  eqOrPre pre = true
  eqOrPre _   = false
  flagText : Str
  flagText with flag a
  ... | just f  = ' ' ∷ f ∷ []
  ... | nothing = []
  test : Str → Str
  test x = '[' ∷ name a ++ opText (op a) ++ '"' ∷ quoteValue x ++ '"' ∷ flagText ++ ']' ∷ []
  wrap : List Str → Str
  wrap alts = toList ":is(" ++ whole ++ ',' ∷ joinComma (map test alts) ++ ')' ∷ []
  -- *= : each scheme's proxied URL from its /cyrano/ on; any failure: whole.
  subAlts : List Str → Str → Maybe (List Str)
  subAlts [] rest = just []
  subAlts (sc ∷ scs) rest with rw (sc ++ toList "://" ++ rest)
  ... | nothing = nothing
  ... | just p with indexOf (toList "/cyrano/") p
  ...   | nothing = nothing
  ...   | just tail with subAlts scs rest
  ...     | just more = just (withMarks tail ++ more)
  ...     | nothing = nothing
  byOp : Op → Str
  partAlts : Str
  partAlts with hostAfterSlashes v
  ... | nothing = whole
  ... | just (scs , rest) with subAlts scs rest
  ...   | just alts = wrap alts
  ...   | nothing = whole
  byOp sub = partAlts
  byOp suf = partAlts
  byOp pre =
    if bareScheme v
    then wrap (if startsWithL (toList "https") v then (proxyBase ++ toList "/cyrano/https/") ∷ (proxyBase ++ toList "/cyrano/https!") ∷ []
               else (proxyBase ++ toList "/cyrano/http/") ∷ (proxyBase ++ toList "/cyrano/http!") ∷ (proxyBase ++ toList "/cyrano/https/") ∷ (proxyBase ++ toList "/cyrano/https!") ∷ [])
    else plain
    where
    plain : Str
    plain with rw v
    ... | nothing = whole
    ... | just p = if eqStr p v then whole else wrap (withMarks p)
  byOp eq with rw v
  ... | nothing = whole
  ... | just p = if eqStr p v then whole else wrap (withMarks p)

------------------------------------------------------------------------
-- The whole selector: brackets found as the runtime finds them — a string
-- outside brackets kept whole, a backslash taking the next character, a
-- bracket running to the first "]" outside its strings and escapes; a
-- bracket never closed leaves the selector as it is.

-- The end of a string starting after its quote: the string's rest and what follows.
stringRest : Char → Str → Str × Str
stringRest q [] = [] , []
stringRest q (c ∷ cs) =
  if is 92 c then twoStep cs
  else if Data.Char.Base._≈ᵇ_ c q then (c ∷ []) , cs
  else (c ∷ proj₁ (stringRest q cs)) , proj₂ (stringRest q cs)
  where
  import Data.Char.Base
  twoStep : Str → Str × Str
  twoStep (d ∷ ds) = ('\\' ∷ d ∷ proj₁ (stringRest q ds)) , proj₂ (stringRest q ds)
  twoStep [] = ('\\' ∷ []) , []

-- A bracket's text after "[" up to and with its "]", or nothing (fuel:
-- the input's length).
bracketRest : ℕ → Str → Maybe (Str × Str)
bracketRest zero _ = nothing
bracketRest (suc k) [] = nothing
bracketRest (suc k) (c ∷ cs) =
  if is 93 c then just ((c ∷ []) , cs)
  else if is 92 c then esc cs
  else if is 34 c ∨ is 39 c then str (stringRest c cs)
  else cons (c ∷ []) (bracketRest k cs)
  where
  cons : Str → Maybe (Str × Str) → Maybe (Str × Str)
  cons x (just (b , r)) = just (x ++ b , r)
  cons x nothing = nothing
  esc : Str → Maybe (Str × Str)
  esc (d ∷ ds) = cons ('\\' ∷ d ∷ []) (bracketRest k ds)
  esc [] = nothing
  str : Str × Str → Maybe (Str × Str)
  str (body , rest) = cons (c ∷ body) (bracketRest k rest)

len : Str → ℕ
len [] = zero
len (_ ∷ cs) = suc (len cs)

-- fuel: the input's length
widenFrom : ℕ → RW → Str → Str → Maybe Str
widenFrom zero rw pb s = just s
widenFrom (suc n) rw pb [] = just []
widenFrom (suc n) rw pb (c ∷ cs) =
  if is 34 c ∨ is 39 c then strOut (stringRest c cs)
  else if is 92 c then escOut cs
  else if is 91 c then brOut (bracketRest (suc (len cs)) cs)
  else cons (c ∷ []) (widenFrom n rw pb cs)
  where
  cons : Str → Maybe Str → Maybe Str
  cons x (just r) = just (x ++ r)
  cons x nothing  = nothing
  strOut : Str × Str → Maybe Str
  strOut (body , rest) = cons (c ∷ body) (widenFrom n rw pb rest)
  escOut : Str → Maybe Str
  escOut (d ∷ ds) = cons ('\\' ∷ d ∷ []) (widenFrom n rw pb ds)
  escOut [] = just ('\\' ∷ [])
  brOut : Maybe (Str × Str) → Maybe Str
  brOut nothing = nothing
  brOut (just (b , rest)) = cons (widenAttribute rw pb ('[' ∷ b)) (widenFrom n rw pb rest)

widenSelector : RW → Str → Str → Str
widenSelector rw pb s with widenFrom (suc (len s)) rw pb s
... | just w  = w
... | nothing = s
