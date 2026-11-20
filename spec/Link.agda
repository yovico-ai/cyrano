{-# OPTIONS --safe #-}
-- The Link response header (RFC 8288), as Chromium reads it
-- (net/http/link_header_util; checked against Chromium: link-vs-chromium),
-- and as the proxy rewrites it (Go: urlrewrite.RewriteLinkHeader).
--
-- Reading: link-values are split at commas outside quoted strings and
-- outside <…>; a link-value is OWS "<" target ">" OWS, then parameters
-- after ";" (empty ones skipped), each a name, OWS, and optionally "="
-- OWS and a value — a quoted-string (backslash escapes) or the text to the
-- next ";" (trimmed). A link-value that does not read so (text before "<"
-- or after ">", a parameter with no name, an unterminated quoted-string,
-- a quoted-string followed by more than whitespace) is ignored by the
-- browser. Names are ASCII-case-insensitive; the first of a name counts;
-- rel is a list of space-separated types.
--
-- Rewriting, for every link-value that reads (the others are left as
-- written: the browser fetches nothing for them), edited where it stands,
-- every other character as the origin sent it — as the markup's <link>
-- (spec/Attrs.agda, htmlrewrite):
--   * the target is proxified against the response's URL;
--   * imagesrcset's value is rewritten as a srcset (spec/Srcset.agda);
--   * integrity is taken out (the proxied response is not the bytes it
--     names: a modulepreload with it is blocked — Shop Pay);
--   * crossorigin becomes use-credentials, as the <link>'s attribute does,
--     except on a font or fetch preload or prefetch (as=font, as=fetch),
--     which stays as the @font-face fetch or the page's own fetch() it
--     serves.
module Link where

open import Data.Bool.Base using (Bool; true; false; _∨_; _∧_; not; if_then_else_)
open import Data.Char.Base using (Char; toℕ; fromℕ)
open import Data.List.Base using (List; []; _∷_; _++_; reverse; map)
open import Data.Maybe.Base using (Maybe; just; nothing; fromMaybe)
open import Data.Product.Base using (_×_; _,_; proj₁; proj₂)
open import Data.String.Base using (String; toList)

open import Url using (Str; is; eqStr; lowerAscii; dropWhile)
open import Containment using (Dest)
import Attrs

ows : Char → Bool
ows c = is 32 c ∨ is 9 c

trimL trimR trim : Str → Str
trimL = dropWhile ows
trimR s = reverse (dropWhile ows (reverse s))
trim s = trimR (trimL s)

lowerS : Str → Str
lowerS = map lowerAscii

comma semi bslash : Char
comma  = fromℕ 44
semi   = fromℕ 59
bslash = fromℕ 92

------------------------------------------------------------------------
-- Splitting at a separator outside quoted strings (and, for commas,
-- outside <…>).

-- angle: whether <…> protects (link-values) or not (parameters).
splitTop : Bool → Char → Str → List Str
splitTop angle sep s = go false false false [] s
  where
  -- q: in a quoted string; e: after a backslash in one; a: in <…>
  go : Bool → Bool → Bool → Str → Str → List Str
  go q e a buf []       = reverse buf ∷ []
  go q e a buf (c ∷ cs) =
    if e then go q false a (c ∷ buf) cs
    else if q then (if is 92 c then go q true a (c ∷ buf) cs
                    else if is 34 c then go false false a (c ∷ buf) cs
                    else go q false a (c ∷ buf) cs)
    else if a then go q false (not (is 62 c)) (c ∷ buf) cs
    else if is 34 c then go true false a (c ∷ buf) cs
    else if angle ∧ is 60 c then go q false true (c ∷ buf) cs
    else if is (toℕ sep) c then reverse buf ∷ go false false false [] cs
    else go q false a (c ∷ buf) cs

------------------------------------------------------------------------
-- A parameter.

data Value : Set where
  noValue : Value
  token   : Str → Value          -- the text, trimmed
  quoted  : Str → Value          -- unescaped

data Param : Set where
  param : Str → Value → Param    -- name (lowercase), value

isTokenChar : Char → Bool
isTokenChar c = not (ows c ∨ is 61 c ∨ is 34 c ∨ is 59 c ∨ is 44 c)

-- A quoted-string from its opening quote on: its content unescaped, and
-- what follows the closing quote; nothing when it is not terminated.
unquoteStr : Str → Maybe (Str × Str)
unquoteStr s = go [] s
  where
  go : Str → Str → Maybe (Str × Str)
  go acc []             = nothing
  go acc (c ∷ [])       = if is 34 c then just (reverse acc , []) else nothing
  go acc (c ∷ d ∷ cs)   =
    if is 92 c then go (d ∷ acc) cs
    else if is 34 c then just (reverse acc , d ∷ cs)
    else go (c ∷ acc) (d ∷ cs)

-- Reading a parameter's text (between semicolons): nothing when the
-- link-value is invalid; just nothing when the parameter is empty.
readParam : Str → Maybe (Maybe Param)
readParam raw with trim raw
... | [] = just nothing
... | s with Url.break (λ c → not (isTokenChar c)) s
...   | [] , _ = nothing
...   | name , rest with trimL rest
...     | [] = just (just (param (lowerS name) noValue))
...     | c ∷ more =
  if is 61 c then valueOf (trimL more) else nothing
  where
  valueOf : Str → Maybe (Maybe Param)
  valueOf [] = just (just (param (lowerS name) (token [])))
  valueOf (q ∷ vs) =
    if is 34 q then fromQuoted (unquoteStr vs)
    else just (just (param (lowerS name) (token (trimR (q ∷ vs)))))
    where
    fromQuoted : Maybe (Str × Str) → Maybe (Maybe Param)
    fromQuoted nothing          = nothing
    fromQuoted (just (v , after)) with trim after
    ... | [] = just (just (param (lowerS name) (quoted v)))
    ... | _  = nothing

------------------------------------------------------------------------
-- A link-value: its target and parameters, or nothing.

data LinkValue : Set where
  link : Str → List Param → LinkValue

-- The pieces of a link-value's text: what precedes "<", the target as
-- written (between "<" and ">"), and the parameters' texts (each after a
-- ";").
data Pieces : Set where
  pieces : Str → Str → Str → List Str → Pieces   -- lead, target, before first ";", params

