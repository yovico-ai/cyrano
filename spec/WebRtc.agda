{-# OPTIONS --safe #-}
-- WebRTC through the proxy's relay (TS: ts/client/src/patches/webrtc.ts;
-- Go: internal/turn). Directly, a peer connection gathers host and
-- server-reflexive candidates — STUN to the page's servers, media straight
-- from the browser: the one traffic class that left the proxy and showed
-- the user's address. The owner's choice (2026-11-23): relay it. Every
-- peer connection uses only cyrano's TURN server (iceTransportPolicy
-- "relay"), the page's ICE servers never contacted.
--
-- The page's configuration goes to the native first, as given — its
-- validation, its errors and its normalization are the native's — then,
-- synchronously, before any gathering can start, the native is given the
-- relay in its place (setConfiguration may change these two members
-- before negotiation). What the page reads (getConfiguration) is the
-- native's configuration with the page's own servers and policy. Known,
-- inherent: only relay candidates are gathered; getStats and the
-- candidates name cyrano's relay address.
module WebRtc where

-- A configuration as the native normalized it: the two members the relay
-- replaces, and the rest (bundlePolicy, certificates, …) as one.
data Policy : Set where
  all relay : Policy

record Config (Servers Rest : Set) : Set where
  constructor config
  field
    iceServers         : Servers
    iceTransportPolicy : Policy
    rest               : Rest
open Config public

-- What the native is given: the relay's servers, relay only.
toNative : ∀ {S R} → S → Config S R → Config S R
toNative ours (config _ _ r) = config ours relay r

-- What the page reads: the native's, with the page's own servers and policy.
shown : ∀ {S R} → Config S R → Config S R → Config S R
shown page (config _ _ r) = config (iceServers page) (iceTransportPolicy page) r

-- The page reads back what it gave, whatever the relay is.
private
  open import Relation.Binary.PropositionalEquality using (_≡_; refl)
  shown-toNative : ∀ {S R} (ours : S) (page : Config S R) → shown page (toNative ours page) ≡ page
  shown-toNative ours (config s p r) = refl
