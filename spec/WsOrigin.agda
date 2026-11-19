{-# OPTIONS --safe #-}
-- The page origin a proxied WebSocket URL carries (Go:
-- urlrewrite.WSOriginParam, SplitWSOrigin; TS: patches/websocket.ts
-- withPageOrigin / withoutPageOrigin).
--
-- A WebSocket handshake has no Referer, so the server cannot know which
-- page opened the socket and with it the Origin a direct browser sends.
-- The runtime appends the page's origin as the last query parameter,
--   "__cyrano_ws_origin=" encodeURIComponent(origin)
-- after "&" (the URL has a query) or "?" (it has none); a URL with a
-- fragment is left alone (the browser refuses it). The server takes off
-- the last parameter of that name that ends the query; what is left is
-- the page's query exactly, and whether there was one. ws.url reads the
-- URL without it.
--
-- The encoded origin has no "&", so the parameter the runtime appended is
-- always the last one: the server recovers the page's query and the
-- origin, whatever the page's query holds — including a parameter of that
-- name of its own (split (marked q o) = (q, encodeOrigin o); checked as a
-- property of the spec and of both runtimes: ws-origin conformance).
module WsOrigin where

open import Data.Bool.Base using (Bool; true; false; _∨_; _∧_; not; if_then_else_)
open import Data.Char.Base using (Char; toℕ)
open import Data.List.Base using (List; []; _∷_; _++_; reverse)
open import Data.Maybe.Base using (Maybe; just; nothing)
open import Data.Nat.Base using (ℕ; _≡ᵇ_)
open import Data.Product.Base using (_×_; _,_)
open import Data.String.Base using (toList)

open import Url using (Str; is; isAlpha; isDigit; eqStr; encodeWith)

paramName : Str
paramName = toList "__cyrano_ws_origin"

-- encodeURIComponent's set: all but A–Z a–z 0–9 - _ . ! ~ * ' ( ).
componentSet : Char → Bool
componentSet c = not (isAlpha c ∨ isDigit c ∨ is 45 c ∨ is 95 c ∨ is 46 c ∨ is 33 c ∨ is 126 c ∨ is 42 c ∨ is 39 c ∨ is 40 c ∨ is 41 c)

encodeOrigin : Str → Str
encodeOrigin = encodeWith componentSet

-- The query part the runtime writes after the page's URL: q is the page's
-- query (nothing: no "?").
marked : Maybe Str → Str → Str
marked nothing  o = '?' ∷ paramName ++ '=' ∷ encodeOrigin o
marked (just q) o = '?' ∷ q ++ '&' ∷ paramName ++ '=' ∷ encodeOrigin o

------------------------------------------------------------------------
-- The server's reading, of the query as it comes (without its "?"): the
-- page's query (nothing: it had none), and the origin's encoded text;
-- nothing when no parameter of the name ends the query.

hasAmp : Str → Bool
hasAmp []       = false
hasAmp (c ∷ cs) = is 38 c ∨ hasAmp cs

-- The last "&" splits (before, after); nothing when there is none.
lastAmp : Str → Maybe (Str × Str)
lastAmp s = go (reverse s) []
  where
  go : Str → Str → Maybe (Str × Str)
  go []       acc = nothing
  go (c ∷ cs) acc = if is 38 c then just (reverse cs , acc) else go cs (c ∷ acc)

-- "name=value" with this name: the value.
param : Str → Maybe Str
param s = strip paramName s
  where
  strip : Str → Str → Maybe Str
  strip []       ('=' ∷ v) = just v
  strip []       _         = nothing
  strip (n ∷ ns) (c ∷ cs)  = if (toℕ n ≡ᵇ toℕ c) then strip ns cs else nothing
  strip (n ∷ ns) []        = nothing

split : Str → Maybe (Maybe Str × Str)
split q with lastAmp q
... | just (before , last) with param last
...   | just v  = just (just before , v)
...   | nothing = nothing
split q | nothing with param q
...   | just v  = just (nothing , v)
...   | nothing = nothing
