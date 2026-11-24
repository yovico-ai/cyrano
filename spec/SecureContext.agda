{-# OPTIONS --safe #-}
------------------------------------------------------------------------
-- Secure contexts (owner 2026-11-23: random testing — an http page was a
-- secure context through the proxy).
--
-- Through the proxy every document is served over https, so the browser
-- holds every one for a secure context: a page of an http: origin had
-- cookieStore, crypto.subtle, serviceWorker, WebGPU… where directly it has
-- none. A document is a secure context exactly when its original URL is
-- potentially trustworthy (Secure Contexts §3.1, the document's own case:
-- https, wss, a loopback host — Referrer.trustworthy, the same judgment as
-- a cookie's Secure); one that is not loses the secure-context-only surface
-- and reads isSecureContext false. The surface is Chromium's, measured: a
-- table in ts/client/src/native/secure-context.ts, checked against Chromium
-- by secure-context-vs-chromium (a secure page's names minus an insecure
-- page's). Outside the model: a frame's secure context also needs its
-- ancestors' (an insecure frame of a secure page is blocked as mixed
-- content anyway); workers.
------------------------------------------------------------------------

module SecureContext where

open import Data.Bool.Base using (Bool)
open import Url using (Abs)
open import Referrer using (trustworthy)

secureContext : Abs → Bool
secureContext = trustworthy