piecesOf : Str → Maybe Pieces
piecesOf s with Url.break (λ c → not (ows c)) s
... | lead , [] = nothing
... | lead , c ∷ rest =
  if is 60 c then afterLt (Url.break (is 62) rest) else nothing
  where
  afterLt : Str × Str → Maybe Pieces
  afterLt (t , [])      = nothing
  afterLt (t , _ ∷ more) = split (splitTop false semi more)
    where
    split : List Str → Maybe Pieces
    split []        = just (pieces lead t [] [])
    split (p₀ ∷ ps) = if eqStr (trim p₀) [] then just (pieces lead t p₀ ps) else nothing

params : List Str → Maybe (List Param)
params []       = just []
params (p ∷ ps) with readParam p | params ps
... | just (just x) | just xs = just (x ∷ xs)
... | just nothing  | just xs = just xs
... | _             | _       = nothing

readLink : Str → Maybe LinkValue
readLink s with piecesOf s
... | nothing                    = nothing
... | just (pieces _ t _ ps) with params ps
...   | just xs = just (link (trim t) xs)
...   | nothing = nothing

-- A parameter's value (the first of the name), as text.
valueOf : Str → List Param → Maybe Str
valueOf n []                    = nothing
valueOf n (param m v ∷ ps) = if eqStr n m then just (text v) else valueOf n ps
  where
  text : Value → Str
  text noValue    = []
  text (token t)  = t
  text (quoted t) = t

-- rel's link types (lowercase).
rels : List Param → List Str
rels ps with valueOf (toList "rel") ps
... | nothing = []
... | just v  = words (lowerS v)
  where
  words : Str → List Str
  words s = filterNE (Url.splitOn (λ c → is 32 c ∨ is 9 c ∨ is 10 c ∨ is 12 c ∨ is 13 c) s)
    where
    filterNE : List Str → List Str
    filterNE []        = []
    filterNE ([] ∷ ws) = filterNE ws
    filterNE (w ∷ ws)  = w ∷ filterNE ws

