{-# OPTIONS --safe #-}
-- The Priority header (RFC 9218) the proxy adds where the browser sent none
-- (Go: proxy/fetch_headers.go chromePriority, ensurePriority).
--
-- Chrome sends Priority over HTTP/2 and HTTP/3 only; a browser reaching the
-- proxy over HTTP/1.1 sends none, while the proxy's own request upstream
-- is HTTP/2 and would lack a header every Chrome request of that kind
-- carries. The value Chrome sends depends on what only the browser knows
-- (a script in the head or the body, async or deferred, an image among the
-- first in the viewport, fetchpriority), so the proxy writes the value of
-- the commonest case, from what the request shows: its Sec-Fetch-Dest,
-- Sec-Fetch-Mode, method and Sec-Purpose. Nothing for a destination not
-- listed (and Chrome itself sends none at urgency 3, not incremental: an
-- async script).
--
-- Checked against Chromium over HTTP/2 (priority-vs-chromium): each row's
-- commonest case sends exactly that value. Known other cases: a script in
-- the body "u=2", async / defer none, the first images "u=2, i", a fetch
-- with priority "low" "i", a no-cors POST from fetch "u=1, i" (a beacon,
-- the commonest no-cors POST, "u=4, i").
module Priority where

open import Data.Bool.Base using (Bool; true; false; _∨_; _∧_; not; if_then_else_)
open import Data.List.Base using (List; []; _∷_; map)
open import Data.Maybe.Base using (Maybe; just; nothing)
open import Data.String.Base using (String; toList)

open import Url using (Str; eqStr; eqLower)

anyOf : Str → List Str → Bool
anyOf s [] = false
anyOf s (x ∷ xs) = eqLower s x ∨ anyOf s xs

words : List String → List Str
words = map toList

-- dest, mode: Sec-Fetch-Dest / -Mode; method; purpose: Sec-Purpose.
priority : Str → Str → Str → Str → Maybe Str
priority dest mode method purpose =
  if anyOf dest (words ("document" ∷ "iframe" ∷ "frame" ∷ "embed" ∷ "object" ∷ [])) then just (toList "u=0, i")
  else if anyOf dest (words ("style" ∷ "font" ∷ [])) then just (toList "u=0")
  else if anyOf dest (words ("script" ∷ "json" ∷ [])) then just (toList "u=1")
  else if anyOf dest (words ("image" ∷ "video" ∷ "audio" ∷ "track" ∷ [])) then just (toList "i")
  else if anyOf dest (words ("worker" ∷ "sharedworker" ∷ "serviceworker" ∷ [])) then just (toList "u=4, i")
  else if eqLower dest (toList "empty") then just (empty′)
  else nothing
  where
  prefetch beacon : Bool
  prefetch = anyOf purpose (words ("prefetch" ∷ []))
  beacon = eqLower mode (toList "no-cors") ∧ eqStr method (toList "POST")
  empty′ : Str
  empty′ = if prefetch ∨ beacon then toList "u=4, i" else toList "u=1, i"
