{-# OPTIONS --safe #-}
-- Referer-based routing (Go: server.inferOriginFromReferer and the
-- redirect in server.Handler): a request to a bare path on the proxy
-- origin — page code that built its URL from the proxy's location rather
-- than the page's — whose Referer is a proxified http(s) page is sent on
-- to that path on the page's origin: a 307 to its proxified URL.
--
-- Natively the page's code would have resolved the path against its own
-- origin, so the destination stands for that origin with the request's
-- path and query exactly as the browser sent them (no re-parsing: dot
-- segments and escapes stay as written). The Referer is read as `unwrap`
-- reads a proxified URL (Containment.agda): on the proxy's origin, under
-- /cyrano/, its host segment as the browser reads an authority; the
-- origin is its scheme and host:port (userinfo dropped). A Referer that is
-- not that, or a ws(s) one, routes nothing.
module Route where

open import Data.Bool.Base using (Bool; true; false; if_then_else_)
open import Data.List.Base using (List; []; _∷_; _++_)
open import Data.Maybe.Base using (Maybe; just; nothing)
open import Data.String.Base using (toList)

open import Scheme using (Scheme; http; https; ws; wss; schemeChars)
open import Url using (Str; Abs; parse; preprocess; url; scheme; auth; hostPort)
open import Containment using (Proxy; unwrapAbs; original; escapePct; segmentOf)

-- path: the request's path as sent (raw); query: "?…" as sent, or "".
refererRoute : Proxy → Str → Str → Str → Maybe Str
refererRoute p referer path query with parse nothing (preprocess referer)
... | url a with unwrapAbs p a
...   | original t = byScheme (scheme t)
  where
  dest : Abs → Str
  dest u = toList "/cyrano/" ++ schemeChars (scheme u) ++ toList "/" ++ escapePct (segmentOf (hostPort (auth u)))
           ++ escapePct (orRoot path) ++ query
    where
    orRoot : Str → Str
    orRoot [] = toList "/"
    orRoot s  = s
  byScheme : Scheme → Maybe Str
  byScheme http  = just (dest t)
  byScheme https = just (dest t)
  byScheme ws    = nothing
  byScheme wss   = nothing
...   | _ = nothing
refererRoute p referer path query | _ = nothing
