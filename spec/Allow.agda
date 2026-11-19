{-# OPTIONS --safe #-}
-- An iframe's allow attribute (the container policy) as Chromium reads
-- it, and its translation for the proxy (Go: htmlrewrite, urlrewrite
-- RewriteAllow; TS: url/allow.ts). Checked against Chromium:
-- allow-vs-chromium (document.featurePolicy inside the frame, direct and
-- translated).
--
-- The attribute is directives separated by ";", each a feature name and
-- an allowlist separated by ASCII whitespace: * , 'self' (the embedding
-- document's origin), 'src' (the origin of the frame's src), 'none', and
-- origins; no allowlist means 'src'.
--
-- Through the proxy the frame's src is a proxy URL, so an origin in the
-- attribute names nothing there and the frame loses the feature. Each
-- origin is written as 'src' (the frame's own origin on the proxy). Page
-- code reads the attribute as written (read-back).
module Allow where

open import Data.Bool.Base using (Bool; true; false; _∨_; _∧_; not; if_then_else_)
open import Data.Char.Base using (Char)
open import Data.List.Base using (List; []; _∷_; _++_; map; reverse)
open import Data.Maybe.Base using (Maybe; just; nothing)
open import Data.Product.Base using (_×_; _,_)
open import Data.String.Base using (toList)

open import Url using (Str; is; eqStr; eqLower; lowerAscii; splitOn; isEmpty)
open import Permissions using (Entry; all; self; orig; wild; originEntry; matches)
import Permissions

asciiWS : Char → Bool
asciiWS c = is 32 c ∨ is 9 c ∨ is 10 c ∨ is 12 c ∨ is 13 c

words : Str → List Str
words s = dropEmpty (splitOn asciiWS s)
  where
  dropEmpty : List Str → List Str
  dropEmpty []       = []
  dropEmpty (w ∷ ws) = if isEmpty w then dropEmpty ws else w ∷ dropEmpty ws

data Item : Set where
  any srcI selfI none : Item
  origin : Entry → Item
  junk : Item

item : Str → Item
item w =
  if eqStr w (toList "*") then any
  else if eqLower w (toList "'self'") then selfI
  else if eqLower w (toList "'src'") then srcI
  else if eqLower w (toList "'none'") then none
  else byOrigin (originEntry w)
  where
  byOrigin : Maybe Entry → Item
  byOrigin (just e) = origin e
  byOrigin nothing  = junk

-- The directives: (feature, items), a feature's first directive kept; a
-- feature with no allowlist gets the default item ('src' in an allow
-- attribute, 'self' in a Feature-Policy header).
directivesWith : Item → Str → List (Str × List Item)
directivesWith dflt s = firsts (dir (splitOn (is 59) s))
  where
  dir : List Str → List (Str × List Item)
  dir [] = []
  dir (d ∷ ds) with words d
  ... | []       = dir ds
  ... | f ∷ []   = (f , dflt ∷ []) ∷ dir ds          -- names as written: case matters
  ... | f ∷ i ∷ is = (f , map item (i ∷ is)) ∷ dir ds
  known : Str → List (Str × List Item) → Bool
  known f [] = false
  known f ((g , _) ∷ rest) = eqStr f g ∨ known f rest
  firstsAcc : List (Str × List Item) → List (Str × List Item) → List (Str × List Item)
  firstsAcc seen [] = reverse seen
  firstsAcc seen ((f , is) ∷ rest) = if known f seen then firstsAcc seen rest else firstsAcc ((f , is) ∷ seen) rest
  firsts : List (Str × List Item) → List (Str × List Item)
  firsts = firstsAcc []

directives : Str → List (Str × List Item)
directives = directivesWith srcI

------------------------------------------------------------------------
-- The frame's view: whether a frame of origin `frame`, whose src had
-- origin `src`, in a document of origin `parent` (with no
-- Permissions-Policy) is allowed feature f. defaultAll: the feature's
-- default allowlist is *.

-- In a header 'src' matches no origin: the src origin given is this.
noSrc : Str
noSrc = toList "\0src"

itemMatches : Str → Str → Str → Item → Bool
itemMatches parent src frame any        = true
itemMatches parent src frame selfI      = eqStr frame parent
itemMatches parent src frame srcI       = eqStr frame src
itemMatches parent src frame none       = false
itemMatches parent src frame (origin e) = matches parent frame e
itemMatches parent src frame junk       = false

anyI : (Item → Bool) → List Item → Bool
anyI p []       = false
anyI p (i ∷ is) = p i ∨ anyI p is

lookupD : Str → List (Str × List Item) → Maybe (List Item)
lookupD f [] = nothing
lookupD f ((g , is) ∷ rest) = if eqStr f g then just is else lookupD f rest

frameAllows : Bool → Str → Str → Str → Str → Str → Bool
frameAllows defaultAll attr f parent src frame with lookupD f (directives attr)
... | just is = anyI (itemMatches parent src frame) is
... | nothing = defaultAll ∨ eqStr frame parent

------------------------------------------------------------------------
-- The translation: each word of a directive's allowlist that names an
-- origin becomes 'src'; every other byte is kept.

-- A Feature-Policy reads no *. pattern (Permissions-Policy does).
noWild : Item → Item
noWild (origin (wild _ _)) = junk
noWild i                   = i

rewriteWordTo : (Item → Item) → Str → Str → Str
rewriteWordTo adj to w with adj (item w)
... | origin _ = to
... | _        = w

-- Words are rewritten in place: the runs of whitespace between them, and
-- the feature names, as written.
rewriteWordsTo : (Item → Item) → Str → Str → Str
rewriteWordsTo adj to s = joinSemi (map dirText (splitOn (is 59) s))
  where
  rewriteWord : Str → Str
  rewriteWord = rewriteWordTo adj to
  joinSemi : List Str → Str
  joinSemi []       = []
  joinSemi (x ∷ []) = x
  joinSemi (x ∷ xs) = x ++ ';' ∷ joinSemi xs
  -- Walk a directive: whitespace kept, the first word kept, later words rewritten.
  walk : Bool → Str → Str → Str
  walk seenName acc []       = flush seenName acc
    where
    flush : Bool → Str → Str
    flush _ []    = []
    flush false w = reverse w
    flush true  w = rewriteWord (reverse w)
  walk seenName acc (c ∷ cs) =
    if asciiWS c then flushed ++ c ∷ walk (seenName ∨ not (isEmpty acc)) [] cs
    else walk seenName (c ∷ acc) cs
    where
    flushed : Str
    flushed = if isEmpty acc then [] else (if seenName then rewriteWord (reverse acc) else reverse acc)
  dirText : Str → Str
  dirText d = walk false [] d

rewriteAllow : Str → Str
rewriteAllow = rewriteWordsTo (λ i → i) (toList "'src'")

------------------------------------------------------------------------
-- The Feature-Policy header (the older syntax of Permissions-Policy, still
-- read by Chromium): the attribute's directives, a feature with no
-- allowlist meaning 'self'; 'src' names nothing here, nor does a *.
-- pattern (Permissions-Policy's only). A feature the
-- Permissions-Policy names is decided by it alone (the two headers
-- together: Chromium; checked in feature-policy-vs-chromium). The proxy
-- writes each origin 'self' — every document there has the proxy's origin
-- — and keeps every other byte: an unknown word stays one Chromium ignores.

fpAllows : Bool → List Str → Str → Str → Str → Str → Bool
fpAllows defaultAll ppLines fp f doc o with Permissions.policy ppLines
... | just p with Permissions.lookupF f p
...   | just es = Permissions.anyE (Permissions.matches doc o) es
...   | nothing = byFP
  where
  byFP : Bool
  byFP with lookupD f (directivesWith selfI fp)
  ... | just is = anyI (λ i → itemMatches doc noSrc o (noWild i)) is
  ... | nothing = defaultAll ∨ eqStr o doc
fpAllows defaultAll ppLines fp f doc o | nothing with lookupD f (directivesWith selfI fp)
... | just is = anyI (λ i → itemMatches doc noSrc o (noWild i)) is
... | nothing = defaultAll ∨ eqStr o doc

rewriteFeaturePolicy : Str → Str
rewriteFeaturePolicy = rewriteWordsTo noWild (toList "'self'")
