{-# OPTIONS --safe #-}
-- The script URLs of a V8 stack trace, innermost first (TS:
-- native/error-stack.ts stackUrls; the runtime reads them off a stack it
-- makes itself, to find which window's code is calling).
--
-- V8 writes a frame as "    at " and then either a bare location (after
-- "async " in an async frame) or "NAME (LOCATION)" — NAME as the function is named, any text ("new f",
-- "async f", "Object.a(b", "f [as g]"). A location is
--   * URL:LINE:COL, or URL with no position — the URL as the script was
--     loaded, unescaped (it may hold "(", ")" or ":1:2" in its query);
--   * eval at NAME (LOCATION)[, POSITION] — code from eval or Function:
--     the URL is that of the location it was evaluated at (nested evals:
--     the outermost script; an inner one has no position);
--   * anything else (<anonymous>, native, index 0, …): no URL.
-- NAME's "(" is told from the location's by what follows: the location
-- starts with "eval at " or a scheme the runtime looks for (http, https,
-- blob, file). Only those URLs are listed.
--
-- Checked against V8's own reading (stack-vs-chromium): over scripts at
-- URLs with parentheses, colons and odd characters, functions with odd
-- names, eval, Function, async and constructor frames, the URLs read off
-- the formatted stack are the CallSites' file names (an eval frame's: the
-- script it was evaluated in).
module Stack where

open import Data.Bool.Base using (Bool; true; false; _∨_; _∧_; not; if_then_else_)
open import Data.Char.Base using (Char; toℕ)
open import Data.List.Base using (List; []; _∷_; _++_; reverse; length; concatMap)
open import Data.Maybe.Base using (Maybe; just; nothing)
open import Data.Nat.Base using (ℕ; zero; suc; _≡ᵇ_)
open import Data.String.Base using (toList)

open import Url using (Str; eqStr; is; isDigit; splitOn)

stripPrefix : Str → Str → Maybe Str
stripPrefix [] s = just s
stripPrefix (p ∷ ps) [] = nothing
stripPrefix (p ∷ ps) (c ∷ cs) = if toℕ p ≡ᵇ toℕ c then stripPrefix ps cs else nothing

has : Str → Str → Bool
has p s with stripPrefix p s
... | just _  = true
... | nothing = false

schemeOK : Str → Bool
schemeOK s = has (toList "http:") s ∨ has (toList "https:") s ∨ has (toList "blob:") s ∨ has (toList "file:") s

locStart : Str → Bool
locStart s = has (toList "eval at ") s ∨ schemeOK s

-- The text after the first " (" that a location follows.
openAt : Str → Maybe Str
openAt [] = nothing
openAt (c ∷ []) = nothing
openAt (c ∷ d ∷ cs) = if is 32 c ∧ is 40 d ∧ locStart cs then just cs else openAt (d ∷ cs)

dropLast : Str → Str
dropLast s = reverse (dropFirst (reverse s))
  where
  dropFirst : Str → Str
  dropFirst [] = []
  dropFirst (_ ∷ cs) = cs

endsParen : Str → Bool
endsParen s with reverse s
... | c ∷ _ = is 41 c
... | []    = false

-- A frame's location, from the text after "at ".
location : Str → Str
location rest with endsParen rest | openAt rest
... | true | just loc = dropLast loc
... | _    | _        with stripPrefix (toList "async ") rest
...   | just r  = if locStart r then r else rest
...   | nothing = rest

-- URL:LINE:COL → URL; a URL without a position as it is.
stripPos : Str → Str
stripPos u = reverse (fromRev (reverse u))
  where
  digits : Str → Maybe Str   -- one or more digits, then the rest
  digits (c ∷ cs) = if isDigit c then just (more cs) else nothing
    where
    more : Str → Str
    more [] = []
    more (d ∷ ds) = if isDigit d then more ds else d ∷ ds
  digits [] = nothing
  colon : Maybe Str → Maybe Str
  colon (just (c ∷ cs)) = if is 58 c then just cs else nothing
  colon _ = nothing
  bind : Maybe Str → (Str → Maybe Str) → Maybe Str
  bind (just x) f = f x
  bind nothing  f = nothing
  fromRev : Str → Str
  fromRev r with colon (bind (colon (digits r)) digits)
  ... | just rest = rest
  ... | nothing   = r

-- The text before the last "), " (an eval location's NAME (LOCATION)).
beforeLastClose : Str → Maybe Str
beforeLastClose s = go (reverse s)
  where
  go : Str → Maybe Str
  go (a ∷ b ∷ c ∷ cs) = if is 32 a ∧ is 44 b ∧ is 41 c then just (reverse cs) else go (b ∷ c ∷ cs)
  go _ = nothing

urlOf : ℕ → Str → Maybe Str
urlOf zero _ = nothing
urlOf (suc n) loc with stripPrefix (toList "eval at ") loc
... | just r with (if endsParen r then just (dropLast r) else beforeLastClose r)
...   | just named with openAt named
...     | just inner = urlOf n inner
...     | nothing    = nothing
urlOf (suc n) loc | just r | nothing = nothing
urlOf (suc n) loc | nothing = if schemeOK loc then just (stripPos loc) else nothing

dropSpaces : Str → Str
dropSpaces [] = []
dropSpaces (c ∷ cs) = if is 32 c then dropSpaces cs else c ∷ cs

lineUrl : Str → List Str
lineUrl l with stripPrefix (toList "at ") (dropSpaces l)
... | nothing   = []
... | just rest with urlOf (length rest) (location rest)
...   | just u  = u ∷ []
...   | nothing = []

stackUrls : Str → List Str
stackUrls st = concatMap lineUrl (splitOn (is 10) st)

------------------------------------------------------------------------
-- A function the page makes with `new Function` is made by the runtime's
-- stand-in, so V8 would name the stand-in as its eval origin ("eval at
-- make (…/rewriter.js:…)": Kasada reads it). The runtime tags its source
-- with a //# sourceURL of its own and records the eval origin V8 writes
-- natively: the calling frame's function name ("<anonymous>" without one)
-- and the call's location — URL:LINE:COL (the original URL), or, when the
-- caller is itself eval code, that code's own eval origin.
-- (The caller's own frame, when it is such code's top level, V8 calls
-- "eval"; its eval origin names it "<anonymous>".)
-- V8 writes a tagged script's frames with TAG:LINE:COL where the native
-- text has "eval at ORIGIN, <anonymous>:LINE:COL", and an eval origin of
-- code made inside it with a bare TAG where natively ORIGIN stands
-- (checked: function-stack-vs-chromium).

evalOrigin : Str → Str → Str
evalOrigin name loc = toList "eval at " ++ (if isEmptyS name then toList "<anonymous>" else name) ++ toList " (" ++ loc ++ toList ")"
  where
  isEmptyS : Str → Bool
  isEmptyS [] = true
  isEmptyS (_ ∷ _) = false

-- A frame's text with TAG put back as V8 writes the native one.
untag : Str → Str → Str → Str
untag tag origin s = go (suc (length s)) s
  where
  rep : Str
  rep = origin ++ toList ", <anonymous>"
  go : ℕ → Str → Str
  go zero s = s
  go (suc f) [] = []
  go (suc f) (c ∷ cs) with stripPrefix tag (c ∷ cs)
  ... | just rest@(d ∷ _) = (if is 58 d then rep else origin) ++ go f rest
  ... | just []           = origin
  ... | nothing           = c ∷ go f cs
