{-# OPTIONS --safe #-}
-- Cookies, as a direct browser keeps them (RFC 6265bis, "Cookies: HTTP
-- State Management Mechanism", with Chromium's choices where the draft
-- leaves room): reading a Set-Cookie string (§5.6), deciding whether and
-- under what scope it is stored (§5.7), and choosing the cookies for a URL
-- (§5.8.3) — for an HTTP request and for document.cookie.
--
-- Under cyrano every site shares the proxy's origin, so the browser's own
-- scoping (domain, path, Secure) cannot tell sites apart. Cyrano applies
-- the rules itself, from the original URLs:
--
--   * a cookie page scripts may see lives in the browser's own jar — so a
--     script's write is on the next request and a response's Set-Cookie is
--     in document.cookie at once, as natively — under a *wire name* that
--     carries its scope (host-only or domain, domain, path) and a *wire
--     value* that carries its Secure and SameSite flags. Wire name =
--     cookie identity (name, domain, path, host-only), as in the RFC;
--   * `cookiesFor` chooses, from the jar, the cookies for a URL: the
--     client's document.cookie getter and the server's request path are
--     this one function;
--   * an HttpOnly cookie never reaches the browser: the server keeps it,
--     under the same rules.
--
-- Outside the model: the public-suffix list (the caller says whether the
-- Domain attribute is a public suffix), the cookie-date of Expires (kept
-- as written: the browser parses it for its own jar), creation-time order
-- (the jar's own order is kept among equal path lengths), and store-state
-- rules (a non-secure origin overwriting a Secure cookie; jar limits).
--
-- Implemented by go/src/internal/cookies and ts/client/src/cookies/rfc.ts.
module Cookies where

open import Data.Bool.Base using (Bool; true; false; _∧_; _∨_; not; if_then_else_)
open import Data.Char.Base using (Char; toℕ; fromℕ)
open import Data.List.Base using (List; []; _∷_; _++_; reverse; concatMap)
open import Data.Maybe.Base using (Maybe; just; nothing)
open import Data.Nat.Base using (ℕ; zero; suc; _+_; _<ᵇ_; _≤ᵇ_)
open import Data.Product.Base using (_×_; _,_)
open import Data.String.Base using (toList)

open import Scheme
open import Url
open import Referrer using (hostOf; trustworthy)

------------------------------------------------------------------------
-- Strings.

isWSP : Char → Bool
isWSP c = is 32 c ∨ is 9 c

trim : Str → Str
trim s = reverse (dropWhile isWSP (reverse (dropWhile isWSP s)))

lower : Str → Str
lower []       = []
lower (c ∷ cs) = lowerAscii c ∷ lower cs

startsWith : Str → Str → Bool
startsWith []       _        = true
startsWith (_ ∷ _)  []       = false
startsWith (x ∷ xs) (y ∷ ys) = is (toℕ x) y ∧ startsWith xs ys

endsWith : Str → Str → Bool
endsWith suffix s = startsWith (reverse suffix) (reverse s)

len : Str → ℕ
len []       = 0
len (_ ∷ cs) = suc (len cs)

-- Octets of the UTF-8 encoding.
octets : Str → ℕ
octets []       = 0
octets (c ∷ cs) = lenℕ (utf8 (toℕ c)) + octets cs
  where
  lenℕ : List ℕ → ℕ
  lenℕ []       = 0
  lenℕ (_ ∷ xs) = suc (lenℕ xs)

-- A control character other than tab: such a Set-Cookie string is ignored.
isCtl : Char → Bool
isCtl c = ((toℕ c <ᵇ 32) ∧ not (is 9 c)) ∨ is 127 c

------------------------------------------------------------------------
-- §5.6: a Set-Cookie string, read.

data SameSite : Set where
  ssNone ssLax ssStrict ssDefault : SameSite

-- Chromium's Priority attribute (low, medium, high; anything else medium):
-- it decides which cookies a full jar evicts first (CookieJar.agda).
data Priority : Set where
  pLow pMedium pHigh : Priority

record SetCookie : Set where
  constructor mkSet
  field
    name value : Str
    domain     : Maybe Str    -- Domain attribute: lowercased, one leading dot removed
    cpath      : Maybe Str    -- Path attribute, when it starts with "/"
    secure     : Bool
    httpOnly   : Bool
    sameSite   : SameSite
    maxAge     : Maybe Str    -- "-"? DIGIT+, as written
    expires    : Maybe Str    -- as written (read by CookieDate.agda)
    priority   : Priority
open SetCookie public

-- name=value up to the first ";" — no "=" means a nameless cookie.
nameValue : Str → Str × Str
nameValue pair with break (is 61) pair
... | n , []    = [] , trim n
... | n , _ ∷ v = trim n , trim v

validMaxAge : Str → Bool
validMaxAge []       = false
validMaxAge (c ∷ cs) = (isDigit c ∨ (is 45 c ∧ not (isEmpty cs))) ∧ all isDigit cs

priorityOf : Str → Priority
priorityOf v =
  if eqStr (lower v) (toList "low") then pLow
  else if eqStr (lower v) (toList "high") then pHigh
  else pMedium

sameSiteOf : Str → SameSite
sameSiteOf v =
  if eqStr (lower v) (toList "none") then ssNone
  else if eqStr (lower v) (toList "strict") then ssStrict
  else if eqStr (lower v) (toList "lax") then ssLax
  else ssDefault

-- One attribute applied; a later attribute of the same name wins.
applyAttr : Str → SetCookie → SetCookie
applyAttr av c with break (is 61) av
... | an , rest = byName (lower (trim an)) (val rest)
  where
  val : Str → Str
  val []      = []
  val (_ ∷ v) = trim v

  noDot : Str → Str
  noDot []       = []
  noDot (d ∷ ds) = if is 46 d then ds else d ∷ ds

  byName : Str → Str → SetCookie
  byName n v =
    if 1024 <ᵇ octets v then c
    else if eqStr n (toList "expires") then record c { expires = just v }
    -- Chromium: the last Max-Age wins even when it is not a number — the
    -- cookie then has none (the RFC would ignore the invalid attribute).
    else if eqStr n (toList "max-age") then record c { maxAge = (if validMaxAge v then just v else nothing) }
    else if eqStr n (toList "domain") then record c { domain = just (lower (noDot v)) }
    else if eqStr n (toList "path") then
      record c { cpath = (if startsWith (toList "/") v then just v else nothing) }
    else if eqStr n (toList "secure") then record c { secure = true }
    else if eqStr n (toList "httponly") then record c { httpOnly = true }
    else if eqStr n (toList "samesite") then record c { sameSite = sameSiteOf v }
    else if eqStr n (toList "priority") then record c { priority = priorityOf v }
    else c

applyAttrs : List Str → SetCookie → SetCookie
applyAttrs []       c = c
applyAttrs (a ∷ as) c = applyAttrs as (applyAttr a c)

-- Chromium (measured 2026-11-23, cookies-vs-chromium): a tab inside a
-- name, a value, an attribute's name or its value — what is left of it
-- once trimmed — rejects the cookie; at their edges it is trimmed.
tabInside : Str → Bool
tabInside p with break (is 61) p
... | a , []    = any (is 9) (trim a)
... | a , _ ∷ v = any (is 9) (trim a) ∨ any (is 9) (trim v)

parseSetCookie : Str → Maybe SetCookie
parseSetCookie s =
  if any isCtl s ∨ anyPart (splitOn (is 59) s) then nothing else fromParts (splitOn (is 59) s)
  where
  anyPart : List Str → Bool
  anyPart []       = false
  anyPart (p ∷ ps) = tabInside p ∨ anyPart ps

  fromParts : List Str → Maybe SetCookie
  fromParts []           = nothing
  fromParts (pair ∷ avs) with nameValue pair
  ... | n , v =
    if 4096 <ᵇ (octets n + octets v) then nothing
    else just (applyAttrs avs (mkSet n v nothing nothing false false ssDefault nothing nothing pMedium))

------------------------------------------------------------------------
-- §5.1.3, §5.1.4: domain-match, path-match, default-path.

isIPHost : Str → Bool
isIPHost []       = false
isIPHost (c ∷ cs) = is 91 c ∨ endsInNumber (c ∷ cs)

domainMatch : Str → Str → Bool
domainMatch host d =
  eqStr host d ∨ (endsWith (fromℕ 46 ∷ d) host ∧ not (isIPHost host) ∧ not (isEmpty d))

pathMatch : Str → Str → Bool
pathMatch req cp = eqStr req cp ∨ (startsWith cp req ∧ (endsWith (toList "/") cp ∨ nextIsSlash cp req))
  where
  nextIsSlash : Str → Str → Bool
  nextIsSlash []       (r ∷ _)  = is 47 r
  nextIsSlash []       []       = false
  nextIsSlash (_ ∷ _)  []       = false
  nextIsSlash (_ ∷ xs) (_ ∷ rs) = nextIsSlash xs rs

requestPath : Abs → Str
requestPath a = pathText (path a)

-- Up to, not including, the last "/"; "/" when that leaves nothing.
defaultPath : Abs → Str
defaultPath a with splitLast (is 47) (requestPath a)
... | nothing            = toList "/"
... | just ([] , _)      = toList "/"
... | just (c ∷ cs , _)  = c ∷ cs

------------------------------------------------------------------------
-- §5.7: the cookie as stored, or nothing when it is ignored.

record Stored : Set where
  constructor mkStored
  field
    sHostOnly : Bool
    sDomain   : Str
    sPath     : Str
    sName     : Str
    sValue    : Str
    sSecure   : Bool
    sHttpOnly : Bool
    sSameSite : SameSite
    sPriority : Priority
open Stored public

-- `api`: set by a script (document.cookie), not an HTTP response.
-- `publicSuffix`: the Domain attribute is a public suffix.
store : Bool → Bool → Abs → SetCookie → Maybe Stored
store api publicSuffix u c =
  if isEmpty (name c) ∧ isEmpty (value c) then nothing
  else if isEmpty (name c) ∧ (prefixed "__secure-" (value c) ∨ prefixed "__host-" (value c)) then nothing
  else if httpOnly c ∧ api then nothing
  else if secure c ∧ not (trustworthy u) then nothing
  else if isNone (sameSite c) ∧ not (secure c) then nothing
  else if prefixed "__secure-" (name c) ∧ not (secure c) then nothing
  else if prefixed "__host-" (name c) ∧ not (secure c ∧ hostOnly ∧ eqStr thePath (toList "/")) then nothing
  else if not domainOk then nothing
  else just (mkStored hostOnly theDomain thePath (name c) (value c) (secure c) (httpOnly c) (sameSite c) (priority c))
  where
  prefixed : Data.String.Base.String → Str → Bool
  prefixed p s = startsWith (toList p) (lower s)

  isNone : SameSite → Bool
  isNone ssNone = true
  isNone _      = false

  reqHost : Str
  reqHost = hostOf u

  -- The Domain attribute in force: none when absent, empty, or a public
  -- suffix equal to the reqHost (then the cookie is reqHost-only).
  attr : Maybe Str
  attr with domain c
  ... | nothing = nothing
  ... | just [] = nothing
  ... | just d  = if publicSuffix ∧ eqStr d reqHost then nothing else just d

  hostOnly : Bool
  hostOnly with attr
  ... | nothing = true
  ... | just _  = false

  theDomain : Str
  theDomain with attr
  ... | nothing = reqHost
  ... | just d  = d

  domainOk : Bool
  domainOk with attr
  ... | nothing = true
  ... | just d  = not publicSuffix ∧ domainMatch reqHost d

  thePath : Str
  thePath with cpath c
  ... | just p  = p
  ... | nothing = defaultPath u

------------------------------------------------------------------------
-- §5.8.3: is this cookie sent to / shown at this URL?

matches : Bool → Abs → Stored → Bool
matches api u c =
  (if sHostOnly c then eqStr (hostOf u) (sDomain c) else domainMatch (hostOf u) (sDomain c))
  ∧ pathMatch (requestPath u) (sPath c)
  ∧ (not (sSecure c) ∨ trustworthy u)
  ∧ not (sHttpOnly c ∧ api)

-- §5.2 SameSite, for an HTTP request: a cookie that is not SameSite=None
-- goes only on a same-site request — or, when Lax (the default), on a
-- top-level navigation with a safe method. `sameSiteReq`: the request's
-- initiator is same-site with its target, or there is none (the user
-- typed the address). And Chromium's "Lax-allowing-unsafe": a cookie that
-- states no SameSite goes on a top-level navigation of any method (a POST:
-- OIDC form_post, SAML) while it is at most two minutes old (`topNav`,
-- `age` in ms; measured 2026-11-23 — one stated Lax does not).
laxUnsafeWindow : ℕ
laxUnsafeWindow = 120000

sameSiteAllows : SameSite → Bool → Bool → Bool → ℕ → Bool
sameSiteAllows ssNone    sameSiteReq topSafeNav topNav age = true
sameSiteAllows ssStrict  sameSiteReq topSafeNav topNav age = sameSiteReq
sameSiteAllows ssLax     sameSiteReq topSafeNav topNav age = sameSiteReq ∨ topSafeNav
sameSiteAllows ssDefault sameSiteReq topSafeNav topNav age = sameSiteReq ∨ topSafeNav ∨ (topNav ∧ (age ≤ᵇ laxUnsafeWindow))

------------------------------------------------------------------------
-- The wire form: how a script-visible cookie is kept in the browser's jar
-- on the proxy origin.
--
--   name  = "__crn!" (h|d) "!" esc(domain) "!" esc(path) "!" name
--   value = (s|i) (n|l|t|u) ":" value
--
-- esc percent-encodes every character but ALPHA, DIGIT, "." and "-", so
-- an escaped field holds no "!" and the four separators are the first
-- four in the name.

fieldSet : Char → Bool
fieldSet c = not (isAlpha c ∨ isDigit c ∨ is 46 c ∨ is 45 c)

esc : Str → Str
esc = encodeWith fieldSet

bang : Char
bang = fromℕ 33

wirePrefix : Str
wirePrefix = toList "__crn!"

wireName : Stored → Str
wireName c = wirePrefix ++ (if sHostOnly c then 'h' else 'd') ∷ bang ∷ esc (sDomain c)
             ++ bang ∷ esc (sPath c) ++ bang ∷ sName c

sameSiteFlag : SameSite → Char
sameSiteFlag ssNone    = 'n'
sameSiteFlag ssLax     = 'l'
sameSiteFlag ssStrict  = 't'
sameSiteFlag ssDefault = 'u'

wireValue : Stored → Str
wireValue c = (if sSecure c then 's' else 'i') ∷ sameSiteFlag (sSameSite c) ∷ fromℕ 58 ∷ sValue c

-- A jar entry read back; nothing when it is not a cookie cyrano wrote.
unwire : Str → Str → Maybe Stored
unwire n v = if startsWith wirePrefix n then fields (dropN 6 n) else nothing
  where
  dropN : ℕ → Str → Str
  dropN zero    s        = s
  dropN (suc k) []       = []
  dropN (suc k) (_ ∷ s)  = dropN k s

  flagsOf : Str → Maybe (Bool × SameSite × Str)
  flagsOf (s ∷ ss ∷ colon ∷ rest) =
    if not (is 58 colon) ∨ not (is 115 s ∨ is 105 s) then nothing
    else if is 110 ss then just (is 115 s , ssNone , rest)
    else if is 108 ss then just (is 115 s , ssLax , rest)
    else if is 116 ss then just (is 115 s , ssStrict , rest)
    else if is 117 ss then just (is 115 s , ssDefault , rest)
    else nothing
  flagsOf _ = nothing

  build : Bool → Str → Str → Str → Maybe Stored
  build ho d p nm with flagsOf v
  ... | nothing              = nothing
  ... | just (sec , ss , val) = just (mkStored ho (pctDecode d) (pctDecode p) nm val sec false ss pMedium)

  -- hd "!" domain "!" path "!" name
  fields : Str → Maybe Stored
  fields (hd ∷ b ∷ rest) =
    if not (is 33 b) ∨ not (is 104 hd ∨ is 100 hd) then nothing
    else afterDomain (is 104 hd) (break (is 33) rest)
    where
    afterPath : Bool → Str → Str × Str → Maybe Stored
    afterPath ho d (p , _ ∷ nm) = build ho d p nm
    afterPath ho d (p , [])     = nothing

    afterDomain : Bool → Str × Str → Maybe Stored
    afterDomain ho (d , _ ∷ r) = afterPath ho d (break (is 33) r)
    afterDomain ho (d , [])    = nothing
  fields _ = nothing

------------------------------------------------------------------------
-- The cookies for a URL, from the jar as the browser lists it
-- ("n1=v1; n2=v2", in its own order): those that match, longer paths
-- first, the jar's order kept among equal lengths; written "name=value"
-- (a nameless cookie as its value alone), joined by "; ".

jarPairs : Str → List (Str × Str)
jarPairs s = pairs (splitOn (is 59) s)
  where
  one : Str → Str × Str
  one p with break (is 61) (dropWhile isWSP p)
  ... | n , []    = n , []
  ... | n , _ ∷ v = n , v

  pairs : List Str → List (Str × Str)
  pairs []       = []
  pairs (p ∷ ps) = one p ∷ pairs ps

fromJar : List (Str × Str) → List Stored
fromJar []             = []
fromJar ((n , v) ∷ ps) with unwire n v
... | just c  = c ∷ fromJar ps
... | nothing = fromJar ps

keep : Bool → Abs → List Stored → List Stored
keep api u []       = []
keep api u (c ∷ cs) = if matches api u c then c ∷ keep api u cs else keep api u cs

-- Stable insertion sort: longer path first.
byPathLength : List Stored → List Stored
byPathLength []       = []
byPathLength (c ∷ cs) = insert c (byPathLength cs)
  where
  insert : Stored → List Stored → List Stored
  insert x []       = x ∷ []
  insert x (y ∷ ys) = if len (sPath y) <ᵇ len (sPath x) then x ∷ y ∷ ys
                      else if len (sPath x) <ᵇ len (sPath y) then y ∷ insert x ys
                      else x ∷ y ∷ ys

cookieString : List Stored → Str
cookieString []           = []
cookieString (c ∷ [])     = one c
  where
  one : Stored → Str
  one x = if isEmpty (sName x) then sValue x else sName x ++ fromℕ 61 ∷ sValue x
cookieString (c ∷ d ∷ cs) = one c ++ toList "; " ++ cookieString (d ∷ cs)
  where
  one : Stored → Str
  one x = if isEmpty (sName x) then sValue x else sName x ++ fromℕ 61 ∷ sValue x

cookiesFor : Bool → Abs → Str → Str
cookiesFor api u jar = cookieString (byPathLength (keep api u (fromJar (jarPairs jar))))

------------------------------------------------------------------------
-- The Cookie Store API (cookieStore.set / get / getAll / delete), as
-- Chromium has it — not the WHATWG text, whose CookieListItem is only a
-- name and a value. Checked against Chrome over https
-- (cookie-store-vs-chromium).
--
-- set({name, value, domain?, path?, sameSite, expires?}) at `u`, in the
-- order Chromium checks, each failure a TypeError of its own message.
-- Two generations differ (`later`: Chromium 147, as against Chrome 139;
-- the runtime tells them apart by how the native words "=" in a name):
--   * an empty name with "=" in the value; an empty name and value;
--     (later) "=" in the name;
--   * a domain on a "__Host-" name (later: the prefix in any case); a
--     domain starting with "."; a domain the host does not domain-match
--     (ASCII case-insensitively) — later, nor a public suffix;
--   * a "__Host-" name with another path than "/"; a path not starting
--     with "/"; a path not ending in "/" gains one (no path: "/");
--   * then the cookie as an RFC store would take it, always Secure, or
--     "malformed": a control character or TAB or ";" in the name or value,
--     space or TAB at either end of either, "=" in the name, name and
--     value over 4096 octets, a path or domain over 1024, and every
--     refusal of `store` (139: a public suffix; the prefixes).
-- A cookie whose expiry is past is not stored (no error); expiry and
-- `partitioned` are the browser's, outside the model.
--
-- get / getAll list the script-visible cookies for `u` as document.cookie
-- does (`keep`, `byPathLength`), those of a name when one is given, each
-- an item of name, value, domain (none for a host-only cookie), path,
-- sameSite (a cookie that set none reads "lax") and secure.
-- delete(name, domain?, path?) removes the cookie a set of those would
-- write (its identity), after the same checks.

data StoreErr : Set where
  emptyNameEq emptyBoth nameEq hostDomain domainDot domainMismatch pathSlash hostPath malformed : StoreErr

data StoreResult : Set where
  rejected : StoreErr → StoreResult
  stored   : Stored → StoreResult

record StoreSet : Set where
  constructor mkStoreSet
  field
    oName oValue : Str
    oDomain      : Maybe Str
    oPath        : Maybe Str
    oSameSite    : SameSite
open StoreSet public

private
  anyC : (Char → Bool) → Str → Bool
  anyC p []       = false
  anyC p (c ∷ cs) = p c ∨ anyC p cs

  edgeWS : Str → Bool
  edgeWS []       = false
  edgeWS (c ∷ cs) = isWSP c ∨ endWS (c ∷ cs)
    where
    endWS : Str → Bool
    endWS s with reverse s
    ... | []      = false
    ... | (d ∷ _) = isWSP d

  hostPrefixed : Bool → Str → Bool
  hostPrefixed later n = if later then startsWith (toList "__host-") (lower n) else startsWith (toList "__Host-") n

  badChar : Char → Bool
  badChar c = isCtl c ∨ is 9 c ∨ is 59 c

cookieStoreSet : Bool → Bool → Abs → StoreSet → StoreResult
cookieStoreSet later ps u o =
  if isEmpty n ∧ anyC (is 61) v then rejected emptyNameEq
  else if isEmpty n ∧ isEmpty v then rejected emptyBoth
  else if later ∧ anyC (is 61) n then rejected nameEq
  else byDomain (oDomain o)
  where
  n v : Str
  n = oName o
  v = oValue o

  final : Str → StoreResult
  final p with anyC badChar n ∨ anyC badChar v ∨ edgeWS n ∨ edgeWS v ∨ anyC (is 61) n
               ∨ (4096 <ᵇ octets n + octets v) ∨ (1024 <ᵇ octets p) ∨ longDomain (oDomain o)
    where
    longDomain : Maybe Str → Bool
    longDomain (just d) = 1024 <ᵇ octets d
    longDomain nothing  = false
  ... | true  = rejected malformed
  ... | false with store true ps u (mkSet n v (lowered (oDomain o)) (just p) true false (oSameSite o) nothing nothing pMedium)
    where
    lowered : Maybe Str → Maybe Str
    lowered (just d) = just (lower d)
    lowered nothing  = nothing
  ...   | nothing = rejected malformed
  ...   | just c  = stored c

  byPath : Maybe Str → StoreResult
  byPath nothing   = final (toList "/")
  byPath (just []) = final (toList "/")
  byPath (just (c ∷ cs)) =
    if hostPrefixed later n ∧ not (eqStr (c ∷ cs) (toList "/")) then rejected hostPath
    else if not (is 47 c) then rejected pathSlash
    else final (if endsWith (toList "/") (c ∷ cs) then c ∷ cs else (c ∷ cs) ++ toList "/")

  byDomain : Maybe Str → StoreResult
  byDomain nothing  = byPath (oPath o)
  byDomain (just d) =
    if hostPrefixed later n then rejected hostDomain
    else if startsWith (toList ".") d then rejected domainDot
    else if not (domainMatch (hostOf u) (lower d)) then rejected domainMismatch
    else if later ∧ ps ∧ not (eqStr (lower d) (hostOf u)) then rejected domainMismatch
    else byPath (oPath o)

-- What delete removes: the cookie a set of that name, domain and path
-- would write (its value is not part of its identity).
cookieStoreDelete : Bool → Bool → Abs → Str → Maybe Str → Maybe Str → StoreResult
cookieStoreDelete later ps u n d p = cookieStoreSet later ps u (mkStoreSet n (toList "x") d p ssStrict)

-- get / getAll.
cookieStoreQuery : Abs → Maybe Str → Str → List Stored
cookieStoreQuery u name jar = byName name (byPathLength (keep true u (fromJar (jarPairs jar))))
  where
  byName : Maybe Str → List Stored → List Stored
  byName nothing  cs       = cs
  byName (just m) []       = []
  byName (just m) (c ∷ cs) = if eqStr (sName c) m then c ∷ byName (just m) cs else byName (just m) cs

itemSameSite : SameSite → Str
itemSameSite ssNone    = toList "none"
itemSameSite ssLax     = toList "lax"
itemSameSite ssStrict  = toList "strict"
itemSameSite ssDefault = toList "lax"

-- A WebSocket's handshake carries the cookies of its URL's http(s)
-- equivalent (RFC 6265bis: ws as http, wss as https — Secure ones over
-- wss), selected as for any request from the proxy's jars, SameSite judged
-- against the page that opened it; never the browser's Cookie header as it
-- came, which holds every proxied site's cookies and the proxy's own
-- (foxnews.com; Go: proxy.WebSocketCookies, TestE2E_WebSocketCookies).
socketCookieScheme : Scheme → Scheme
socketCookieScheme ws  = http
socketCookieScheme wss = https
socketCookieScheme s   = s
