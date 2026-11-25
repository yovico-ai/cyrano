{-# OPTIONS --safe #-}
-- Permissions-Policy as Chromium reads it, and the proxy's translation of
-- it (Go: proxy/permissions.go). Checked against Chromium:
-- permissions-vs-chromium (document.featurePolicy, direct and translated).
--
-- Chromium (permissions_policy_parser): the field lines, joined, are a
-- Structured Fields dictionary (Sf.agda); one that does not parse is
-- ignored whole. Each feature's value — an item or an inner list — gives
-- its allowlist: the token or string * (every origin), the token self or
-- the string 'self' (the document's origin), a string naming an origin (a non-opaque one; a host
-- starting "*." matches its subdomains); every other member is dropped.
--
-- Through the proxy every document and frame has the proxy's origin, so an
-- allowlist cannot tell origins apart. The translation writes each feature
-- as * when its list has *, (self) when it has self or any origin, () when
-- neither. The document itself is then allowed what it is directly, except
-- a feature allowed only for other origins (the frames that use it — a
-- video player's fullscreen — would lose it otherwise; a known tell:
-- document.featurePolicy.allowsFeature reads true there).
module Permissions where

open import Data.Bool.Base using (Bool; true; false; _∨_; _∧_; not; if_then_else_)
open import Data.Char.Base using (Char)
open import Data.List.Base using (List; []; _∷_; _++_; map; reverse; concatMap)
open import Data.Maybe.Base using (Maybe; just; nothing)
open import Data.Product.Base using (_×_; _,_)
open import Data.String.Base using (toList)

open import Url using (Str; is; any; eqStr; parse; url; originText; scheme; auth; Parsed)
open import Sf using (Bare; token; string; other; Member; item; inner; sfDict; joinLines)

------------------------------------------------------------------------
-- An allowlist.

data Entry : Set where
  all  : Entry
  self : Entry
  orig : Str → Entry          -- an origin's serialization
  wild : Str → Str → Entry    -- "<scheme>://" and ".<host>[:port]" of a *. pattern

-- A string as an origin: the URL's origin, or a *. pattern.
originEntry : Str → Maybe Entry
originEntry s with parse nothing s
... | url u = if any (is 64) (auth u) then nothing else byHost (auth u)   -- with userinfo: no origin (Chromium)
  where
  byHost : Str → Maybe Entry
  -- (the URL parser writes a host's "*" as %2A, as Chromium does)
  byHost ('%' ∷ '2' ∷ 'A' ∷ '.' ∷ rest) = just (wild (originText (scheme u) []) ('.' ∷ rest))
  byHost a                  = just (orig (originText (scheme u) a))
... | _ = nothing

entries : Member → List Entry
entries (item b)   = one b
  where
  one : Bare → List Entry
  one (token t) = if eqStr t (toList "*") then all ∷ [] else if eqStr t (toList "self") then self ∷ [] else []
  -- Chromium turns the tokens into Feature-Policy's words (self → 'self')
  -- and reads every member as Feature-Policy does: "*" is every origin,
  -- "'self'" the document's, "'src'" and "'none'" nothing here, the rest
  -- an origin. So the string "*" is every origin, "'self'" is self, and
  -- "self" is no origin at all.
  one (string s) =
    if eqStr s (toList "*") then all ∷ [] else if eqStr s (toList "'self'") then self ∷ []
    else if eqStr s (toList "'src'") ∨ eqStr s (toList "'none'") then [] else byOrigin (originEntry s)
    where
    byOrigin : Maybe Entry → List Entry
    byOrigin (just e) = e ∷ []
    byOrigin nothing  = []
  one other = []
entries (inner bs) = concatMap (λ b → entries (item b)) bs

-- The policy: each declared feature's allowlist; nothing when ignored.
policy : List Str → Maybe (List (Str × List Entry))
policy lines with sfDict (joinLines lines)
... | just d  = just (map (λ { (k , m) → k , entries m }) d)
... | nothing = nothing

------------------------------------------------------------------------
-- What a document of origin `doc` is told (featurePolicy.allowsFeature):
-- for feature f, for an origin `o` (itself when o = doc).
-- defaultAll: the feature's default allowlist is * (else self).

startsWith : Str → Str → Bool
startsWith [] _ = true
startsWith (a ∷ as) (b ∷ bs) = Data.Char.Base._≈ᵇ_ a b ∧ startsWith as bs
  where import Data.Char.Base
startsWith _ [] = false

endsWith : Str → Str → Bool
endsWith suf s = startsWith (reverse suf) (reverse s)

matches : Str → Str → Entry → Bool
matches doc o all        = true
matches doc o self       = eqStr o doc
matches doc o (orig x)   = eqStr o x
matches doc o (wild p h) = startsWith p o ∧ endsWith h o

lookupF : Str → List (Str × List Entry) → Maybe (List Entry)
lookupF f [] = nothing
lookupF f ((k , es) ∷ rest) = if eqStr k f then just es else lookupF f rest

anyE : (Entry → Bool) → List Entry → Bool
anyE p []       = false
anyE p (e ∷ es) = p e ∨ anyE p es

allows : Bool → List Str → Str → Str → Str → Bool
allows defaultAll lines f doc o with policy lines
... | nothing = defaultAll ∨ eqStr o doc
... | just p with lookupF f p
...   | nothing = defaultAll ∨ eqStr o doc
...   | just es = anyE (matches doc o) es

------------------------------------------------------------------------
-- The translation.

render : List Entry → Str
render es =
  if anyE isAll es then toList "*"
  else if anyE (λ _ → true) es then toList "(self)"
  else toList "()"
  where
  isAll : Entry → Bool
  isAll all = true
  isAll _   = false

joinComma : List Str → Str
joinComma []       = []
joinComma (x ∷ []) = x
joinComma (x ∷ xs) = x ++ ',' ∷ ' ' ∷ joinComma xs

-- The header the browser is given (one field line), or the lines as they
-- were when they do not parse (ignored either way).
translate : List Str → List Str
translate lines with policy lines
... | just p  = joinComma (map (λ { (k , es) → k ++ '=' ∷ render es }) p) ∷ []
... | nothing = lines

------------------------------------------------------------------------
-- What the document reads (document.featurePolicy; permissions-vs-
-- chromium). Through the proxy the browser answers for the proxy's origin
-- and the translated header: `allowsFeature(f, location.origin)` read
-- false on every proxied page, `getAllowlistForFeature` named the proxy,
-- and a feature the policy gives only other origins read allowed. A
-- top-level document's runtime answers from the origin's policy, which
-- the server gives it parsed (table: each declared feature and its
-- entries' texts; nothing when there is none or it is ignored).

entryText : Entry → Str
entryText all        = toList "*"
entryText self       = toList "'self'"
entryText (orig x)   = x
entryText (wild p h) = p ++ '*' ∷ h

table : List Str → Maybe (List (Str × List Str))
table lines with policy lines
... | just p  = just (map (λ { (k , es) → k , map entryText es }) p)
... | nothing = nothing

-- getAllowlistForFeature (Chromium, measured): "*" alone when the list
-- has *; else the document's origin when it has self, then the origins,
-- then the *. patterns, each in the header's order; a feature not
-- declared: its default (* or the document's origin).
allowlist : Bool → List Str → Str → Str → List Str
allowlist defaultAll lines f doc with policy lines
... | nothing = byDefault
  where
  byDefault : List Str
  byDefault = if defaultAll then toList "*" ∷ [] else doc ∷ []
... | just p with lookupF f p
...   | nothing = if defaultAll then toList "*" ∷ [] else doc ∷ []
...   | just es =
  if anyE isAll es then toList "*" ∷ []
  else (if anyE isSelf es then doc ∷ [] else []) ++ origins es ++ wilds es
  where
  isAll : Entry → Bool
  isAll all = true
  isAll _   = false
  isSelf : Entry → Bool
  isSelf self = true
  isSelf _    = false
  origins : List Entry → List Str
  origins [] = []
  origins (orig x ∷ r) = x ∷ origins r
  origins (_ ∷ r) = origins r
  wilds : List Entry → List Str
  wilds [] = []
  wilds (wild p h ∷ r) = (p ++ '*' ∷ h) ∷ wilds r
  wilds (_ ∷ r) = wilds r
