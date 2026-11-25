{-# OPTIONS --safe #-}
------------------------------------------------------------------------
-- XPath on URL attributes (TS: patches/xpath.ts; Chromium: xpath-vs-
-- chromium). An element holds its URL attributes proxified, and XPath
-- compares what the element holds: `//a[@href="/p?x"]` found nothing
-- through the proxy where natively it finds the link, and
-- `string(@href)` gave the proxified URL (round J). As for CSS selectors
-- (Selectors.agda), the expression the page gives is widened: a comparison
-- of a URL attribute with a string literal — `@href = "v"`, `"v" = @src`,
-- and `!=` — also admits the value as the element holds it, unmarked and
-- with the marks an element's URL can carry: for `=` a disjunction
-- `(@a = "v" or @a = "P" or …)`, for `!=` the conjunction. A value the
-- rewriting leaves alone (data:, #frag, …) or that does not rewrite is
-- left as written; so is a proxified form holding a '"' (no XPath 1.0
-- literal could carry it next to the page's quote). A string result that
-- is a proxified URL reads unwrapped (the runtime's own step).
------------------------------------------------------------------------

module XPath where

open import Data.Bool.Base using (Bool; true; false; _∧_; _∨_; not; if_then_else_)
open import Data.Char.Base using (Char)
open import Data.List.Base using (List; []; _∷_; _++_; map)
open import Data.Maybe.Base using (Maybe; just; nothing)
open import Data.Nat.Base using (ℕ; zero; suc)
open import Data.Product.Base using (_×_; _,_)
open import Data.String.Base using (toList)

open import Url using (Str; is; isAlpha; isDigit; eqStr; any)
open import Selectors using (RW; urlAttr; skipped; withMarks)

data Tok : Set where
  lit   : Char → Str → Tok     -- a string literal: its quote, its text
  attr  : Str → Tok            -- @name
  op    : Str → Tok            -- = or !=
  ws    : Str → Tok
  other : Char → Tok

isWS : Char → Bool
isWS c = is 32 c ∨ is 9 c ∨ is 10 c ∨ is 13 c

nameChar : Char → Bool
nameChar c = isAlpha c ∨ isDigit c ∨ is 45 c ∨ is 95 c ∨ is 46 c ∨ is 58 c

-- Spans and quoted runs.
span : (Char → Bool) → Str → Str × Str
span p [] = [] , []
span p (c ∷ cs) = if p c then cons c (span p cs) else ([] , (c ∷ cs))
  where
  cons : Char → Str × Str → Str × Str
  cons x (a , b) = (x ∷ a) , b

upTo : Char → Str → Maybe (Str × Str)
upTo q [] = nothing
upTo q (c ∷ cs) = if eqStr (c ∷ []) (q ∷ []) then just ([] , cs) else consM c (upTo q cs)
  where
  consM : Char → Maybe (Str × Str) → Maybe (Str × Str)
  consM x (just (a , b)) = just ((x ∷ a) , b)
  consM x nothing = nothing

len : {A : Set} → List A → ℕ
len [] = 0
len (_ ∷ xs) = suc (len xs)

-- The tokens of an expression (fuel: its length).
lexGo : ℕ → Str → List Tok
lexGo zero s = map other s
lexGo (suc n) [] = []
lexGo (suc n) (c ∷ cs) =
  if is 34 c ∨ is 39 c then quoted (upTo c cs)
  else if is 64 c then named (span nameChar cs)
  else if is 33 c then bang cs
  else if is 61 c then op ('=' ∷ []) ∷ lexGo n cs
  else if isWS c then spaced (span isWS (c ∷ cs))
  else other c ∷ lexGo n cs
  where
  quoted : Maybe (Str × Str) → List Tok
  quoted (just (v , rest)) = lit c v ∷ lexGo n rest
  quoted nothing = map other (c ∷ cs)
  named : Str × Str → List Tok
  named ([] , rest) = other c ∷ lexGo n rest
  named ((x ∷ xs) , rest) = attr (x ∷ xs) ∷ lexGo n rest
  bang : Str → List Tok
  bang ('=' ∷ rest) = op ('!' ∷ '=' ∷ []) ∷ lexGo n rest
  bang rest = other c ∷ lexGo n rest
  spaced : Str × Str → List Tok
  spaced (w , rest) = ws w ∷ lexGo n rest

lexWith : Str → List Tok
lexWith s = lexGo (len s) s

untok : List Tok → Str
untok [] = []
untok (lit q v ∷ ts) = q ∷ v ++ q ∷ untok ts
untok (attr n ∷ ts) = '@' ∷ n ++ untok ts
untok (op o ∷ ts) = o ++ untok ts
untok (ws w ∷ ts) = w ++ untok ts
untok (other c ∷ ts) = c ∷ untok ts

-- The widened comparison, or nothing to leave it as written.
widenCmp : RW → Str → Str → Char → Str → Maybe Str
widenCmp rw name o q v =
  if not (urlAttr name) ∨ skipped v then nothing else byRw (rw v)
  where
  isEq : Bool
  isEq = eqStr o ('=' ∷ [])
  join : Str
  join = if isEq then toList " or " else toList " and "
  one : Char → Str → Str
  one qq x = '@' ∷ name ++ o ++ qq ∷ x ++ qq ∷ []
  rest : List Str → Str
  rest [] = []
  rest (x ∷ xs) = join ++ one '"' x ++ rest xs
  byRw : Maybe Str → Maybe Str
  byRw nothing = nothing
  byRw (just p) =
    if eqStr p v then nothing
    else if anyQuote (withMarks p) then nothing
    else just ('(' ∷ one q v ++ rest (withMarks p) ++ ')' ∷ [])
    where
    anyQuote : List Str → Bool
    anyQuote [] = false
    anyQuote (x ∷ xs) = any (is 34) x ∨ anyQuote xs

-- Spaces between the parts of a comparison.
gap : List Tok → Str × List Tok
gap (ws w ∷ ts) = w , ts
gap ts = [] , ts

widenToks : ℕ → RW → List Tok → List Tok
widenToks zero rw ts = ts
widenToks (suc k) rw [] = []
widenToks (suc k) rw (attr n ∷ ts) = afterA (gap ts)
  where
  afterO : Str → Str → Str × List Tok → List Tok
  afterO w1 o (w2 , (lit q v ∷ ts3)) = choose (widenCmp rw n o q v)
    where
    choose : Maybe Str → List Tok
    choose (just x) = map other x ++ widenToks k rw ts3
    choose nothing = attr n ∷ ws w1 ∷ op o ∷ ws w2 ∷ lit q v ∷ widenToks k rw ts3
  afterO w1 o (w2 , ts3) = attr n ∷ ws w1 ∷ op o ∷ ws w2 ∷ widenToks k rw ts3
  afterA : Str × List Tok → List Tok
  afterA (w1 , (op o ∷ ts2)) = afterO w1 o (gap ts2)
  afterA (w1 , ts2) = attr n ∷ ws w1 ∷ widenToks k rw ts2
widenToks (suc k) rw (lit q v ∷ ts) = afterL (gap ts)
  where
  afterO : Str → Str → Str × List Tok → List Tok
  afterO w1 o (w2 , (attr n ∷ ts3)) = choose (widenCmp rw n o q v)
    where
    choose : Maybe Str → List Tok
    choose (just x) = map other x ++ widenToks k rw ts3
    choose nothing = lit q v ∷ ws w1 ∷ op o ∷ ws w2 ∷ attr n ∷ widenToks k rw ts3
  afterO w1 o (w2 , ts3) = lit q v ∷ ws w1 ∷ op o ∷ ws w2 ∷ widenToks k rw ts3
  afterL : Str × List Tok → List Tok
  afterL (w1 , (op o ∷ ts2)) = afterO w1 o (gap ts2)
  afterL (w1 , ts2) = lit q v ∷ ws w1 ∷ widenToks k rw ts2
widenToks (suc k) rw (t ∷ ts) = t ∷ widenToks k rw ts

widenXPath : RW → Str → Str
widenXPath rw s = untok (widenToks (len (lexWith s)) rw (lexWith s))