hasS : Str → List Str → Bool
hasS x []       = false
hasS x (y ∷ ys) = eqStr x y ∨ hasS x ys

------------------------------------------------------------------------
-- The link-values that read (for the check): each target, its as
-- (lowercase), its rel types.

links : Str → List (Str × Str × List Str)
links h = go (splitTop true comma h)
  where
  asOf : List Param → Str
  asOf ps with valueOf (toList "as") ps
  ... | just a  = lowerS a
  ... | nothing = []
  go : List Str → List (Str × Str × List Str)
  go [] = []
  go (v ∷ vs) with readLink v
  ... | just (link t ps) = (t , asOf ps , rels ps) ∷ go vs
  ... | nothing          = go vs

------------------------------------------------------------------------
-- Rewriting.

quoteS : Str → Str
quoteS s = toList "\"" ++ esc s ++ toList "\""
  where
  esc : Str → Str
  esc []       = []
  esc (c ∷ cs) = if is 34 c ∨ is 92 c then bslash ∷ c ∷ esc cs else c ∷ esc cs

joinWith : Char → List Str → Str
joinWith c []       = []
joinWith c (s ∷ []) = s
joinWith c (s ∷ ss) = s ++ c ∷ joinWith c ss

-- rw: a URL's proxified form, marked for what it is requested for
-- (nothing: kept); srcset: a srcset value's. A preload, modulepreload or
-- prefetch of a script or stylesheet is marked as the <link> is
-- (spec/Attrs.agda urlDest).
rewriteLinkValue : (Maybe Dest → Str → Maybe Str) → (Str → Str) → Str → Str
rewriteLinkValue rw srcset v with piecesOf v | readLink v
... | just (pieces lead t p₀ ps) | just (link target xs) =
  lead ++ toList "<" ++ newTarget (rw dest target) ++ toList ">" ++ p₀ ++ concatP ps
  where
  asOf : Maybe Str
  asOf with valueOf (toList "as") xs
  ... | just a  = just (lowerS a)
  ... | nothing = nothing
  dest : Maybe Dest
  dest = Attrs.urlDest Attrs.htmlNs (toList "link") (toList "href") (rels xs) asOf
  newTarget : Maybe Str → Str
  newTarget (just u) = u
  newTarget nothing  = t
  fontHint : Bool
  fontHint = (eqStr asLower (toList "font") ∨ eqStr asLower (toList "fetch"))
             ∧ (hasS (toList "preload") (rels xs) ∨ hasS (toList "prefetch") (rels xs))
    where
    asLower : Str
    asLower = lowerS (fromMaybe [] (valueOf (toList "as") xs))
  -- A parameter's text, edited: its name, and whatever precedes the value.
  edit : Str → Maybe Str
  edit raw with readParam raw
  ... | just (just (param n val)) =
    if eqStr n (toList "integrity") then nothing
    else if eqStr n (toList "crossorigin") ∧ not fontHint then just (nameEq raw ++ toList "use-credentials")
    else if eqStr n (toList "imagesrcset") then just (imagesrcset val)
    else just raw
    where
    -- the text up to and with "=", or the whole text and "=" when there is none
    nameEq : Str → Str
    nameEq r with Url.break (is 61) r
    ... | a , []    = a ++ toList "="
    ... | a , e ∷ _ = a ++ e ∷ []
    imagesrcset : Value → Str
    imagesrcset (quoted s) = nameEq raw ++ quoteS (srcset s)
    imagesrcset (token s)  = nameEq raw ++ srcset s
    imagesrcset noValue    = raw
  ... | _ = just raw
  concatP : List Str → Str
  concatP []       = []
  concatP (p ∷ ps) with edit p
  ... | just q  = semi ∷ q ++ concatP ps
  ... | nothing = concatP ps
... | _ | _ = v

-- The Link header, each link-value rewritten.
rewriteLink : (Maybe Dest → Str → Maybe Str) → (Str → Str) → Str → Str
rewriteLink rw srcset h =
  joinWith comma (map (rewriteLinkValue rw srcset) (splitTop true comma h))
