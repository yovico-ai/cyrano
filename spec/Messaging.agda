{-# OPTIONS --safe #-}
-- postMessage's targetOrigin (HTML "window post message steps"), for
-- windows that all live on the proxy origin (TS: messaging/target-origin.ts
-- delivery). Checked against Chromium: post-message-vs-chromium.
--
-- "*" delivers to any recipient; "/" to one whose origin is the sender's;
-- anything else is parsed as a URL with no base and delivers only when
-- its origin is the recipient's (a mismatch is dropped silently). A parse
-- failure, or an opaque origin (data:, javascript:, a blob: without a
-- tuple origin inside), throws a SyntaxError (Chromium). file: and ftp:
-- URLs have origins of their own (Chromium's standard schemes), equal to
-- no http(s) window's: dropped. An http(s) or
-- ws(s) URL's origin is its scheme, host and port (userinfo, path, query
-- gone); a blob: URL's is that of the URL inside it.
--
-- Under the proxy each window's origin is the proxy's, so the runtime
-- compares the windows' original origins and, delivering, calls the
-- native with the proxy's origin as the targetOrigin.
module Messaging where

open import Data.Bool.Base using (Bool; true; false; _∨_; _∧_; not; if_then_else_)
open import Data.List.Base using (List; []; _∷_; _++_)
open import Data.Maybe.Base using (Maybe; just; nothing)
open import Data.String.Base using (toList)

open import Url using (Str; eqStr; eqLower; preprocess; parse; url; invalid; otherScheme; outside; originText; scheme; auth; hostPort; Parsed)
open import Data.Nat.Base using (ℕ; zero; suc)

data Delivery : Set where
  deliver drop throws : Delivery

data Origin : Set where
  tuple  : Str → Origin
  opaqueO : Origin
  bad    : Origin           -- the URL parser fails
  elsewhere : Origin        -- a file: or ftp: origin

originOfParsed : Parsed → Origin
originOfParsed (url u)     = tuple (originText (scheme u) (hostPort (auth u)))
originOfParsed otherScheme = opaqueO
originOfParsed invalid     = bad
originOfParsed outside     = opaqueO

take drop′ : ℕ → Str → Str
take zero _ = []
take (suc n) [] = []
take (suc n) (c ∷ cs) = c ∷ take n cs
drop′ zero s = s
drop′ (suc n) [] = []
drop′ (suc n) (_ ∷ cs) = drop′ n cs

-- A targetOrigin's origin (blob:, any case, by the URL inside it).
targetOriginOf : Str → Origin
targetOriginOf s =
  if eqLower (take 5 (preprocess s)) (toList "blob:") then inner (parse nothing (drop′ 5 (preprocess s)))
  else if eqLower (take 5 (preprocess s)) (toList "file:") ∨ eqLower (take 4 (preprocess s)) (toList "ftp:") then elsewhere
  else originOfParsed (parse nothing (preprocess s))
  where
  inner : Parsed → Origin
  inner (url u) = tuple (originText (scheme u) (hostPort (auth u)))
  inner _       = opaqueO

-- sender, recipient: the windows' (original) origins, serialized.
delivery : Str → Str → Str → Delivery
delivery sender recipient t =
  if eqStr t (toList "*") then deliver
  else if eqStr t (toList "/") then (if eqStr sender recipient then deliver else drop)
  else byOrigin (targetOriginOf t)
  where
  byOrigin : Origin → Delivery
  byOrigin (tuple o) = if eqStr o recipient then deliver else drop
  byOrigin opaqueO   = throws
  byOrigin bad       = throws
  byOrigin elsewhere = drop

-- A message an EventSource or WebSocket dispatches has the stream URL's
-- origin (HTML: "the origin of the event stream's final URL"; WebSockets:
-- the serialization of the URL's origin) — under the proxy the native
-- gives the proxy's (its wss: one for a socket: round H/K). The runtime
-- gives the origin of the stream's original URL. nothing: no tuple origin
-- (the stream would not have been made).
streamOrigin : Str → Maybe Str
streamOrigin s with originOfParsed (parse nothing (preprocess s))
... | tuple o = just o
... | _       = nothing
