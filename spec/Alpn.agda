{-# OPTIONS --safe #-}
-- Which protocol Chrome speaks to an https origin, re-enacted by the
-- proxy's upstream client (Go: internal/upstream, h3.go).
--
-- Measured 2026-11-26, Chrome 139 direct, a fresh profile: to a Cloudflare
-- zone whose DNS HTTPS record says alpn="h3,h2" the first navigation goes
-- over HTTP/3 (nextHopProtocol h3, 200); the same Chrome with QUIC off goes
-- over HTTP/2 and is challenged ("Just a moment…", 403: codepen.io,
-- napaonline.com, fivebelow.com, findagrave.com). The proxy spoke h2 to
-- every origin ("a real Chrome's first contact is h2" — not since Chrome
-- reads HTTPS records), so 17 such zones refused every proxied page.
--
--   * HTTP/3 when the origin is https and not marked broken, and either
--     the host's DNS HTTPS record (RFC 9460, the service binding for its
--     own name, priority > 0) lists "h3" in alpn, or an unexpired Alt-Svc
--     entry the origin sent offers h3 for the same host and port.
--     Alternatives naming another host or port are not taken (Chrome may
--     take them; the proxy does not, and stays on h2: never a new
--     destination). Draft ids (h3-29, …) are not h3.
--   * Alt-Svc (RFC 7838) as Chrome reads it: "clear" forgets the origin's
--     entries; else a comma list of protocol-id "=" quoted authority, then
--     ";" parameters, of which ma (seconds, default 86400) is kept. An
--     entry that does not read is skipped, the others kept. A response's
--     header replaces what the origin had (it is the origin's whole list).
--   * A QUIC connection that cannot be made (no UDP path, handshake
--     failure) falls back to TCP and marks the origin broken for 5 minutes
--     (Chrome: 5 min, doubling on each repeat — the doubling is outside the
--     model); h2 then.
--   * The connection is raced, never the request: a request is sent once,
--     over the connection that was made (a library that sent it over both
--     sent a POST twice). Not in this model (Go tests it).
module Alpn where

open import Data.Bool.Base using (Bool; true; false; _∨_; _∧_; not; if_then_else_)
open import Data.Char.Base using (Char)
open import Data.List.Base using (List; []; _∷_; _++_; map; filter)
open import Data.Maybe.Base using (Maybe; just; nothing)
open import Data.Nat.Base using (ℕ; _+_; _*_; _<ᵇ_)
open import Data.Product.Base using (_×_; _,_)
open import Data.String.Base using (toList)
open import Relation.Binary.PropositionalEquality using (_≡_; refl)

open import Url using (Str; is; isDigit; lowerAscii; eqStr; splitOn; splitLast; break; dropWhile; digitsValue)
import Url

------------------------------------------------------------------------
-- Text.

ows : Char → Bool
ows c = is 32 c ∨ is 9 c

trim : Str → Str
trim s = Data.List.Base.reverse (dropWhile ows (Data.List.Base.reverse (dropWhile ows s)))

lower : Str → Str
lower = map lowerAscii

-- A quoted string's content (backslash escapes kept as the next char);
-- nothing when it is not one.
unquoted : Str → Maybe Str
unquoted ('"' ∷ r) = go r
  where
  go : Str → Maybe Str
  go []              = nothing
  go ('"' ∷ [])      = just []
  go ('"' ∷ _ ∷ _)   = nothing
  go ('\\' ∷ c ∷ cs) with go cs
  ... | just t  = just (c ∷ t)
  ... | nothing = nothing
  go (c ∷ cs) with go cs
  ... | just t  = just (c ∷ t)
  ... | nothing = nothing
unquoted _ = nothing

natOf : Str → Maybe ℕ
natOf [] = nothing
natOf s  = if Url.all isDigit s then just (digitsValue s) else nothing

------------------------------------------------------------------------
-- Alt-Svc.

-- An offer: protocol id, host ("" the origin's own), port, max age (s).
record Offer : Set where
  constructor offer
  field
    proto : Str
    host  : Str
    port  : ℕ
    maxAge : ℕ
open Offer public

data AltSvc : Set where
  clear   : AltSvc
  offers  : List Offer → AltSvc

defaultMaxAge : ℕ
defaultMaxAge = 86400

-- "host:port" or ":port".
authority : Str → Maybe (Str × ℕ)
authority s with splitLast (is 58) s
... | nothing = nothing
... | just (h , p) with natOf p
...   | just n  = just (lower h , n)
...   | nothing = nothing

-- ma=… among the parameters; the default without one (an unreadable ma
-- leaves the default, as Chrome).
maxAgeOf : List Str → ℕ
maxAgeOf [] = defaultMaxAge
maxAgeOf (p ∷ ps) = param (break (is 61) (trim p)) (maxAgeOf ps)
  where
  param : Str × Str → ℕ → ℕ
  param (k , ('=' ∷ v)) rest = if eqStr (lower (trim k)) (toList "ma") then orElse (natOf (trim v)) rest else rest
    where
    orElse : Maybe ℕ → ℕ → ℕ
    orElse (just n) _ = n
    orElse nothing  d = d
  param _ rest = rest

offerOf : Str → List Str → Str × Str → Maybe Offer
offerOf _ params (pid , ('=' ∷ q)) = fromQuoted (unquoted (trim q))
  where
  fromAuthority : Maybe (Str × ℕ) → Maybe Offer
  fromAuthority (just (h , n)) = just (offer (trim pid) h n (maxAgeOf params))
  fromAuthority nothing        = nothing
  fromQuoted : Maybe Str → Maybe Offer
  fromQuoted (just au) = fromAuthority (authority au)
  fromQuoted nothing   = nothing
offerOf _ _ _ = nothing

alternative : Str → Maybe Offer
alternative a = first (splitOn (is 59) a)
  where
  first : List Str → Maybe Offer
  first [] = nothing
  first (f ∷ params) = offerOf f params (break (is 61) (trim f))

catMaybes : {A : Set} → List (Maybe A) → List A
catMaybes [] = []
catMaybes (just x ∷ xs) = x ∷ catMaybes xs
catMaybes (nothing ∷ xs) = catMaybes xs

-- Commas inside a quoted authority are not separators.
splitList : Str → List Str
splitList = go false []
  where
  go : Bool → Str → Str → List Str
  go q acc [] = Data.List.Base.reverse acc ∷ []
  go q acc ('"' ∷ cs) = go (not q) ('"' ∷ acc) cs
  go false acc (',' ∷ cs) = Data.List.Base.reverse acc ∷ go false [] cs
  go q acc (c ∷ cs) = go q (c ∷ acc) cs

readAltSvc : Str → AltSvc
readAltSvc v = if eqStr (lower (trim v)) (toList "clear") then clear
               else offers (catMaybes (map alternative (splitList v)))

-- The offers that make the origin HTTP/3: h3, the origin's own host (an
-- empty host, or the host named) and port.
h3Here : Str → ℕ → List Offer → Bool
h3Here h n [] = false
h3Here h n (o ∷ os) =
  (eqStr (proto o) (toList "h3") ∧ (eqStr (host o) [] ∨ eqStr (host o) (lower h)) ∧ eqN (port o) n)
  ∨ h3Here h n os
  where
  eqN : ℕ → ℕ → Bool
  eqN a b = not (a <ᵇ b) ∧ not (b <ᵇ a)

------------------------------------------------------------------------
-- The choice.

data Proto : Set where
  h2 h3 : Proto

-- scheme, host, port, the HTTPS record's alpn ids (nothing: no record),
-- the origin's Alt-Svc offers still unexpired, broken.
protocol : Str → Str → ℕ → Maybe (List Str) → List Offer → Bool → Proto
protocol scheme h n rr alt broken =
  if eqStr scheme (toList "https") ∧ not broken ∧ (fromRecord rr ∨ h3Here h n alt) then h3 else h2
  where
  hasH3 : List Str → Bool
  hasH3 [] = false
  hasH3 (a ∷ as) = eqStr a (toList "h3") ∨ hasH3 as
  fromRecord : Maybe (List Str) → Bool
  fromRecord (just ids) = hasH3 ids
  fromRecord nothing    = false

brokenFor : ℕ
brokenFor = 5 * 60

------------------------------------------------------------------------
-- Examples.

private
  s = toList

  ex1 : protocol (s "https") (s "codepen.io") 443 (just (s "h3" ∷ s "h2" ∷ [])) [] false ≡ h3
  ex1 = refl

  ex2 : protocol (s "https") (s "codepen.io") 443 (just (s "h3" ∷ [])) [] true ≡ h2
  ex2 = refl

  ex3 : protocol (s "http") (s "a.com") 80 (just (s "h3" ∷ [])) [] false ≡ h2
  ex3 = refl

  ex4 : protocol (s "https") (s "a.com") 443 nothing (offer (s "h3") [] 443 86400 ∷ []) false ≡ h3
  ex4 = refl

  ex5 : protocol (s "https") (s "a.com") 443 nothing (offer (s "h3") (s "b.com") 443 86400 ∷ []) false ≡ h2
  ex5 = refl

  ex6 : protocol (s "https") (s "a.com") 443 nothing (offer (s "h3-29") [] 443 86400 ∷ []) false ≡ h2
  ex6 = refl

  ex7 : protocol (s "https") (s "a.com") 8443 nothing (offer (s "h3") [] 443 86400 ∷ []) false ≡ h2
  ex7 = refl

  -- Cloudflare's header, as sent with every response of these zones.
  ex8 : readAltSvc (s "h3=\":443\"; ma=86400") ≡ offers (offer (s "h3") [] 443 86400 ∷ [])
  ex8 = refl

  ex9 : readAltSvc (s " Clear ") ≡ clear
  ex9 = refl

  -- A list; a draft id kept as itself; an authority with a host; a bad
  -- entry skipped; no ma: the default.
  ex10 : readAltSvc (s "h3-29=\":443\"; ma=3600, h3=\"Alt.example:8443\", junk, h3=\":443\"")
       ≡ offers (offer (s "h3-29") [] 443 3600 ∷ offer (s "h3") (s "alt.example") 8443 86400 ∷ offer (s "h3") [] 443 86400 ∷ [])
  ex10 = refl

  -- A comma inside the quoted authority does not split.
  ex11 : readAltSvc (s "h3=\"a,b:443\"") ≡ offers (offer (s "h3") (s "a,b") 443 86400 ∷ [])
  ex11 = refl
