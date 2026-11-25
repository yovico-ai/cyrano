{-# OPTIONS --safe #-}
-- What the browser's Fetch does with a page's fetch / XHR that crosses
-- origins (WHATWG Fetch, with Chromium's choices where the text leaves
-- room): whether the request carries credentials, the CORS check of its
-- response (§4.9), and which response headers the script then sees
-- (§3.2.6 CORS-safelisted response-header names; the
-- Access-Control-Expose-Headers list).
--
-- Under cyrano every request is same-origin to the browser (they all go to
-- the proxy), so the browser does none of this. The runtime and the proxy
-- do it from the original origins: the client names the requesting
-- context and the credentials decision in the Crn-I / Crn-C request
-- headers, the proxy leaves cookies off a request without credentials and
-- fails (a broken connection) a response the CORS check refuses, and the
-- client shows a cross-origin response's headers through the exposed list.
--
-- A header value here is what Fetch's "get" gives: absent, or the field
-- values, each trimmed of leading and trailing tab and space, joined by
-- ", ". Absent and one empty value decide alike everywhere below, so the
-- oracle writes both as an empty field.
--
-- Checked against Chromium (ts/client/tests/spec/fetch-vs-chromium.test.ts):
-- Access-Control-Expose-Headers is read as the text says (§2.2.2 "extract
-- header list values", #field-name): each field line is split on ",",
-- items are trimmed of space and tab, empty items are skipped, and one item
-- that is not a header name (a token) fails the whole header — no name is
-- then exposed. (A first reading that trimmed all ASCII whitespace and kept
-- any item was refuted by Chromium 147.)
-- Preflights: spec/Preflight.agda. Not modelled: opaque ("no-cors")
-- responses, redirects (the tainted origin "null").
--
-- Implemented by go/src/internal/proxy/cors.go, proxy/cookies.go and
-- ts/client/src/patches/cors.ts, fetch.ts, xhr.ts.
module Fetch where

open import Data.Bool.Base using (Bool; true; false; _∧_; _∨_; not; if_then_else_)
open import Data.Char.Base using (Char)
open import Data.List.Base using (List; []; _∷_; _++_; reverse; map)
open import Data.Maybe.Base using (Maybe; just; nothing)
open import Data.String.Base using (toList)

open import Url

------------------------------------------------------------------------
-- Credentials (Fetch §4.5 "HTTP-network-or-cache fetch", includeCredentials):
-- "include" always, "same-origin" when the request is same-origin with its
-- client, "omit" never. A request without credentials carries no Cookie
-- and its response's Set-Cookie is not stored.

data Credentials : Set where
  credOmit credSameOrigin credInclude : Credentials

includesCredentials : Credentials → Bool → Bool
includesCredentials credOmit       sameOriginReq = false
includesCredentials credSameOrigin sameOriginReq = sameOriginReq
includesCredentials credInclude    sameOriginReq = true

------------------------------------------------------------------------
-- Who runs the protocol. A request goes to the proxy, so the browser runs
-- CORS only where that is cross-origin to it: from a context whose own
-- origin is opaque (a sandboxed document, a data: worker; every other
-- proxied context has the proxy's origin). There the request is as direct
-- to the browser — it sends Origin "null", decides credentials and checks
-- the response itself — and a Crn-I / Crn-C header would make a simple
-- request non-simple: a preflight the page did not cause, which the
-- upstream refuses (Target's PerimeterX frame, 2026-11-19). Elsewhere the
-- runtime names its context where the request crosses original origins,
-- or where the context sends no Referer (a blob: worker).

namesContext : (opaqueCtx cross unreferred : Bool) → Bool
namesContext opaqueCtx cross unreferred = not opaqueCtx ∧ (cross ∨ unreferred)

------------------------------------------------------------------------
-- Header values.

-- What HTTP parsing strips around a field value (RFC 9110 OWS).
isOWS : Char → Bool
isOWS c = is 32 c ∨ is 9 c

trimWith : (Char → Bool) → Str → Str
trimWith p s = reverse (dropWhile p (reverse (dropWhile p s)))

-- Fetch's "get": the values of every field line of that name, in order,
-- joined by ", " (nothing when there is none).
combine : List Str → Maybe Str
combine []       = nothing
combine (v ∷ vs) = just (join (trimWith isOWS v) vs)
  where
  join : Str → List Str → Str
  join acc []       = acc
  join acc (w ∷ ws) = join (acc ++ toList ", " ++ trimWith isOWS w) ws

------------------------------------------------------------------------
-- §4.9 CORS check, for a request from `origin` (its serialization) that
-- does or does not include credentials.

corsCheck : Maybe Str → Maybe Str → Str → Bool → Bool
corsCheck nothing   acac origin cred = false
corsCheck (just ao) acac origin cred =
  if not cred ∧ eqStr ao (toList "*") then true
  else if not (eqStr ao origin) then false
  else if not cred then true
  else trueValue acac
  where
  trueValue : Maybe Str → Bool
  trueValue (just v) = eqStr v (toList "true")
  trueValue nothing  = false

------------------------------------------------------------------------
-- The headers a script sees on a cross-origin ("cors") response: the
-- CORS-safelisted response-header names, the names listed by
-- Access-Control-Expose-Headers, or — without credentials — every header
-- when the list holds "*". Set-Cookie / Set-Cookie2 never (forbidden
-- response-header names).

lowerAll : Str → Str
lowerAll []       = []
lowerAll (c ∷ cs) = lowerAscii c ∷ lowerAll cs

member : Str → List Str → Bool
member x []       = false
member x (y ∷ ys) = eqStr x y ∨ member x ys

safelisted : Str → Bool
safelisted n = member n (map toList
  ("cache-control" ∷ "content-language" ∷ "content-length" ∷ "content-type"
   ∷ "expires" ∷ "last-modified" ∷ "pragma" ∷ []))

forbiddenResponse : Str → Bool
forbiddenResponse n = eqStr n (toList "set-cookie") ∨ eqStr n (toList "set-cookie2")

-- tchar (RFC 9110 §5.6.2): a header name is one or more of these.
isTchar : Char → Bool
isTchar c = isAlpha c ∨ isDigit c ∨ any (λ t → eqChar t c) (toList "!#$%&'*+-.^_`|~")
  where
  eqChar : Char → Char → Bool
  eqChar x y = eqStr (x ∷ []) (y ∷ [])

-- One field line's names, lowercased; nothing when one item is not a name.
lineNames : Str → Maybe (List Str)
lineNames v = go (splitOn (is 44) v)
  where
  go : List Str → Maybe (List Str)
  go []       = just []
  go (i ∷ is′) with trimWith isOWS i | go is′
  ... | []        | rest = rest
  ... | t@(_ ∷ _) | just ns = if all isTchar t then just (lowerAll t ∷ ns) else nothing
  ... | t@(_ ∷ _) | nothing = nothing

-- The names of every Access-Control-Expose-Headers field line; nothing
-- when one line fails.
exposeAll : List Str → Maybe (List Str)
exposeAll []       = just []
exposeAll (l ∷ ls) with lineNames l | exposeAll ls
... | just ns | just rest = just (ns ++ rest)
... | _       | _         = nothing

-- The exposed-name list: empty when there is no line, or one fails.
exposeList : List Str → List Str
exposeList ls with exposeAll ls
... | just ns = ns
... | nothing = []

-- Whether the response header `name` is shown to the script.
exposed : Bool → List Str → Str → Bool
exposed cred expose name =
  not (forbiddenResponse n)
  ∧ (safelisted n ∨ member n listed ∨ (not cred ∧ member (toList "*") listed))
  where
  n : Str
  n = lowerAll name

  listed : List Str
  listed = exposeList expose

------------------------------------------------------------------------
-- The response's type a script sees (Fetch §4.1 main fetch, the filtered
-- responses; Chromium, measured: opaque-response-vs-chromium): of a
-- request to another origin, "cors" in cors mode, "opaque" in no-cors
-- mode — status 0, no status text, no URL, no header, no body (its readers
-- an empty body's); of one to its own origin "basic". (A same-origin-mode
-- request to another origin the browser refuses before any.) Through the
-- proxy every response is basic to the browser: the runtime shows these.

data ReqMode : Set where
  modeCors modeNoCors modeSameOrigin modeNavigate : ReqMode

data RespType : Set where
  basicT corsT opaqueT : RespType

responseType : ReqMode → Bool → RespType
responseType modeCors   true = corsT
responseType modeNoCors true = opaqueT
responseType _          _    = basicT

------------------------------------------------------------------------
-- Chromium blocks a subresource request whose URL carries credentials
-- (user:pass@ — a user alone too; same-origin or not; a frame's
-- navigation too: measured), letting only a top-level navigation through.
-- Through the proxy the userinfo travels inside the proxified path, so the
-- browser saw none and the request loaded (round K): the proxy refuses it,
-- nothing sent. dest: Sec-Fetch-Dest, lowercase.
credentialsBlocked : Bool → Str → Bool
credentialsBlocked userinfo dest = userinfo ∧ not (eqStr dest (toList "document"))
