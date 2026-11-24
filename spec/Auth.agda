{-# OPTIONS --safe #-}
------------------------------------------------------------------------
-- HTTP authentication through the proxy (round K: Basic credentials given
-- to one site were sent to every other site whose 401 named the same
-- realm, without a prompt — the browser keeps them by origin and realm,
-- and every proxied site is the proxy's origin).
--
-- A WWW-Authenticate field line that starts with a Basic challenge (RFC
-- 7617: "Basic", spaces, auth-params) has its first realm parameter named
-- for the response's site: realm="<site> <realm>" (a quoted-string) — the
-- browser's cache keeps each site's apart, and its dialog names the site.
-- A line it cannot read so (no "=", a token68, an unterminated string) is
-- left as sent; so is any other scheme (Digest: its response hash covers
-- the realm; still shared).
--
-- Chromium asks for credentials on a document's request (a top-level or
-- frame navigation), a same-origin request and a CORS one (a credentialed
-- fetch: measured, round K): a challenge on a cross-origin no-cors
-- subresource (another site's image) is shown to no one — the proxy does
-- not give it to the browser (promptable; the page reads the origin's
-- header, Crn-H).
------------------------------------------------------------------------

module Auth where

open import Data.Bool.Base using (Bool; true; false; _∨_; _∧_; not; if_then_else_)
open import Data.Char.Base using (Char)
open import Data.List.Base using (List; []; _∷_; _++_; reverse; length)
open import Data.Maybe.Base using (Maybe; just; nothing)
open import Data.Nat.Base using (ℕ; zero; suc)
open import Data.Product.Base using (_×_; _,_)
open import Data.String.Base using (toList)

open import Url using (Str; is; eqStr; lowerAscii)

isSp : Char → Bool
isSp c = is 32 c ∨ is 9 c

lowerStr : Str → Str
lowerStr []       = []
lowerStr (c ∷ cs) = lowerAscii c ∷ lowerStr cs

-- RFC 9110 tchar
tchar : Char → Bool
tchar c = not (isSp c ∨ is 34 c ∨ is 44 c ∨ is 59 c ∨ is 61 c ∨ is 40 c ∨ is 41 c ∨ is 60 c ∨ is 62 c ∨ is 64 c
               ∨ is 58 c ∨ is 92 c ∨ is 47 c ∨ is 91 c ∨ is 93 c ∨ is 63 c ∨ is 123 c ∨ is 125 c)

-- A quoted-string with "\" and """ escaped.
quoteStr : Str → Str
quoteStr s = '"' ∷ esc s
  where
  esc : Str → Str
  esc []       = '"' ∷ []
  esc (c ∷ cs) = if is 34 c ∨ is 92 c then '\\' ∷ c ∷ esc cs else c ∷ esc cs

private
  -- (fuel: the line's length)
  dropSp : Str → Str
  dropSp (c ∷ cs) = if isSp c then dropSp cs else c ∷ cs
  dropSp []       = []

  -- A token: (it, the rest).
  takeTok : Str → Str × Str
  takeTok [] = [] , []
  takeTok (c ∷ cs) with tchar c
  ... | true  with takeTok cs
  ...   | (t , r) = (c ∷ t) , r
  takeTok (c ∷ cs) | false = [] , c ∷ cs

  -- A quoted-string's value after its opening quote, and the rest after
  -- its closing one.
  qstr : ℕ → Str → Str → Maybe (Str × Str)
  qstr zero _ _ = nothing
  qstr (suc f) [] _ = nothing
  qstr (suc f) (c ∷ cs) acc =
    if is 34 c then just (reverse acc , cs)
    else if is 92 c then esc cs
    else qstr f cs (c ∷ acc)
    where
    esc : Str → Maybe (Str × Str)
    esc []       = nothing
    esc (d ∷ ds) = qstr f ds (d ∷ acc)

  -- A value (token or quoted-string): (its value, its text, the rest).
  value : ℕ → Str → Maybe (Str × Str × Str)
  value f ('"' ∷ cs) with qstr f cs []
  ... | just (v , r) = just (v , [] , r)
  ... | nothing      = nothing
  value f s with takeTok s
  ... | ([] , _) = nothing
  ... | (t , r)  = just (t , t , r)

-- The first realm parameter among the params of `s` (what follows "Basic"
-- and its spaces): (the text before its value, its value, the text after
-- it); nothing: not readable so, or no realm. acc: consumed, reversed.
realmIn : ℕ → Str → Str → Maybe (Str × Str × Str)
realmIn zero _ _ = nothing
realmIn (suc f) acc s = byName (spanSp s)
  where
  spanSp : Str → Str × Str
  spanSp (c ∷ cs) with isSp c
  ... | true with spanSp cs
  ...   | (w , r) = (c ∷ w) , r
  spanSp (c ∷ cs) | false = [] , c ∷ cs
  spanSp [] = [] , []
  rev : Str → Str → Str
  rev x a = reverse x ++ a
  afterEq : Str → Str → Str → Maybe (Str × Str × Str)
  afterEq name consumed r with spanSp r
  ... | (w2 , rest) with value f rest
  ...   | nothing = nothing
  ...   | just (v , txt , r3) with eqStr (lowerStr name) (toList "realm")
  ...     | true  = just (reverse (rev w2 consumed) , v , r3)
  ...     | false = more (rev (vtext rest r3) (rev w2 consumed)) r3
    where
    -- the value's own text: what `value` consumed
    vtext : Str → Str → Str
    vtext full rest′ = take′ (length full Data.Nat.Base.∸ length rest′) full
      where
      import Data.Nat.Base
      take′ : ℕ → Str → Str
      take′ zero _ = []
      take′ (suc n) [] = []
      take′ (suc n) (x ∷ xs) = x ∷ take′ n xs
    more : Str → Str → Maybe (Str × Str × Str)
    more c2 r4 with spanSp r4
    ... | (w4 , ',' ∷ r5) = realmIn f (',' ∷ rev w4 c2) r5
    ... | _ = nothing
  byName : Str × Str → Maybe (Str × Str × Str)
  byName (w , r) with takeTok r
  ... | ([] , _) = nothing
  ... | (name , r1) with spanSp r1
  ...   | (w1 , '=' ∷ r2) = afterEq name ('=' ∷ rev w1 (rev name (rev w acc))) r2
  ...   | _ = nothing

-- A WWW-Authenticate field line, with a Basic challenge's realm named for
-- `site`.
rewriteChallenge : Str → Str → Str
rewriteChallenge site line with takeTok line
... | (scheme , r) with eqStr (lowerStr scheme) (toList "basic")
...   | false = line
...   | true  = byRest r
  where
  byRest : Str → Str
  byRest (c ∷ cs) with isSp c
  ... | false = line
  ... | true with realmIn (length line) (reverse (scheme ++ c ∷ [])) cs
  ...   | just (before , v , after) = before ++ quoteStr (site ++ ' ' ∷ v) ++ after
  ...   | nothing = line
  byRest [] = line

-- Whether the browser would show a challenge on this response: a
-- navigation (document, iframe, frame…), a same-origin or a CORS request.
promptable : Bool → Bool → Bool → Bool
promptable navigation sameOrigin cors = navigation ∨ sameOrigin ∨ cors
