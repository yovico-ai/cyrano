{-# OPTIONS --safe #-}
-- Protected Audience (TypeScript: ts/client/src/patches/ad-auction.ts).
--
-- navigator.joinAdInterestGroup with another owner makes the browser fetch
-- that owner's /.well-known/interest-group/permissions/ itself, outside any
-- page and so outside the proxy, naming the proxy as the origin (round I,
-- a net log); a join it allows stores bidding, update and render URLs the
-- browser fetches later by itself, and runAdAuction fetches the seller's
-- decision logic the same way. Through the proxy it could not work either:
-- every site's groups would be the proxy origin's. The runtime answers as
-- Chrome answers a caller it does not allow (stock Chrome 139, measured on
-- a site not enrolled): a join for the page's own origin resolves without
-- joining, one for another owner rejects NotAllowedError ("Permission to
-- join interest group denied."), runAdAuction resolves null. A call the
-- native refuses before anything is fetched — a missing required member
-- (owner, name, lifetimeMs; an auction's seller, decisionLogicURL), an
-- owner that is not an https URL — goes to the native, for its own
-- TypeError. Known difference: a group whose other URLs the native would
-- refuse (a biddingLogicURL of another origin than its owner) is answered
-- by owner, not with the native's TypeError.
module AdAuction where

open import Data.Bool.Base using (Bool; true; false; if_then_else_)
open import Data.Maybe.Base using (Maybe; just; nothing)

open import Url using (Str; parse; preprocess; url; otherScheme; invalid; outside; scheme; eqStr)
open import Scheme using (Scheme; https)
open import Referrer using (originOf)

data Join : Set where
  native joined denied : Join

isHttps : Scheme → Bool
isHttps https = true
isHttps _     = false

-- joinAnswer complete owner page: complete — every required member is
-- present; owner as the page gave it; page the page's own origin
-- (serialized). nothing: outside the URL model.
joinAnswer : Bool → Str → Str → Maybe Join
joinAnswer false _ _ = just native
joinAnswer true owner page with parse nothing (preprocess owner)
... | url a       = just (if isHttps (scheme a) then (if eqStr (originOf a) page then joined else denied) else native)
... | otherScheme = just native
... | invalid     = just native
... | outside     = nothing

-- An auction: the native's when it would refuse it (a required member
-- missing), else null.
auctionNative : Bool → Bool
auctionNative complete = if complete then false else true
