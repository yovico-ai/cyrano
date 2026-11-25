{-# OPTIONS --safe #-}
-- Import maps as cyrano hands them to the browser (HTML "import maps").
--
-- The page's module specifiers are proxified, so the map's must be too: a
-- URL-like specifier key and every URL-like string address in "imports" and
-- in each scope, and every scope prefix. Bare specifiers ("react") and
-- values that are not strings stay. "integrity" holds hashes of the
-- original modules, which the rewritten ones cannot match: its value
-- becomes {}.
--
-- The map is edited as text, not re-serialized: each rewritten string is
-- replaced by its JSON.stringify form, everything else is the page's own
-- text. Text that is not JSON (RFC 8259), or not an object, is left as
-- written (the browser rejects it too). A key repeated in an object is
-- edited at each occurrence (JSON.parse keeps the last).
--
-- URL-like (HTML "resolve a URL-like module specifier"): starting with
-- "/", "./" or "../", or parsing as an absolute URL.
--
-- Implemented by go/src/internal/urlrewrite/importmap.go and
-- ts/client/src/patches/dynamic-html.ts (rewriteImportMap).
module ImportMap where

open import Data.Bool.Base using (Bool; true; false; _∧_; _∨_; not; if_then_else_)
open import Data.Char.Base using (Char; toℕ; fromℕ)
open import Data.List.Base using (List; []; _∷_; _++_; reverse; length)
open import Data.Maybe.Base using (Maybe; just; nothing)
open import Data.Nat.Base using (ℕ; zero; suc; _+_; _*_; _∸_; _<ᵇ_; _/_; _%_)
open import Data.Product.Base using (_×_; _,_; proj₁; proj₂)
open import Data.String.Base using (toList)

open import Url

------------------------------------------------------------------------
-- Tokens.

data TK : Set where
  tWS tPunct tString tLit tBad : TK

record Tok : Set where
  constructor tok
  field
    kind  : TK
    text  : Str
    value : Str   -- a string's value
open Tok

isJsonWS : Char → Bool
isJsonWS c = is 32 c ∨ is 9 c ∨ is 10 c ∨ is 13 c

isHexJ : Char → Bool
isHexJ c = isDigit c ∨ within 65 70 c ∨ within 97 102 c

four : Str → Maybe (ℕ × Str × Str)
four (a ∷ b ∷ c ∷ d ∷ r) =
  if isHexJ a ∧ isHexJ b ∧ isHexJ c ∧ isHexJ d
  then just (((hexVal a * 16 + hexVal b) * 16 + hexVal c) * 16 + hexVal d , (a ∷ b ∷ c ∷ d ∷ []) , r)
  else nothing
four _ = nothing

isHigh isLow : ℕ → Bool
isHigh n = (55295 <ᵇ n) ∧ (n <ᵇ 56320)
isLow  n = (56319 <ᵇ n) ∧ (n <ᵇ 57344)

-- A \u escape after "\u": text, value, rest. A high surrogate followed by a
-- \u low surrogate is one code point.
uEscape : Str → Maybe (Str × Str × Str)
uEscape r with four r
... | nothing = nothing
... | just (n , t , r′) = pair (isHigh n) r′
  where
  pair : Bool → Str → Maybe (Str × Str × Str)
  pair true ('\\' ∷ 'u' ∷ r″) with four r″
  ... | just (m , t′ , r‴) =
    if isLow m then just ((t ++ '\\' ∷ 'u' ∷ t′) , (fromℕ (65536 + (n ∸ 55296) * 1024 + (m ∸ 56320)) ∷ []) , r‴)
    else just (t , (fromℕ n ∷ []) , r′)
  ... | nothing = just (t , (fromℕ n ∷ []) , r′)
  pair _ _ = just (t , (fromℕ n ∷ []) , r′)

-- A string after its opening quote: the text after the quote (closing
-- quote included), the value, the rest; nothing when not valid JSON.
readString : ℕ → Str → Maybe (Str × Str × Str)
readString zero _ = nothing
readString (suc f) [] = nothing
readString (suc f) ('"' ∷ r) = just (('"' ∷ []) , [] , r)
readString (suc f) ('\\' ∷ e ∷ r) = after (esc e)
  where
  esc : Char → Maybe (Str × Str × Str)
  esc e′ =
    if is 117 e′ then uEscape r
    else if is 34 e′ ∨ is 92 e′ ∨ is 47 e′ then just ([] , (e′ ∷ []) , r)
    else if is 98 e′ then just ([] , (fromℕ 8 ∷ []) , r)
    else if is 102 e′ then just ([] , (fromℕ 12 ∷ []) , r)
    else if is 110 e′ then just ([] , (fromℕ 10 ∷ []) , r)
    else if is 114 e′ then just ([] , (fromℕ 13 ∷ []) , r)
    else if is 116 e′ then just ([] , (fromℕ 9 ∷ []) , r)
    else nothing

  after : Maybe (Str × Str × Str) → Maybe (Str × Str × Str)
  after nothing = nothing
  after (just (t , v , r′)) with readString f r′
  ... | nothing = nothing
  ... | just (t′ , v′ , r″) = just (('\\' ∷ e ∷ t ++ t′) , (v ++ v′) , r″)
readString (suc f) (c ∷ r) =
  if toℕ c <ᵇ 32 then nothing else more (readString f r)
  where
  more : Maybe (Str × Str × Str) → Maybe (Str × Str × Str)
  more nothing = nothing
  more (just (t , v , r′)) = just ((c ∷ t) , (c ∷ v) , r′)

-- JSON number syntax.
validNumber : Str → Bool
validNumber s = intPart (skipMinus s)
  where
  skipMinus : Str → Str
  skipMinus ('-' ∷ r) = r
  skipMinus r = r

  digitsRest : Str → Str
  digitsRest (d ∷ r) = if isDigit d then digitsRest r else d ∷ r
  digitsRest [] = []

  digits1 : Str → Maybe Str
  digits1 (c ∷ r) = if isDigit c then just (digitsRest r) else nothing
  digits1 [] = nothing

  end : Maybe Str → Bool
  end (just []) = true
  end _ = false

  expo : Str → Bool
  expo [] = true
  expo (e ∷ r) = (is 101 e ∨ is 69 e) ∧ signed r
    where
    signed : Str → Bool
    signed (s′ ∷ r′) = if is 43 s′ ∨ is 45 s′ then end (digits1 r′) else end (digits1 (s′ ∷ r′))
    signed [] = false

  frac : Str → Bool
  frac ('.' ∷ r) with digits1 r
  ... | just r′ = expo r′
  ... | nothing = false
  frac r = expo r

  intPart : Str → Bool
  intPart ('0' ∷ r) = frac r
  intPart r with digits1 r
  ... | just r′ = frac r′
  ... | nothing = false

isLitChar : Char → Bool
isLitChar c = isAlpha c ∨ isDigit c ∨ is 43 c ∨ is 45 c ∨ is 46 c

isPunct : Char → Bool
isPunct c = is 123 c ∨ is 125 c ∨ is 91 c ∨ is 93 c ∨ is 58 c ∨ is 44 c

-- The tokens; nothing when the text is not JSON at the token level.
tokenize : Str → Maybe (List Tok)
tokenize s = go (length s) s
  where
  wsRun : Str → Str × Str
  wsRun (c ∷ cs) = if isJsonWS c then (let r = wsRun cs in (c ∷ proj₁ r) , proj₂ r) else [] , c ∷ cs
  wsRun [] = [] , []

  litRun : Str → Str × Str
  litRun (c ∷ cs) = if isLitChar c then (let r = litRun cs in (c ∷ proj₁ r) , proj₂ r) else [] , c ∷ cs
  litRun [] = [] , []

  validLit : Str → Bool
  validLit t = eqStr t (toList "true") ∨ eqStr t (toList "false") ∨ eqStr t (toList "null") ∨ validNumber t

  cons : Tok → Maybe (List Tok) → Maybe (List Tok)
  cons t (just ts) = just (t ∷ ts)
  cons t nothing   = nothing

  go : ℕ → Str → Maybe (List Tok)
  go _ [] = just []
  go zero _ = nothing
  go (suc f) (c ∷ cs) =
    if isJsonWS c then (let r = wsRun (c ∷ cs) in cons (tok tWS (proj₁ r) []) (go f (proj₂ r)))
    else if isPunct c then cons (tok tPunct (c ∷ []) []) (go f cs)
    else if is 34 c then str (readString (length cs) cs)
    else if isLitChar c then (let r = litRun (c ∷ cs) in
                              if validLit (proj₁ r) then cons (tok tLit (proj₁ r) []) (go f (proj₂ r)) else nothing)
    else nothing
    where
    str : Maybe (Str × Str × Str) → Maybe (List Tok)
    str nothing = nothing
    str (just (t , v , r)) = cons (tok tString ('"' ∷ t) v) (go f r)

------------------------------------------------------------------------
-- Structure: a role for each token.

data Role : Set where
  keep       : Role   -- the token's own text
  asSpecifier : Role  -- a string rewritten when URL-like
  asPrefix   : Role   -- a string rewritten (a scope prefix)
  emptyObj   : Role   -- {} in place of the token
  drop       : Role   -- nothing

-- What an object's members are, for the roles of their keys and values.
data Ctx : Set where
  topMap specifierMap scopesMap integrityMap other : Ctx

isWS : Tok → Bool
isWS t with kind t
... | tWS = true
... | _   = false

isP : Char → Tok → Bool
isP c t with kind t
... | tPunct = eqStr (text t) (c ∷ [])
... | _ = false

-- Parsing over the tokens with whitespace skipped: each function takes
-- the tokens from a position and returns the roles of the tokens it read
-- (whitespace included) and the rest; nothing when not JSON.
Parse : Set
Parse = Maybe (List Role × List Tok)

skipWS : List Tok → List Role × List Tok
skipWS (t ∷ ts) = if isWS t then (let r = skipWS ts in (keep ∷ proj₁ r) , proj₂ r) else [] , t ∷ ts
skipWS [] = [] , []

-- Roles for every token of a value read as `r` (used for integrity's
-- value: the first becomes {}, the rest go).
replaceAll : List Role → List Role
replaceAll []       = []
replaceAll (_ ∷ rs) = emptyObj ∷ dropAll rs
  where
  dropAll : List Role → List Role
  dropAll [] = []
  dropAll (_ ∷ xs) = drop ∷ dropAll xs

mutual
  -- A value in context `ctx` (the map it is the value of), `asStr`: the
  -- role a string value takes here.
  jvalue : ℕ → Ctx → Role → List Tok → Parse
  jvalue zero _ _ _ = nothing
  jvalue (suc f) ctx asStr ts with skipWS ts
  ... | (w , t ∷ rest) with kind t
  ...   | tString = just ((w ++ asStr ∷ []) , rest)
  ...   | tLit    = just ((w ++ keep ∷ []) , rest)
  ...   | tPunct  = if isP '{' t then objectFrom f ctx (w ++ keep ∷ []) rest
                    else if isP '[' t then arrayFrom f (w ++ keep ∷ []) rest
                    else nothing
  ...   | _       = nothing
  jvalue (suc f) ctx asStr ts | (w , []) = nothing

  -- After '{': members up to '}'.
  objectFrom : ℕ → Ctx → List Role → List Tok → Parse
  objectFrom zero _ _ _ = nothing
  objectFrom (suc f) ctx acc ts with skipWS ts
  ... | (w , t ∷ rest) =
    if isP '}' t then just ((acc ++ w ++ keep ∷ []) , rest)
    else members f ctx (acc ++ w) (t ∷ rest)
  ... | (w , []) = nothing

  -- A member and what follows it (',' member … '}').
  members : ℕ → Ctx → List Role → List Tok → Parse
  members zero _ _ _ = nothing
  members (suc f) ctx acc (k ∷ ts) with kind k
  ... | tString with skipWS ts
  ...   | (w , c ∷ ts′) =
    if isP ':' c then afterValue (memberValue (jvalue f (childCtx ctx (value′ k)) (valueRole ctx) ts′))
    else nothing
    where
    value′ : Tok → Str
    value′ x = Tok.value x

    keyRole : Role
    keyRole = keyRoleOf ctx

    -- integrity's value: replaced by {}
    memberValue : Parse → Parse
    memberValue nothing = nothing
    memberValue (just (rs , r)) =
      if isIntegrity then just (replaceValue rs , r) else just (rs , r)
      where
      isIntegrity : Bool
      isIntegrity = isTop ctx ∧ eqStr (Tok.value k) (toList "integrity")
      -- whitespace before the value keeps; the value's own tokens go
      replaceValue : List Role → List Role
      replaceValue rs′ = keepWS rs′ (valueStartsAfterWS ts′)
        where
        valueStartsAfterWS : List Tok → ℕ
        valueStartsAfterWS (x ∷ xs) = if isWS x then suc (valueStartsAfterWS xs) else zero
        valueStartsAfterWS [] = zero
        keepWS : List Role → ℕ → List Role
        keepWS rs″ zero = replaceAll rs″
        keepWS (r′ ∷ rs″) (suc n) = r′ ∷ keepWS rs″ n
        keepWS [] _ = []

    nextMember : List Role → List Tok → Parse
    nextMember base r with skipWS r
    ... | (w″ , n ∷ r″) with kind n
    ...   | tString = members f ctx (base ++ w″) (n ∷ r″)
    ...   | _ = nothing
    nextMember base r | (_ , []) = nothing

    afterValue : Parse → Parse
    afterValue nothing = nothing
    afterValue (just (rs , r)) with skipWS r
    ... | (w′ , d ∷ r′) =
      if isP ',' d then (let base = acc ++ keyRole ∷ w ++ keep ∷ rs ++ w′ ++ keep ∷ [] in nextMember base r′)
      else if isP '}' d then just ((acc ++ keyRole ∷ w ++ keep ∷ rs ++ w′ ++ keep ∷ []) , r′)
      else nothing
    ... | (_ , []) = nothing
  ... | (w , []) = nothing
  members (suc f) ctx acc (k ∷ ts) | _ = nothing
  members (suc f) ctx acc [] = nothing

  -- After '[': elements up to ']'.
  arrayFrom : ℕ → List Role → List Tok → Parse
  arrayFrom zero _ _ = nothing
  arrayFrom (suc f) acc ts with skipWS ts
  ... | (w , t ∷ rest) =
    if isP ']' t then just ((acc ++ w ++ keep ∷ []) , rest)
    else elements f acc ts
  ... | (w , []) = nothing

  elements : ℕ → List Role → List Tok → Parse
  elements zero _ _ = nothing
  elements (suc f) acc ts with jvalue f other keep ts
  ... | nothing = nothing
  ... | just (rs , r) with skipWS r
  ...   | (w , d ∷ r′) =
    if isP ',' d then elements f (acc ++ rs ++ w ++ keep ∷ []) r′
    else if isP ']' d then just ((acc ++ rs ++ w ++ keep ∷ []) , r′)
    else nothing
  ...   | (_ , []) = nothing

  isTop : Ctx → Bool
  isTop topMap = true
  isTop _ = false

  -- The roles a member's key and its string value take in each map.
  keyRoleOf : Ctx → Role
  keyRoleOf specifierMap = asSpecifier
  keyRoleOf scopesMap    = asPrefix
  keyRoleOf _            = keep

  valueRole : Ctx → Role
  valueRole specifierMap = asSpecifier
  valueRole _            = keep

  -- The map a member's value is, by its key.
  childCtx : Ctx → Str → Ctx
  childCtx topMap k =
    if eqStr k (toList "imports") then specifierMap
    else if eqStr k (toList "scopes") then scopesMap
    else other
  childCtx scopesMap _ = specifierMap
  childCtx _ _ = other

-- The roles of all tokens, when the text is a JSON object (trailing
-- whitespace allowed).
roles : List Tok → Maybe (List Role)
roles ts with skipWS ts
... | (w , t ∷ rest) =
  if isP '{' t then whole (objectFrom (length ts) topMap (w ++ keep ∷ []) rest) else nothing
  where
  whole : Parse → Maybe (List Role)
  whole nothing = nothing
  whole (just (rs , r)) with skipWS r
  ... | (w′ , []) = just (rs ++ w′)
  ... | _ = nothing
... | (_ , []) = nothing

------------------------------------------------------------------------
-- Writing.

hexDigitOf : ℕ → Char
hexDigitOf n = if n <ᵇ 10 then fromℕ (48 + n) else fromℕ (87 + n)

-- JSON.stringify of a string.
stringify : Str → Str
stringify s = '"' ∷ esc s ++ '"' ∷ []
  where
  u4 : ℕ → Str
  u4 n = '\\' ∷ 'u' ∷ hexDigitOf ((n / 4096) % 16) ∷ hexDigitOf ((n / 256) % 16) ∷ hexDigitOf ((n / 16) % 16) ∷ hexDigitOf (n % 16) ∷ []

  esc : Str → Str
  esc [] = []
  esc (c ∷ cs) =
    if is 34 c then '\\' ∷ '"' ∷ esc cs
    else if is 92 c then '\\' ∷ '\\' ∷ esc cs
    else if is 8 c then '\\' ∷ 'b' ∷ esc cs
    else if is 12 c then '\\' ∷ 'f' ∷ esc cs
    else if is 10 c then '\\' ∷ 'n' ∷ esc cs
    else if is 13 c then '\\' ∷ 'r' ∷ esc cs
    else if is 9 c then '\\' ∷ 't' ∷ esc cs
    else if toℕ c <ᵇ 32 then u4 (toℕ c) ++ esc cs
    else if isHigh (toℕ c) ∨ isLow (toℕ c) then u4 (toℕ c) ++ esc cs
    else c ∷ esc cs

-- URL-like (HTML): "/", "./", "../" first, or an absolute URL.
urlLike : Str → Bool
urlLike ('/' ∷ _) = true
urlLike ('.' ∷ '/' ∷ _) = true
urlLike ('.' ∷ '.' ∷ '/' ∷ _) = true
urlLike s with parse nothing (preprocess s)
... | url _       = true
... | otherScheme = true
... | _           = false

-- The rewritten import map, given what containment makes of a URL
-- (nothing: kept as written).
rewriteImportMap : (Str → Maybe Str) → Str → Str
rewriteImportMap rw s with tokenize s
... | nothing = s
... | just ts with roles ts
...   | nothing = s
...   | just rs = emit ts rs
  where
  replaced : Tok → Str
  replaced t with rw (Tok.value t)
  ... | just u  = stringify u
  ... | nothing = text t

  emit : List Tok → List Role → Str
  emit (t ∷ ts′) (keep ∷ rs′)        = text t ++ emit ts′ rs′
  emit (t ∷ ts′) (asSpecifier ∷ rs′) = (if urlLike (Tok.value t) then replaced t else text t) ++ emit ts′ rs′
  emit (t ∷ ts′) (asPrefix ∷ rs′)    = replaced t ++ emit ts′ rs′
  emit (t ∷ ts′) (emptyObj ∷ rs′)    = toList "{}" ++ emit ts′ rs′
  emit (t ∷ ts′) (drop ∷ rs′)        = emit ts′ rs′
  emit (t ∷ ts′) []                  = text t ++ emit ts′ []
  emit [] _ = []

------------------------------------------------------------------------
-- A scope prefix twice (rewriteImportMapT). The prefix is proxified as a
-- module URL, marked !js, and covers the modules under it; a document's
-- own inline modules have the document's URL as their referrer, whose
-- proxified form carries the document's mark (none, a policy, !frame),
-- not !js — so `"scopes": {"/": …}` never applied to them (round I). Each
-- scope is written again after itself, its prefix in the document's form
-- (`twin`: nothing when that is the same text), its value as rewritten.

-- The tokens of the value after a key (up to the end of its object or
-- array, or the one string or literal), and the tokens after it; with
-- their roles. `colon`: the ':' and spaces before it are taken first.
spanValue : ℕ → List Tok → List Role → (List Tok × List Role) × (List Tok × List Role)
spanValue fuel ts rs = go fuel 0 false ts rs
  where
  depthOf : Tok → ℕ → ℕ
  depthOf t d = if isP '{' t ∨ isP '[' t then suc d else if isP '}' t ∨ isP ']' t then d ∸ 1 else d
  opens : Tok → Bool
  opens t = isP '{' t ∨ isP '[' t
  -- started: the value's first token has been taken
  go : ℕ → ℕ → Bool → List Tok → List Role → (List Tok × List Role) × (List Tok × List Role)
  go zero _ _ ts′ rs′ = ([] , []) , (ts′ , rs′)
  go (suc n) d started (t ∷ ts′) (r ∷ rs′) =
    if not started ∧ (isP ':' t ∨ isWS t) then cons t r (go n d false ts′ rs′)
    else if not started then
      (if opens t then cons t r (go n 1 true ts′ rs′) else (t ∷ [] , r ∷ []) , (ts′ , rs′))
    else (if depthOf t d ≡ᵇ 0 then (t ∷ [] , r ∷ []) , (ts′ , rs′) else cons t r (go n (depthOf t d) true ts′ rs′))
    where
    open Data.Nat.Base using (_≡ᵇ_)
    import Data.Nat.Base
    cons : Tok → Role → (List Tok × List Role) × (List Tok × List Role) → (List Tok × List Role) × (List Tok × List Role)
    cons x y ((a , b) , rest) = ((x ∷ a) , (y ∷ b)) , rest
  go (suc n) _ _ ts′ rs′ = ([] , []) , (ts′ , rs′)

rewriteImportMapT : (Str → Maybe Str) → (Str → Maybe Str) → Str → Str
rewriteImportMapT rw twin s with tokenize s
... | nothing = s
... | just ts with roles ts
...   | nothing = s
...   | just rs = emit (length ts) ts rs
  where
  replaced : (Str → Maybe Str) → Tok → Str
  replaced f t with f (Tok.value t)
  ... | just u  = stringify u
  ... | nothing = text t

  one : Tok → Role → Str
  one t keep        = text t
  one t asSpecifier = if urlLike (Tok.value t) then replaced rw t else text t
  one t asPrefix    = replaced rw t
  one t emptyObj    = toList "{}"
  one t drop        = []

  plain : List Tok → List Role → Str
  plain (t ∷ ts′) (r ∷ rs′) = one t r ++ plain ts′ rs′
  plain (t ∷ ts′) []        = text t ++ plain ts′ []
  plain [] _ = []

  -- The value's text from its tokens (the ':' and spaces before it dropped).
  valueText : List Tok → List Role → Str
  valueText (t ∷ ts′) (r ∷ rs′) = if isP ':' t ∨ isWS t then valueText ts′ rs′ else plain (t ∷ ts′) (r ∷ rs′)
  valueText _ _ = []

  emit : ℕ → List Tok → List Role → Str
  emit zero ts′ rs′ = plain ts′ rs′
  emit (suc n) (t ∷ ts′) (asPrefix ∷ rs′) with twin (Tok.value t) | spanValue (length ts′) ts′ rs′
  ... | nothing | _ = replaced rw t ++ emit n ts′ rs′
  ... | just k  | ((vt , vr) , (rt , rr)) =
    replaced rw t ++ plain vt vr ++ toList ", " ++ stringify k ++ toList ": " ++ valueText vt vr ++ emit n rt rr
  emit (suc n) (t ∷ ts′) (r ∷ rs′) = one t r ++ emit n ts′ rs′
  emit (suc n) (t ∷ ts′) [] = text t ++ emit n ts′ []
  emit (suc n) [] _ = []
