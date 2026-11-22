{-# OPTIONS --safe #-}
------------------------------------------------------------------------
-- An origin as one DNS label, and back (host mode, owner 2026-11-22).
--
-- Every proxied origin is served from a host of its own,
-- <label>.<proxy domain>, so the browser gives its frames processes of
-- their own (with Origin-Agent-Cluster; measured in Chrome). The label is
-- the origin itself, encoded — not a hash — so the runtime reads a
-- message's real origin back from the host it came from (event.origin)
-- and names a recipient's host from its original origin (targetOrigin),
-- with nothing announced and nothing to forge.
--
--   label = <scheme letter> <host, escaped> [-2<port>]
--     scheme  h http, s https, w ws, x wss
--     host    a–z 0–9 as written; "." as "-0", "-" as "-1"
--     port    only when the origin has one (not the default)
--
-- A '-' is always followed by a digit, so no label holds "--" (reserved
-- for IDNA) nor ends with '-'. An origin whose host has another character
-- (an IPv6 address; a host the parser left in another form) or whose
-- label would pass 63 characters has none: it stays on the proxy's own
-- host (path mode for it), correct and only not isolated.
------------------------------------------------------------------------

module OriginLabel where

open import Data.Bool.Base using (Bool; true; false; _∧_; _∨_; if_then_else_)
open import Data.Char.Base using (Char; toℕ)
open import Data.List.Base using (List; []; _∷_; _++_; length; reverse)
open import Data.Maybe.Base using (Maybe; just; nothing)
open import Data.Nat.Base using (ℕ; _≤ᵇ_)
open import Data.Product.Base using (_×_; _,_)

open import Scheme
open import Url

maxLabel : ℕ
maxLabel = 63

letter : Scheme → Char
letter http  = 'h'
letter https = 's'
letter ws    = 'w'
letter wss   = 'x'

schemeOfLetter : Char → Maybe Scheme
schemeOfLetter c =
  if is 104 c then just http else if is 115 c then just https
  else if is 119 c then just ws else if is 120 c then just wss else nothing

lowerOrDigit : Char → Bool
lowerOrDigit c = within 97 122 c ∨ within 48 57 c

-- The host escaped; nothing when it has a character outside a–z 0–9 . -.
escapeHost : Str → Maybe Str
escapeHost []       = just []
escapeHost (c ∷ cs) = step (escapeHost cs)
  where
  step : Maybe Str → Maybe Str
  step nothing  = nothing
  step (just r) = if lowerOrDigit c then just (c ∷ r)
                  else if is 46 c then just ('-' ∷ '0' ∷ r)
                  else if is 45 c then just ('-' ∷ '1' ∷ r)
                  else nothing

-- The label of an origin (host, port as written; [] for none).
originLabel : Scheme → Str → Str → Maybe Str
originLabel sc []          port = nothing
originLabel sc (h ∷ hs) port = fits (escapeHost (h ∷ hs))
  where
  portPart : Str
  portPart = if isEmpty port then [] else '-' ∷ '2' ∷ port
  fits : Maybe Str → Maybe Str
  fits nothing  = nothing
  fits (just e) = if (length (letter sc ∷ e ++ portPart) ≤ᵇ maxLabel) ∧ allDigits port then just (letter sc ∷ e ++ portPart) else nothing
    where
    allDigits : Str → Bool
    allDigits []       = true
    allDigits (d ∷ ds) = within 48 57 d ∧ allDigits ds

-- Reading a label back: scheme, host, port ([] for none).
labelOrigin : Str → Maybe (Scheme × Str × Str)
labelOrigin []       = nothing
labelOrigin (c ∷ cs) with schemeOfLetter c
... | nothing = nothing
... | just sc = hostPart [] cs
  where
  -- reversed host so far, the rest
  hostPart : Str → Str → Maybe (Scheme × Str × Str)
  hostPart acc []                 = if isEmpty acc then nothing else just (sc , reverse acc , [])
  hostPart acc ('-' ∷ '0' ∷ r)    = hostPart ('.' ∷ acc) r
  hostPart acc ('-' ∷ '1' ∷ r)    = hostPart ('-' ∷ acc) r
  hostPart acc ('-' ∷ '2' ∷ r)    = if isEmpty acc ∨ isEmpty r ∨ notDigits r then nothing else just (sc , reverse acc , r)
    where
    notDigits : Str → Bool
    notDigits []       = false
    notDigits (d ∷ ds) = (if within 48 57 d then false else true) ∨ notDigits ds
  hostPart acc ('-' ∷ _)          = nothing
  hostPart acc (d ∷ r)            = if lowerOrDigit d then hostPart (d ∷ acc) r else nothing

