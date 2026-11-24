{-# OPTIONS --safe #-}
-- What a direct browser sends upstream as Referer, Origin and
-- Sec-Fetch-Site — and what page code reads as document.referrer, which is
-- the Referer the document was requested with.
--
-- Under cyrano every page and resource is on the proxy origin, so the
-- browser applies each policy to same-origin proxy URLs and its own header
-- values are no evidence of what it would send directly. The server
-- recomputes them from the original URLs (the page cannot tell, nor can
-- the upstream; REQUIREMENTS.md).
--
-- Sources: W3C Referrer Policy (§3 policies, §8.3 "determine request's
-- referrer", §8.4 "strip url for use as a referrer"); W3C Secure Contexts
-- §3.1 (potentially trustworthy); Fetch §3.1 ("append a request `Origin`
-- header"); Fetch Metadata (Sec-Fetch-Site, schemeful same-site).
-- Where Chromium departs: a referrer whose serialization exceeds 4096
-- bytes is sent as its origin.
--
-- Implemented by go/src/internal/referrer.
module Referrer where

open import Data.Bool.Base using (Bool; true; false; _∧_; _∨_; not; if_then_else_)
open import Data.Char.Base using (Char; toℕ; fromℕ)
open import Data.List.Base using (List; []; _∷_; _++_; reverse)
open import Data.Maybe.Base using (Maybe; just; nothing)
open import Data.Nat.Base using (ℕ; _<ᵇ_)
import Data.String.Base
open import Data.String.Base using (toList)
open import Data.Product.Base using (_×_; _,_)

open import Scheme
open import Url

------------------------------------------------------------------------
-- Policies (§3), and the Referrer-Policy header (§4.1): a comma-separated
-- list whose last recognized token wins.

data Policy : Set where
  noReferrer noReferrerWhenDowngrade sameOrigin origin strictOrigin
    originWhenCrossOrigin strictOriginWhenCrossOrigin unsafeUrl : Policy

-- The default when nothing (or nothing recognized) is given.
defaultPolicy : Policy
defaultPolicy = strictOriginWhenCrossOrigin

lowerAll′ : Str → Str
lowerAll′ []       = []
lowerAll′ (c ∷ cs) = lowerAscii c ∷ lowerAll′ cs

policyToken : Str → Maybe Policy
policyToken s =
  if eqStr t (toList "no-referrer") then just noReferrer
  else if eqStr t (toList "no-referrer-when-downgrade") then just noReferrerWhenDowngrade
  else if eqStr t (toList "same-origin") then just sameOrigin
  else if eqStr t (toList "origin") then just origin
  else if eqStr t (toList "strict-origin") then just strictOrigin
  else if eqStr t (toList "origin-when-cross-origin") then just originWhenCrossOrigin
  else if eqStr t (toList "strict-origin-when-cross-origin") then just strictOriginWhenCrossOrigin
  else if eqStr t (toList "unsafe-url") then just unsafeUrl
  else nothing
  where
  isWS : Char → Bool
  isWS c = is 32 c ∨ is 9 c ∨ is 10 c ∨ is 12 c ∨ is 13 c

  trim : Str → Str
  trim x = reverse (dropWhile isWS (reverse (dropWhile isWS x)))

  t : Str
  t = lowerAll′ (trim s)

-- A policy's name, as the header and the referrerpolicy attribute write it.
policyName : Policy → Data.String.Base.String
policyName noReferrer                  = "no-referrer"
policyName noReferrerWhenDowngrade     = "no-referrer-when-downgrade"
policyName sameOrigin                  = "same-origin"
policyName origin                      = "origin"
policyName strictOrigin                = "strict-origin"
policyName originWhenCrossOrigin       = "origin-when-cross-origin"
policyName strictOriginWhenCrossOrigin = "strict-origin-when-cross-origin"
policyName unsafeUrl                   = "unsafe-url"

-- The policy a Referrer-Policy header value sets, if any.
headerPolicy : Str → Maybe Policy
headerPolicy v = lastOf (splitOn (is 44) v) nothing
  where
  lastOf : List Str → Maybe Policy → Maybe Policy
  lastOf []       acc = acc
  lastOf (t ∷ ts) acc with policyToken t
  ... | just p  = lastOf ts (just p)
  ... | nothing = lastOf ts acc

------------------------------------------------------------------------
-- Origins.

originOf : Abs → Str
originOf a = schemeChars (scheme a) ++ toList "://" ++ hostPort (auth a)

sameOriginOf : Abs → Abs → Bool
sameOriginOf a b = sameScheme (scheme a) (scheme b) ∧ eqStr (hostPort (auth a)) (hostPort (auth b))

-- The host of a canonical authority (no userinfo, no port).
hostOf : Abs → Str
hostOf a = bracketAware (hostPort (auth a))
  where
  -- "[…]:port" keeps the brackets; "h:port" ends at the ':'.
  bracketAware : Str → Str
  bracketAware []       = []
  bracketAware (c ∷ cs) = if is 91 c then c ∷ upToBracket cs else proj₁′ (break (is 58) (c ∷ cs))
    where
    proj₁′ : Str × Str → Str
    proj₁′ (h , _) = h

    upToBracket : Str → Str
    upToBracket []       = []
    upToBracket (d ∷ ds) = if is 93 d then d ∷ [] else d ∷ upToBracket ds

-- Secure Contexts §3.1, for the schemes in the model: https and wss, and
-- loopback hosts (localhost, *.localhost, 127.0.0.0/8, [::1]).
trustworthy : Abs → Bool
trustworthy a = secureScheme (scheme a) ∨ loopback (hostOf a)
  where
  secureScheme : Scheme → Bool
  secureScheme https = true
  secureScheme wss   = true
  secureScheme http  = false
  secureScheme ws    = false

  endsWith : Str → Str → Bool
  endsWith suffix s = startsWith (reverse suffix) (reverse s)
    where
    startsWith : Str → Str → Bool
    startsWith []       _        = true
    startsWith (_ ∷ _)  []       = false
    startsWith (x ∷ xs) (y ∷ ys) = eqStr (x ∷ []) (y ∷ []) ∧ startsWith xs ys

  loopback : Str → Bool
  loopback h = eqStr h (toList "localhost") ∨ endsWith (toList ".localhost") h
             ∨ eqStr h (toList "[::1]") ∨ v4loop (splitOn (is 46) h)
    where
    v4loop : List Str → Bool
    v4loop (a ∷ _ ∷ _ ∷ _ ∷ []) = eqStr a (toList "127")
    v4loop _                    = false

-- A downgrade: from a potentially trustworthy URL to one that is not.
downgrade : Abs → Abs → Bool
downgrade from to = trustworthy from ∧ not (trustworthy to)

------------------------------------------------------------------------
-- §8.4: a URL as a referrer — no userinfo, no fragment; or its origin.

asReferrer : Abs → Str
asReferrer a = href (mkAbs (scheme a) (hostPort (auth a)) (path a) (query a) nothing)

asOriginReferrer : Abs → Str
asOriginReferrer a = originOf a ++ fromℕ 47 ∷ []

lengthS : Str → ℕ
lengthS []       = 0
lengthS (_ ∷ cs) = Data.Nat.Base.suc (lengthS cs)

-- §8.3 for a request to `target` from a document at `ref` under `p`.
referrer : Policy → Abs → Abs → Maybe Str
referrer p ref target = decide p
  where
  full : Str
  full = if 4096 <ᵇ lengthS (asReferrer ref) then asOriginReferrer ref else asReferrer ref

  only : Str
  only = asOriginReferrer ref

  same : Bool
  same = sameOriginOf ref target

  down : Bool
  down = downgrade ref target

  decide : Policy → Maybe Str
  decide noReferrer                  = nothing
  decide noReferrerWhenDowngrade     = if down then nothing else just full
  decide sameOrigin                  = if same then just full else nothing
  decide origin                      = just only
  decide strictOrigin                = if down then nothing else just only
  decide originWhenCrossOrigin       = if same then just full else just only
  decide strictOriginWhenCrossOrigin = if same then just full else if down then nothing else just only
  decide unsafeUrl                   = just full

------------------------------------------------------------------------
-- Fetch §3.1: the Origin header, for a request with this mode and method
-- from a document at `init` to `target`. A request that would natively be
-- cross-origin CORS (or a WebSocket) carries the initiator's origin; so
-- does a same-origin CORS one for a script, style, font or image (Chromium,
-- measured: a module or crossorigin script, a crossorigin stylesheet or
-- image, an @font-face font — not fetch(), XHR, audio; jetblue's CDN
-- answers 403 without it); any other request does only when its method is
-- neither GET nor HEAD, and then the policy may turn it into "null".

data Mode : Set where
  navigate sameOriginMode noCors cors websocket : Mode

originHeader : Mode → Bool → Policy → Abs → Abs → Maybe Str → Maybe Str
originHeader m safeMethod p init target dest = byMode m
  where
  carries : Maybe Str → Bool
  carries nothing  = false
  carries (just d) = eqStr d (toList "script") ∨ eqStr d (toList "style") ∨ eqStr d (toList "font") ∨ eqStr d (toList "image")

  o : Str
  o = originOf init

  nullOr : Bool → Str
  nullOr b = if b then toList "null" else o

  policyNull : Policy → Bool
  policyNull noReferrer                  = true
  policyNull noReferrerWhenDowngrade     = downgrade init target
  policyNull strictOrigin                = downgrade init target
  policyNull strictOriginWhenCrossOrigin = downgrade init target
  policyNull sameOrigin                  = not (sameOriginOf init target)
  policyNull origin                      = false
  policyNull originWhenCrossOrigin       = false
  policyNull unsafeUrl                   = false

  otherwise : Maybe Str
  otherwise = if safeMethod then nothing else just (nullOr (policyNull p))

  byMode : Mode → Maybe Str
  byMode websocket = just o
  byMode cors      = if sameOriginOf init target then (if carries dest then just o else otherwise) else just o
  byMode _         = otherwise

-- From a context whose origin is opaque (a sandboxed document; the oracle
-- writes its initiator "null") the origin serializes as "null" and no URL
-- is same-origin with it: a request carries Origin "null" wherever it
-- carries one at all — CORS, a WebSocket, an unsafe method (a policy can
-- only turn it into "null").
originHeaderOpaque : Mode → Bool → Maybe Str
originHeaderOpaque websocket _ = just (toList "null")
originHeaderOpaque cors      _ = just (toList "null")
originHeaderOpaque _ safeMethod = if safeMethod then nothing else just (toList "null")

------------------------------------------------------------------------
-- Fetch Metadata: Sec-Fetch-Site, schemeful. `initSite` / `targetSite`
-- are the registrable domains (eTLD+1; public-suffix data is outside the
-- model), or nothing for a host that has none (an IP address).

data Site : Set where
  sameOriginSite sameSite crossSite : Site

-- From an opaque origin nothing is same-site: cross-site.
secFetchSiteOpaque : Site
secFetchSiteOpaque = crossSite

secFetchSite : Abs → Maybe Str → Abs → Maybe Str → Site
secFetchSite init initSite target targetSite =
  if sameOriginOf init target then sameOriginSite
  else if sameScheme (scheme init) (scheme target) ∧ registrable initSite targetSite then sameSite
  else crossSite
  where
  registrable : Maybe Str → Maybe Str → Bool
  registrable (just a) (just b) = eqStr a b
  registrable nothing  nothing  = eqStr (hostOf init) (hostOf target)
  registrable _        _        = false

------------------------------------------------------------------------
-- A RequestInit's referrer (Fetch, new Request(input, init): init's
-- "referrer"), as Chromium reads it (checked: fetch-vs-chromium): "" is no
-- referrer; otherwise the value is parsed against the API base URL — a
-- failure throws a TypeError — and is the context's own referrer
-- ("about:client") unless it is a URL of the context's origin, which is
-- then the request's referrer (fragment and all). about:client itself, any
-- other about: URL, data:, blob: …: the context's own.
--
-- Under cyrano the context is on the proxy origin and the page names its
-- original URLs: the runtime hands the browser the proxified URL of a
-- referrer it would honour directly, so the browser sends it and the
-- proxy, reading it back, applies the policy to the original
-- (ts/client/src/patches/fetch.ts). Mapbox's worker names its page so, for
-- its tokens' URL restriction.

data InitReferrer : Set where
  initNone initClient initError initOutside : InitReferrer
  initUrl : Abs → InitReferrer

-- base: the API base URL; ctx: a URL of the context's origin (its document's).
initReferrer : Abs → Abs → Str → InitReferrer
initReferrer base ctx [] = initNone
initReferrer base ctx v with parse (just base) (preprocess v)
... | url a       = if sameOriginOf a ctx then initUrl a else initClient
... | invalid     = initError
... | otherScheme = initClient
... | outside     = initOutside

------------------------------------------------------------------------
-- Which responses set a referrer policy: those whose own requests then
-- follow the response's Referrer-Policy — a document (top-level, frame,
-- iframe, embed, object), a worker (dedicated, shared, service), and a
-- stylesheet (CSSOM: its url()s, @imports and fonts). A script's sets
-- nothing. The proxy records the policy of these (Go: recordPagePolicy) and
-- tells the browser unsafe-url. Checked against Chromium:
-- policy-contexts-vs-chromium.

setsPolicy : Str → Bool
setsPolicy d = anyS (Data.List.Base.map toList ("document" ∷ "iframe" ∷ "frame" ∷ "embed" ∷ "object" ∷ "worker" ∷ "sharedworker" ∷ "serviceworker" ∷ "style" ∷ []))
  where
  import Data.List.Base
  anyS : List Str → Bool
  anyS []       = false
  anyS (x ∷ xs) = eqStr (Data.List.Base.map lowerAscii d) x ∨ anyS xs
