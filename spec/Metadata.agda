{-# OPTIONS --safe #-}
-- Request headers a direct browser sends only to a potentially
-- trustworthy URL (https, wss, loopback: Secure Contexts §3.1) — the
-- fetch metadata (Sec-Fetch-*) and the client hints (Sec-CH-*, and the
-- legacy names). Through the proxy the browser talks to the proxy, which
-- is trustworthy, and sends them for every request; for an http target
-- that is not, the proxy drops them, and synthesizes none (Go:
-- proxy.dropInsecureMetadata, upstream.ensureClientHints). Checked against
-- Chromium: metadata-vs-chromium.
module Metadata where

open import Data.Bool.Base using (Bool; true; false; _∨_; _∧_; not)
open import Data.List.Base using (List; []; _∷_; map)
open import Data.String.Base using (toList)

open import Url using (Str; eqStr; lowerAscii)

startsWith : Str → Str → Bool
startsWith [] _ = true
startsWith (a ∷ as) (b ∷ bs) = Data.Char.Base._≈ᵇ_ a b ∧ startsWith as bs
  where import Data.Char.Base
startsWith _ [] = false

legacyHint : Str → Bool
legacyHint n = anyEq (map toList ("dpr" ∷ "device-memory" ∷ "viewport-width" ∷ "width" ∷ "rtt" ∷ "downlink" ∷ "ect" ∷ []))
  where
  anyEq : List Str → Bool
  anyEq []       = false
  anyEq (x ∷ xs) = eqStr n x ∨ anyEq xs

secureOnly : Str → Bool
secureOnly name = startsWith (toList "sec-fetch-") n ∨ startsWith (toList "sec-ch-") n ∨ legacyHint n
  where
  n : Str
  n = map lowerAscii name

-- Whether a request header of this name can reach the target.
sentTo : Str → Bool → Bool
sentTo name trustworthy = trustworthy ∨ not (secureOnly name)
