{-# OPTIONS --safe #-}
------------------------------------------------------------------------
-- Cross-Origin-Opener-Policy (HTML §7.1.3; Chromium, measured: coop-vs-
-- chromium). A popup whose document's policy does not match its
-- opener's is put in a browsing context group of its own: the opener's
-- handle reads closed, the popup's opener is null. The match is by value
-- and by origin, and through the proxy every document has the proxy's
-- origin: two sites that both send `same-origin` matched, and stayed one
-- group (round K). The browser still severs where the values differ; the
-- runtime severs where only the original origins do.
--
--   * The header is a structured item, its token the value; any other
--     value, or none, is unsafe-none. A policy delivered over a document
--     that is not a secure context is ignored (unsafe-none).
--   * same-origin with an embedder policy of require-corp is
--     same-origin-plus-COEP (a value of its own when matching).
--   * Two policies match when both are unsafe-none, or both have the same
--     value and their documents the same origin.
--   * A navigation of a popup's initial about:blank (its policy and origin
--     its opener's) to a response needs a switch unless they match, or the
--     about:blank's is same-origin-allow-popups and the response's
--     unsafe-none.
------------------------------------------------------------------------

module Coop where

open import Data.Bool.Base using (Bool; true; false; _∧_; _∨_; not; if_then_else_)
open import Data.List.Base using (List; []; _∷_)
open import Data.Maybe.Base using (Maybe; just; nothing)
open import Data.String.Base using (toList)

open import Url using (Str; eqStr)
open import Sf using (Bare; token; Member; item; sfList)

data Coop : Set where
  unsafeNone sameOriginAllowPopups sameOrigin sameOriginPlusCoep noopenerAllowPopups : Coop

eqCoop : Coop → Coop → Bool
eqCoop unsafeNone            unsafeNone            = true
eqCoop sameOriginAllowPopups sameOriginAllowPopups = true
eqCoop sameOrigin            sameOrigin            = true
eqCoop sameOriginPlusCoep    sameOriginPlusCoep    = true
eqCoop noopenerAllowPopups   noopenerAllowPopups   = true
eqCoop _                     _                     = false

-- The header's value (one field line; nothing: none), the document a
-- secure context, its embedder policy require-corp.
coopOf : Maybe Str → Bool → Bool → Coop
coopOf nothing  _      _    = unsafeNone
coopOf (just v) secure corp = if not secure then unsafeNone else byItem (sfList v)
  where
  byToken : Str → Coop
  byToken t =
    if eqStr t (toList "same-origin") then (if corp then sameOriginPlusCoep else sameOrigin)
    else if eqStr t (toList "same-origin-allow-popups") then sameOriginAllowPopups
    else if eqStr t (toList "noopener-allow-popups") then noopenerAllowPopups
    else unsafeNone
  -- (a structured item: a list of exactly one bare item)
  byItem : Maybe (List Member) → Coop
  byItem (just (item (token t) ∷ [])) = byToken t
  byItem _ = unsafeNone

-- Origins as their serializations.
matches : Coop → Str → Coop → Str → Bool
matches unsafeNone oa unsafeNone ob = true
matches a oa b ob = eqCoop a b ∧ eqStr oa ob

-- A navigation of a top-level browsing context from a document of policy
-- `a`, origin `oa`, to a response of policy `b`, origin `ob`: a switch
-- unless they match, or — from a popup's initial about:blank only (its
-- policy and origin its opener's) — `a` is same-origin-allow-popups and
-- `b` unsafe-none (HTML "check if a BCG switch is needed").
switchesAt : Bool → Coop → Str → Coop → Str → Bool
switchesAt initial a oa b ob =
  not (matches a oa b ob) ∧ not (initial ∧ allowPopups a ∧ none b)
  where
  allowPopups : Coop → Bool
  allowPopups sameOriginAllowPopups = true
  allowPopups _ = false
  none : Coop → Bool
  none unsafeNone = true
  none _ = false

-- A popup's first navigation (from its initial about:blank).
switches : Coop → Str → Coop → Str → Bool
switches = switchesAt true

-- What the runtime severs: a switch by the original origins that the
-- browser, seeing the proxy's origin for both, does not make — at a
-- popup's first navigation, and at each later one (the previous
-- document's policy and origin kept for the tab: a severed popup that
-- navigates on stays severed, and one that was not is severed when its
-- next document does not match).
emulatedAt : Bool → Coop → Str → Coop → Str → Str → Bool
emulatedAt initial a oa b ob proxy = switchesAt initial a oa b ob ∧ not (switchesAt initial a proxy b proxy)

emulated : Coop → Str → Coop → Str → Str → Bool
emulated = emulatedAt true

-- The header's token as the server gives it to the runtime (a structured
-- item's bare token; nothing otherwise).
coopToken : Maybe Str → Maybe Str
coopToken nothing = nothing
coopToken (just v) with sfList v
... | just (item (token t) ∷ []) = just t
... | _ = nothing

coopName : Coop → Str
coopName unsafeNone            = toList "unsafe-none"
coopName sameOriginAllowPopups = toList "same-origin-allow-popups"
coopName sameOrigin            = toList "same-origin"
coopName sameOriginPlusCoep    = toList "same-origin-plus-coep"
coopName noopenerAllowPopups   = toList "noopener-allow-popups"

-- The value from the token (coopOf, the header read by coopToken).
coopFromToken : Maybe Str → Bool → Bool → Coop
coopFromToken nothing  _      _    = unsafeNone
coopFromToken (just t) secure corp =
  if not secure then unsafeNone
  else if eqStr t (toList "same-origin") then (if corp then sameOriginPlusCoep else sameOrigin)
  else if eqStr t (toList "same-origin-allow-popups") then sameOriginAllowPopups
  else if eqStr t (toList "noopener-allow-popups") then noopenerAllowPopups
  else unsafeNone

coopNamed : Str → Coop
coopNamed s = coopFromToken (just (if eqStr s (toList "same-origin-plus-coep") then toList "same-origin" else s)) true (eqStr s (toList "same-origin-plus-coep"))
