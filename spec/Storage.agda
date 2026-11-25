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
import Url

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

-- ---------------------------------------------------------------------
-- Names under a storage key (TS: patches/storage.ts — localStorage and
-- sessionStorage keys, IndexedDB database names, Cache Storage names,
-- BroadcastChannel names). Every name page code gives is stored as
--   "crn" ␟ KEY ␟ NAME        (␟ = U+001F)
-- and read back as NAME; a stored name of another key (or one stored
-- before this existed) is not read back at all: listings —
-- localStorage.key / length, indexedDB.databases(), caches.keys() — and
-- storage events show only the key's own names.
--
-- Proved: a name reads back as it was given (shown-stored). Not proved
-- here, checked by property against the oracle (storage-names-conformance):
-- a name stored under one key is not read under another — it holds because
-- a storage key (an origin, or origin ^ site) never holds ␟.

import Data.Char.Base as C
import Data.Nat.Base as N

sep : C.Char
sep = C.fromℕ 31

open import Data.List.Base using (_++_)
open import Data.Maybe.Base using (Maybe; just; nothing)
open import Relation.Binary.PropositionalEquality using (_≡_; refl)

namePrefix : Str → Str
namePrefix key = toList "crn" ++ (sep ∷ key ++ (sep ∷ []))

stored : Str → Str → Str
stored key name = namePrefix key ++ name

-- The rest of s after p, when s starts with p.
dropPrefix : Str → Str → Maybe Str
dropPrefix []       s        = just s
dropPrefix (_ ∷ _)  []       = nothing
dropPrefix (p ∷ ps) (c ∷ cs) = if C.toℕ p N.≡ᵇ C.toℕ c then dropPrefix ps cs else nothing

shown : Str → Str → Maybe Str
shown key s = dropPrefix (namePrefix key) s

-- A listing as page code sees it: its key's names, read back; others dropped.
listed : Str → List Str → List Str
listed key [] = []
listed key (s ∷ ss) with shown key s
... | just n  = n ∷ listed key ss
... | nothing = listed key ss

private
  ≡ᵇ-refl : ∀ n → (n N.≡ᵇ n) ≡ true
  ≡ᵇ-refl N.zero    = refl
  ≡ᵇ-refl (N.suc n) = ≡ᵇ-refl n

  drop-own : ∀ p n → dropPrefix p (p ++ n) ≡ just n
  drop-own []       n = refl
  drop-own (c ∷ cs) n rewrite ≡ᵇ-refl (C.toℕ c) = drop-own cs n

-- A name reads back as it was given.
shown-stored : ∀ key name → shown key (stored key name) ≡ just name
shown-stored key name = drop-own (namePrefix key) name

-- ---------------------------------------------------------------------
-- Web Locks names (TS: patches/storage.ts patchStorageNames, windows and
-- workers): every proxied site shares the proxy origin's one lock manager
-- (round H: a lock one site held blocked another's of the same name, and
-- query() listed it). A lock's name is stored under the key as any other
-- name; a Lock's name and query()'s entries read back through shown /
-- listed. A name starting with "-" goes to the native as given (nothing):
-- it refuses it ("Names cannot start with '-'"), the prefixed name it
-- would not.
lockName : Str → Str → Maybe Str
lockName key ('-' ∷ _) = nothing
lockName key name      = just (stored key name)

-- ---------------------------------------------------------------------
-- The Origin Private File System (TS: patches/storage.ts): every proxied
-- site had the proxy origin's one root (round H: a file one site made was
-- listed and read by every other). The page's root is a directory of the
-- real one named for the key — "crn" ␟ KEY' ␟, KEY' the key with "%", "/"
-- and "\" percent-encoded (an entry's name may hold no slash) — and its
-- name reads as a root's: "".
encodeDirKey : Str → Str
encodeDirKey []         = []
encodeDirKey ('%' ∷ s)  = '%' ∷ '2' ∷ '5' ∷ encodeDirKey s
encodeDirKey ('/' ∷ s)  = '%' ∷ '2' ∷ 'F' ∷ encodeDirKey s
encodeDirKey ('\\' ∷ s) = '%' ∷ '5' ∷ 'C' ∷ encodeDirKey s
encodeDirKey (c ∷ s)    = c ∷ encodeDirKey s

opfsDir : Str → Str
opfsDir key = toList "crn" ++ (sep ∷ encodeDirKey key ++ (sep ∷ []))

-- ---------------------------------------------------------------------
-- The old FileSystem API (TS: patches/storage.ts patchOldFileSystem):
-- webkitRequestFileSystem's TEMPORARY and PERSISTENT file systems were the
-- proxy origin's one each (round K's built-in survey: one site's files were
-- found by another). The page's root is the real root's directory named as
-- its OPFS root is (opfsDir). A path the page gives an entry at page path
-- `at` — from the root when it starts with "/", else from `at`; "" and "."
-- segments dropped, ".." one up and never above the root (measured,
-- Chromium) — is that directory's path; a real path under it shows as the
-- page's. (The root itself is refused removal or a move, as natively: the
-- runtime asks the real root.)
fsPath : Str → Str → Str → Str
fsPath key at given = root ++ joined (walk (start given) (Url.splitOn (Url.is 47) given))
  where
  open import Data.List.Base using (_++_; reverse)
  root : Str
  root = '/' ∷ opfsDir key
  -- the segments walked so far, innermost first
  start : Str → List Str
  start ('/' ∷ _) = []
  start _         = reverse (dropEmpty (Url.splitOn (Url.is 47) at))
    where
    dropEmpty : List Str → List Str
    dropEmpty [] = []
    dropEmpty ([] ∷ ss) = dropEmpty ss
    dropEmpty (s ∷ ss) = s ∷ dropEmpty ss
  walk : List Str → List Str → List Str
  walk acc [] = acc
  walk acc ([] ∷ ss) = walk acc ss
  walk acc (('.' ∷ []) ∷ ss) = walk acc ss
  walk [] (('.' ∷ '.' ∷ []) ∷ ss) = walk [] ss
  walk (_ ∷ acc) (('.' ∷ '.' ∷ []) ∷ ss) = walk acc ss
  walk acc (s ∷ ss) = walk (s ∷ acc) ss
  joined : List Str → Str
  joined [] = []
  joined segs = go (reverse segs)
    where
    go : List Str → Str
    go [] = []
    go (s ∷ ss) = '/' ∷ s ++ go ss

-- A real path as the page sees it: under the key's directory, the rest
-- ("/" for the directory itself); any other, as it is.
shownPath : Str → Str → Str
shownPath key real = strip ('/' ∷ opfsDir key) real
  where
  strip : Str → Str → Str
  strip [] [] = '/' ∷ []
  strip [] rest@('/' ∷ _) = rest
  strip (p ∷ ps) (c ∷ cs) = if eqStr (p ∷ []) (c ∷ []) then strip ps cs else real
  strip _ _ = real
