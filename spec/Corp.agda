{-# OPTIONS --safe #-}
------------------------------------------------------------------------
-- The cross-origin resource policy check (Fetch "cross-origin resource
-- policy internal check"; round K: a site's Cross-Origin-Resource-Policy
-- was not enforced, nor an embedder's COEP require-corp — through the
-- proxy every subresource is same-origin to the browser, so its own check
-- never fires). The proxy judges a no-cors request's response as the
-- browser would have, by the original URLs, and fails one it blocks (a
-- network error, as ORB's):
--
--   * policy: the response's Cross-Origin-Resource-Policy, when it is
--     "same-origin", "same-site" or "cross-origin" (trimmed); else none;
--   * none, under the embedder's COEP: require-corp (or
--     Document-Isolation-Policy isolate-and-require-corp) — same-origin;
--     credentialless — same-origin when the request carries credentials;
--   * same-origin: blocked unless the requester's origin is the
--     response's; same-site: unless they are schemelessly same-site and
--     the requester is not https or the response is.
-- `originSite` / `targetSite`: registrable domains (nothing: an IP host),
-- as Referrer.secFetchSite takes them. Outside the model: a nested
-- document's COEP (frames), reporting.
------------------------------------------------------------------------

module Corp where

open import Data.Bool.Base using (Bool; true; false; _∨_; _∧_; not; if_then_else_)
open import Data.Char.Base using (Char)
open import Data.List.Base using (List; []; _∷_; reverse)
open import Data.Maybe.Base using (Maybe; just; nothing)
open import Data.String.Base using (toList)

open import Scheme
open import Url
open import Referrer using (sameOriginOf; hostOf)

data Embedder : Set where
  unsafeNone requireCorp credentialless : Embedder

data Policy : Set where
  pSameOrigin pSameSite pCrossOrigin : Policy

trimOWS : Str → Str
trimOWS s = reverse (drop (reverse (drop s)))
  where
  drop : Str → Str
  drop []       = []
  drop (c ∷ cs) = if is 32 c ∨ is 9 c then drop cs else c ∷ cs

policyOf : Maybe Str → Maybe Policy
policyOf nothing  = nothing
policyOf (just v) =
  if eqStr (trimOWS v) (toList "same-origin") then just pSameOrigin
  else if eqStr (trimOWS v) (toList "same-site") then just pSameSite
  else if eqStr (trimOWS v) (toList "cross-origin") then just pCrossOrigin
  else nothing

isHttps : Scheme → Bool
isHttps https = true
isHttps _     = false

corpBlocks : Maybe Str → Embedder → Bool → Abs → Maybe Str → Abs → Maybe Str → Bool
corpBlocks header emb credentialed origin originSite target targetSite = by (effective (policyOf header) emb)
  where
  effective : Maybe Policy → Embedder → Maybe Policy
  effective (just p) _              = just p
  effective nothing  unsafeNone     = nothing
  effective nothing  requireCorp    = just pSameOrigin
  effective nothing  credentialless = if credentialed then just pSameOrigin else nothing
  schemelessSameSite : Bool
  schemelessSameSite = reg originSite targetSite
    where
    reg : Maybe Str → Maybe Str → Bool
    reg (just a) (just b) = eqStr a b
    reg nothing  nothing  = eqStr (hostOf origin) (hostOf target)
    reg _        _        = false
  by : Maybe Policy → Bool
  by nothing             = false
  by (just pCrossOrigin) = false
  by (just pSameOrigin)  = not (sameOriginOf origin target)
  by (just pSameSite)    = not (schemelessSameSite ∧ (not (isHttps (scheme origin)) ∨ isHttps (scheme target)))
