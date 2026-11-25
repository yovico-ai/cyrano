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
open import Containment using (Proxy; unwrapAbs; original; escapePct; segmentOf; sameOrigin; rewriteAbsWith; noMark; Answer; emit; keep; silent)

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


------------------------------------------------------------------------
-- The navigation net (TS: patches/navigation.ts): the other half of the
-- same safety. A navigation this document starts — a location assignment
-- the rules did not see (`window[k] = url`, a setTimeout string, a
-- javascript: URL's code), a meta refresh a script built, a link or form
-- that escaped rewriting — whose destination is an http(s) URL off the
-- proxy's origin is stopped before it leaves (the Navigation API's
-- navigate event, cancelable for every navigation a document starts) and
-- made to the destination's proxified URL instead. A destination on the
-- proxy's origin is left alone: already proxified, the proxy's own pages,
-- or a bare path the server routes by Referer (above).
--
-- Because of it the rules leave the target of a plain `=` as written
-- (spec/js-rewrite R3, R5): `obj[k] = function(){}` keeps the name V8
-- infers for it from its target, `obj.<computed>` — rewritten, its stack
-- frames read `$rewriter.wrap_member_expression`.
netDestination : Proxy → Str → Maybe Str
netDestination p dest with parse nothing (preprocess dest)
... | url a = if sameOrigin p a then nothing else byScheme (scheme a)
  where
  byAnswer : Answer → Maybe Str
  byAnswer (emit _ s) = just s
  byAnswer (keep _)   = nothing
  byAnswer silent     = nothing
  -- (A document does not navigate to a WebSocket URL.)
  byScheme : Scheme → Maybe Str
  byScheme http  = byAnswer (rewriteAbsWith p noMark a)
  byScheme https = byAnswer (rewriteAbsWith p noMark a)
  byScheme ws    = nothing
  byScheme wss   = nothing
... | _ = nothing

------------------------------------------------------------------------
-- Whether the page may intercept a navigation (Navigation API
-- NavigateEvent.canIntercept; HTML "can have its URL rewritten", for an
-- http(s) document): the destination's scheme, userinfo, host and port
-- are the document's — path, query and fragment may differ (measured,
-- Chromium). Through the proxy the browser compares two proxified URLs,
-- always same-origin: a link to another site was interceptable and a
-- router kept it in-page (round K). The runtime decides on the original
-- URLs (patches/navigation.ts); where this is false, intercept() throws
-- Chromium's SecurityError.
canIntercept : Abs → Str → Bool
canIntercept doc target with parse (just doc) (preprocess target)
... | url t = Url.sameScheme (scheme doc) (scheme t) ∧ Url.eqStr (auth doc) (auth t)
  where open import Data.Bool.Base using (_∧_)
... | _ = false
