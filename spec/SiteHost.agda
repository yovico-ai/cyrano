{-# OPTIONS --safe #-}
------------------------------------------------------------------------
-- One proxy host per site (owner, 2026-11-22; branch host-per-site).
--
-- Every proxied site — a scheme and a registrable domain, Chromium's
-- "schemeful site" — is served from a host of its own under the proxy's
-- domain: <label>.<domain>. The path still names the whole target, as in
-- path mode (Containment.agda: /cyrano/<scheme>/<host>/…); the host only
-- says which site's partition the request belongs to. So the browser
-- keeps each site's cookies (and their limit), storage, process and
-- thread apart, as it does directly. Measured in Chrome 2026-11-22
-- (scratchpad hosts/probe.cjs): sibling labels of an ordinary domain are
-- one site to the browser (one process, one cookie limit: three frames
-- of 200 cookies kept 0, 0 and 166); under an unlisted TLD or a public
-- suffix each label is a site of its own (169, 169, 169; each frame its
-- own process). The proxy's domain must therefore be a public suffix or
-- sit under an unlisted TLD (locally: <label>.localhost).
--
-- The label is a function of the site alone — no table, no state shared
-- between servers: the first 26 characters of base32(SHA-256(site key)),
-- 130 bits. Collisions are practically impossible, and would merge two
-- sites' partitions, never misroute a request (the path routes it). A
-- request is admitted only on the host its target's site names
-- (`admits`); on another the proxy redirects it there, so one site's
-- cookies are never sent to, nor set under, another's host.
--
-- The registrable domain (eTLD+1) is an input, as in Referrer.agda:
-- public-suffix data is outside the model; nothing for a host without one
-- (an IP address, a name that is itself a public suffix), which is then
-- its own site.
------------------------------------------------------------------------

module SiteHost where

open import Data.Bool.Base using (Bool; true; false; _∧_; if_then_else_)
open import Data.List.Base using (List; []; _∷_; _++_; take; drop; length; concatMap; reverse)
open import Data.Maybe.Base using (Maybe; just; nothing)
open import Data.Nat.Base using (ℕ; _≡ᵇ_)
open import Data.Char.Base using (Char; toℕ)
open import Data.String.Base using (toList)
open import Data.Product.Base using (_×_; _,_)

open import Url
open import Scheme
open import Sha256 using (sha256; base32)

-- The site a target belongs to, as text: "<scheme>://<registrable domain>"
-- (the host itself when it has none). The port is not part of a site.
siteKey : Scheme → Str → Maybe Str → Str
siteKey sc host (just reg) = schemeChars sc ++ toList "://" ++ reg
siteKey sc host nothing    = schemeChars sc ++ toList "://" ++ host

-- Its label: 26 characters of [a-z2-7], a valid DNS label.
labelLength : ℕ
labelLength = 26

-- Opaque to the type checker: no proof depends on the hash's value, and
-- unfolding SHA-256 over a term with unknowns made the checker take
-- 35 GB. The compiled oracle computes it as usual.
opaque
  siteLabel : Str → Str
  siteLabel key = take labelLength (base32 (sha256 (concatMap (λ c → utf8 (toℕ c)) key)))

-- The proxy host serving a site.
siteHost : Str → Str → Str
siteHost domain key = siteLabel key ++ '.' ∷ domain

-- The label of a host under the proxy's domain: one label, then
-- "." <domain> (ASCII case aside: hosts are lower case once parsed).
labelOf : Str → Str → Maybe Str
labelOf domain host = byLabel (splitAtDot host)
  where
  splitAtDot : Str → Maybe (Str × Str)
  splitAtDot = go []
    where
    go : Str → Str → Maybe (Str × Str)
    go acc []       = nothing
    go acc (c ∷ cs) = if toℕ c ≡ᵇ 46 then just (reverse acc , cs) else go (c ∷ acc) cs
  byLabel : Maybe (Str × Str) → Maybe Str
  byLabel (just (l , rest)) = if eqStr rest domain ∧ notEmpty l then just l else nothing
    where
    notEmpty : Str → Bool
    notEmpty [] = false
    notEmpty _  = true
  byLabel nothing = nothing

-- Whether a request for a target of site `key` may be served on `host`:
-- exactly when host is that site's host.
admits : Str → Str → Str → Bool
admits domain host key with labelOf domain host
... | just l  = eqStr l (siteLabel key)
... | nothing = false
