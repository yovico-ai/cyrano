{-# OPTIONS --safe #-}
-- Sec-Fetch-Storage-Access as Chromium sends it (Storage Access Headers),
-- re-enacted by the proxy (Go: proxy/storage_access.go). Under the proxy
-- every request is first-party to the browser, which then sends no such
-- header; the proxy adds it where a direct browser would. Checked against
-- Chromium: storage-access-vs-chromium (frame trees over three sites).
--
-- Only a potentially trustworthy target gets it (https, or loopback), as
-- every Sec-Fetch- header.
--
-- A request's context is the chain of sites from the top-level document
-- to the requesting document (for a frame's navigation: to its embedder).
-- The request is third-party when any site of the chain, or the target's,
-- differs from the top-level site — a cross-site frame's requests are, even
-- to the top-level site (its site for cookies is null), and so are an
-- A-B-A frame's. A top-level navigation carries none.
--
-- The header is sent ("active": third-party cookies allowed, Chrome's
-- default outside Incognito — whether this browser blocks them is not
-- known to the proxy) on a third-party request that carries credentials:
-- credentials mode include, or same-origin when the requesting document's
-- origin is the target's. The mode is the request's: a navigation's and a
-- no-cors element's is include, fetch's default and a cors element's
-- same-origin; fetch can set any (the runtime tells the proxy: Crn-C).
module Storage where

open import Data.Bool.Base using (Bool; true; false; _∨_; _∧_; not; if_then_else_)
open import Data.List.Base using (List; []; _∷_)
open import Data.String.Base using (toList)

open import Url using (Str; eqStr)

data Credentials : Set where
  include omit sameOrigin : Credentials

thirdParty : List Str → Str → Bool
thirdParty []            target = false
thirdParty (top ∷ chain) target = anyOther chain ∨ not (eqStr target top)
  where
  anyOther : List Str → Bool
  anyOther []       = false
  anyOther (s ∷ ss) = not (eqStr s top) ∨ anyOther ss

-- mode, dest: Sec-Fetch-Mode, -Dest (lowercase); chain: top-level site
-- first; from, to: the requesting document's origin and the target's;
-- targetSite: the target's site; trustworthy: the target is potentially
-- trustworthy.
storageAccess : Str → Str → Credentials → List Str → Str → Str → Str → Bool → Bool
storageAccess mode dest cred chain from to targetSite trustworthy =
  trustworthy ∧ not topLevel ∧ thirdParty chain targetSite ∧ credentialed
  where
  navigation : Bool
  navigation = eqStr mode (toList "navigate")
  topLevel : Bool
  topLevel = navigation ∧ eqStr dest (toList "document")
  credentialed : Bool
  credentialed = byMode cred
    where
    byMode : Credentials → Bool
    byMode include    = true
    byMode omit       = false
    byMode sameOrigin = eqStr from to

------------------------------------------------------------------------
-- The storage partition a context's localStorage, IndexedDB, caches and
-- broadcast channels live in (Chromium's StorageKey; TS: patches/
-- storage.ts storagePrefix). First-party — the context's site and every
-- ancestor's are the top-level site's — the origin alone; otherwise the
-- origin with the top-level site (an A-B-A frame is third-party). Checked
-- against Chromium with third-party storage partitioning on:
-- storage-partition-vs-chromium.
--
-- ancestors: the sites from the top-level document down to the parent;
-- site, origin: the context's own.

partitionKey : List Str → Str → Str → Str
partitionKey []                  site origin = origin
partitionKey (top ∷ ancestors) site origin =
  if thirdParty (top ∷ ancestors) site then origin Data.List.Base.++ ('^' ∷ top) else origin
  where import Data.List.Base
