{-# OPTIONS --safe #-}
-- Window error events (TS: ts/client/src/patches/error-events.ts).
--
-- Directly, an error a classic script of another origin throws, the
-- script fetched without CORS, reaches the page muted (HTML "muted
-- errors"): ErrorEvent message "Script error.", filename "", lineno and
-- colno 0, error null — for listeners and window.onerror alike. Through
-- the proxy every script is fetched CORS same-origin, so the browser never
-- mutes one: error reporters got other origins' errors whole (round H).
-- The runtime mutes as the browser would: by the script's original URL
-- against the page's origin, and whether the page asked for CORS (a
-- crossorigin attribute as written, or a module script). An error event
-- not muted names the script's original URL; its line and column are the
-- first frame of the error's stack in that script (checked against
-- Chromium: error-events-vs-chromium).
module ErrorEvents where

open import Data.Bool.Base using (Bool; true; false; not; _∧_)

-- muted sameOrigin cors isModule
muted : Bool → Bool → Bool → Bool
muted sameOrigin cors isModule = not sameOrigin ∧ not cors ∧ not isModule
