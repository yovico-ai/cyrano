{-# OPTIONS --safe #-}
------------------------------------------------------------------------
-- window.originAgentCluster (HTML "origin-keyed agent clusters";
-- Chromium, measured: origin-agent-cluster-vs-chromium). Within a
-- browsing context group the first document of an origin decides for
-- every later one of that origin: a header that reads `?0` keys it by
-- site (false), any other value or none by origin (true); a document that
-- is not a secure context reads false. Through the proxy every site is
-- the proxy's origin, so the first proxied document decided for all of
-- them (a popup of another site read its opener's ?0: round K). The
-- runtime keeps the table by original origin (the group's documents
-- share it).
------------------------------------------------------------------------

module Oac where

open import Data.Bool.Base using (Bool; true; false; _∧_; not)
open import Data.Maybe.Base using (Maybe; just; nothing)
open import Data.String.Base using (toList)

open import Url using (Str; eqStr)

-- A document's own choice: secure context, its header's value (nothing:
-- none).
own : Bool → Maybe Str → Bool
own secure nothing  = secure
own secure (just v) = secure ∧ not (eqStr v (toList "?0"))

-- What it reads: the group's recorded value for its origin, else its own.
reads : Maybe Bool → Bool → Maybe Str → Bool
reads (just r) _ _ = r
reads nothing secure h = own secure h
