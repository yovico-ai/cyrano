{-# OPTIONS --safe #-}
-- Content Security Policy as cyrano hands it to the browser: how a policy
-- is read (CSP3 §2.2.1 "parse a serialized CSP", §2.2.2 for a header's
-- comma-separated list) and how it is translated for the proxy.
--
-- Every resource of a proxied page is fetched from the proxy origin, so an
-- origin's policy that lists hosts would block the page's own (rewritten)
-- resources, and the runtime's inline bootstrap needs to run where the
-- page's inline scripts may. The translation *weakens* the policy — it does
-- not translate host-sources to proxied path prefixes (known gap, CLAUDE.md):
--
--   * report-uri / report-to are dropped (reports would leave the proxy);
--   * on a plain-http proxy, upgrade-insecure-requests and
--     block-all-mixed-content are dropped (they would upgrade or block every
--     proxied load);
--   * trusted-types: 'none' is dropped and the runtime's own policy name is
--     admitted beside the page's (unless "*" admits it already);
--   * a fetch directive (CSP3 §6.1) gets the proxy origin, unless it is
--     exactly 'none' or already lists it;
--   * a script/style directive (and default-src) with a hash source: the
--     rewritten inline scripts cannot match their hashes, and a hash makes
--     the browser ignore 'unsafe-inline' — its nonces, hashes and
--     'strict-dynamic' are dropped and 'unsafe-inline' and 'self' added.
--     Without a hash, nonces and 'strict-dynamic' stay (the bootstrap is
--     given the nonce: scriptNonce).
--
-- Output is canonical: directives "name value…" joined by "; ", a header's
-- policies by ", ". Directive names come out lowercase; a later duplicate of
-- a directive (which the browser ignores) is left out.
--
-- Framing (frame-ancestors, CSP3 §6.4.2; X-Frame-Options, HTML "check a
-- navigation response's adherence to X-Frame-Options"): under the proxy
-- the browser sees one origin, so the proxy judges a framed document for
-- its embedder and tells the browser the verdict. Only the immediate
-- embedder is judged (natively every ancestor).
--
-- Implemented by go/src/internal/urlrewrite/csp.go (RewriteCSP,
-- ScriptNonce, InlineScriptAllowed, FrameAncestors, XFrameOptionsAllows)
-- and ts/client/src/patches/html-rewriter.ts (rewriteCspContent, for
-- <meta http-equiv>).
module Csp where

open import Data.Bool.Base using (Bool; true; false; _∧_; _∨_; not; if_then_else_)
open import Data.Char.Base using (Char; toℕ)
open import Data.List.Base using (List; []; _∷_; _++_; reverse; map)
open import Data.Maybe.Base using (Maybe; just; nothing)
open import Data.Nat.Base using (ℕ; zero; suc; _<ᵇ_; _≡ᵇ_)
open import Data.Product.Base using (_×_; _,_)
open import Data.String.Base using (String; toList)

open import Scheme using (Scheme; schemeChars; defaultPort; http; https)
open import Url
open import Referrer using (hostOf; sameOriginOf)

------------------------------------------------------------------------
-- Reading (CSP3 §2.2.1).

isAsciiWS : Char → Bool
isAsciiWS c = is 9 c ∨ is 10 c ∨ is 12 c ∨ is 13 c ∨ is 32 c

isAsciiChar : Char → Bool
isAsciiChar c = toℕ c <ᵇ 128

lowerAll : Str → Str
lowerAll []       = []
lowerAll (c ∷ cs) = lowerAscii c ∷ lowerAll cs

-- Split on ASCII whitespace, dropping the empty pieces.
words : Str → List Str
words s = drop (splitOn isAsciiWS s)
  where
  drop : List Str → List Str
  drop []       = []
  drop ([] ∷ ws) = drop ws
  drop (w@(_ ∷ _) ∷ ws) = w ∷ drop ws

Directive : Set
Directive = Str × List Str

member : Str → List Str → Bool
member x []       = false
member x (y ∷ ys) = eqStr x y ∨ member x ys

-- A policy's directives, in order: a token that is empty or not ASCII is
-- skipped, the name is lowercased, a name already seen is skipped.
parsePolicy : Str → List Directive
parsePolicy s = go [] (splitOn (is 59) s)
  where
  go : List Str → List Str → List Directive
  go seen []       = []
  go seen (t ∷ ts) with words t
  ... | []        = go seen ts
  ... | n ∷ vals  =
    if not (all isAsciiChar t) ∨ member (lowerAll n) seen then go seen ts
    else (lowerAll n , vals) ∷ go (lowerAll n ∷ seen) ts

-- A header's value: a comma-separated list of policies (§2.2.2); a
-- <meta http-equiv> content is one policy.
parseHeader : Str → List (List Directive)
parseHeader s = map parsePolicy (splitOn (is 44) s)

------------------------------------------------------------------------
-- Translating.

-- CSP3 §6.1 fetch directives.
fetchDirective : Str → Bool
fetchDirective n = member n (map toList
  ( "child-src" ∷ "connect-src" ∷ "default-src" ∷ "fenced-frame-src" ∷ "font-src"
  ∷ "frame-src" ∷ "img-src" ∷ "manifest-src" ∷ "media-src" ∷ "object-src"
  ∷ "prefetch-src" ∷ "script-src" ∷ "script-src-elem" ∷ "script-src-attr"
  ∷ "style-src" ∷ "style-src-elem" ∷ "style-src-attr" ∷ "worker-src" ∷ []))

scriptOrStyle : Str → Bool
scriptOrStyle n = member n (map toList
  ( "default-src" ∷ "script-src" ∷ "script-src-elem" ∷ "script-src-attr"
  ∷ "style-src" ∷ "style-src-elem" ∷ "style-src-attr" ∷ []))

prefixCI : Str → Str → Bool
prefixCI p s = startsWithL (lowerAll p) (lowerAll s)
  where
  startsWithL : Str → Str → Bool
  startsWithL []       _        = true
  startsWithL (_ ∷ _)  []       = false
  startsWithL (a ∷ as) (b ∷ bs) = eqStr (a ∷ []) (b ∷ []) ∧ startsWithL as bs

hashSource : Str → Bool
hashSource t = prefixCI (toList "'sha256-") t ∨ prefixCI (toList "'sha384-") t ∨ prefixCI (toList "'sha512-") t

isNonce : Str → Bool
isNonce t = prefixCI (toList "'nonce-") t

memberCI : Str → List Str → Bool
memberCI x ys = member (lowerAll x) (map lowerAll ys)

anyL : (Str → Bool) → List Str → Bool
anyL p []       = false
anyL p (x ∷ xs) = p x ∨ anyL p xs

filterL : (Str → Bool) → List Str → List Str
filterL p []       = []
filterL p (x ∷ xs) = if p x then x ∷ filterL p xs else filterL p xs

appendIfAbsent : Str → List Str → List Str
appendIfAbsent t vs = if memberCI t vs then vs else vs ++ (t ∷ [])

-- The hash fallback of a script/style directive.
unhash : List Str → List Str
unhash vs =
  appendIfAbsent (toList "'self'")
    (appendIfAbsent (toList "'unsafe-inline'")
      (filterL (λ t → not (hashSource t ∨ isNonce t ∨ eqStr (lowerAll t) (toList "'strict-dynamic'"))) vs))

noneOnly : List Str → Bool
noneOnly (t ∷ []) = eqStr (lowerAll t) (toList "'none'")
noneOnly _        = false

-- The proxy origin and the runtime's Trusted Types policy name.
record CspProxy : Set where
  field
    origin   : Str
    ttPolicy : Str
    plainHttp : Bool
open CspProxy

translateDirective : CspProxy → Directive → Maybe Directive
translateDirective p (n , vs) =
  if eqStr n (toList "report-uri") ∨ eqStr n (toList "report-to") then nothing
  else if plainHttp p ∧ (eqStr n (toList "upgrade-insecure-requests") ∨ eqStr n (toList "block-all-mixed-content")) then nothing
  else if eqStr n (toList "trusted-types") then just (n , tt)
  else if fetchDirective n then just (n , withProxy hashed)
  else just (n , vs)
  where
  tt : List Str
  tt = let kept = filterL (λ t → not (eqStr (lowerAll t) (toList "'none'"))) vs
       in if isEmpty (ttPolicy p) ∨ member (ttPolicy p) kept ∨ member (toList "*") kept then kept else kept ++ (ttPolicy p ∷ [])

  hashed : List Str
  hashed = if scriptOrStyle n ∧ anyL hashSource vs then unhash vs else vs

  -- (No proxy origin — a caller that has none — adds nothing.)
  withProxy : List Str → List Str
  withProxy ws = if noneOnly ws ∨ isEmpty (origin p) then ws else appendIfAbsent (origin p) ws

translatePolicy : CspProxy → List Directive → List Directive
translatePolicy p []       = []
translatePolicy p (d ∷ ds) with translateDirective p d
... | just d′ = d′ ∷ translatePolicy p ds
... | nothing = translatePolicy p ds

------------------------------------------------------------------------
-- Writing.

joinWith : Str → List Str → Str
joinWith sep []           = []
joinWith sep (x ∷ [])     = x
joinWith sep (x ∷ y ∷ xs) = x ++ sep ++ joinWith sep (y ∷ xs)

showDirective : Directive → Str
showDirective (n , vs) = joinWith (toList " ") (n ∷ vs)

showPolicy : List Directive → Str
showPolicy ds = joinWith (toList "; ") (map showDirective ds)

-- A <meta http-equiv="Content-Security-Policy"> content.
translateMeta : CspProxy → Str → Str
translateMeta p s = showPolicy (translatePolicy p (parsePolicy s))

-- A Content-Security-Policy (or -Report-Only) header value.
translateHeader : CspProxy → Str → Str
translateHeader p s = joinWith (toList ", ") (map (λ pol → showPolicy (translatePolicy p pol)) (parseHeader s))

------------------------------------------------------------------------
-- What the bootstrap needs of the policies of a response (header values,
-- as the origin sent them; report-only ones are not passed).

-- The directive that governs script elements: script-src-elem, else
-- script-src, else default-src.
governing : List Directive → Maybe (List Str)
governing ds = pick (toList "script-src-elem" ∷ toList "script-src" ∷ toList "default-src" ∷ [])
  where
  find : Str → List Directive → Maybe (List Str)
  find n []              = nothing
  find n ((m , vs) ∷ xs) = if eqStr n m then just vs else find n xs

  pick : List Str → Maybe (List Str)
  pick []       = nothing
  pick (n ∷ ns) with find n ds
  ... | just vs = just vs
  ... | nothing = pick ns

-- The value of a well-formed nonce source ('nonce-…').
nonceValue : Str → Maybe Str
nonceValue t = if isNonce t then strip (dropN 7 t) else nothing
  where
  dropN : ℕ → Str → Str
  dropN zero    s        = s
  dropN (suc k) []       = []
  dropN (suc k) (_ ∷ cs) = dropN k cs

  strip : Str → Maybe Str
  strip s with reverse s
  ... | c ∷ rs = if eqStr (c ∷ []) (toList "'") then just (reverse rs) else nothing
  ... | []     = nothing

-- The nonce the bootstrap script needs: the first nonce of the governing
-- directive of the first policy that has one (a governing directive
-- without a nonce settles its policy: the next is asked).
scriptNonce : List Str → Maybe Str
scriptNonce headers = overPolicies (concatPolicies headers)
  where
  concatPolicies : List Str → List (List Directive)
  concatPolicies []       = []
  concatPolicies (h ∷ hs) = parseHeader h ++ concatPolicies hs

  firstNonce : List Str → Maybe Str
  firstNonce []       = nothing
  firstNonce (t ∷ ts) with nonceValue t
  ... | just v  = just v
  ... | nothing = firstNonce ts

  overPolicies : List (List Directive) → Maybe Str
  overPolicies []       = nothing
  overPolicies (ds ∷ dss) with governing ds
  ... | nothing = overPolicies dss
  ... | just vs with firstNonce vs
  ...   | just v  = just v
  ...   | nothing = overPolicies dss

-- Whether an inline <script> runs under every policy once translated: the
-- governing directive (if any) has 'unsafe-inline', a nonce (the bootstrap
-- gets it) or a hash (translated to 'unsafe-inline').
inlineScriptAllowed : List Str → Bool
inlineScriptAllowed headers = allP (concatPolicies headers)
  where
  concatPolicies : List Str → List (List Directive)
  concatPolicies []       = []
  concatPolicies (h ∷ hs) = parseHeader h ++ concatPolicies hs

  admits : Str → Bool
  admits t = eqStr (lowerAll t) (toList "'unsafe-inline'") ∨ isNonce t ∨ hashSource t

  allP : List (List Directive) → Bool
  allP []         = true
  allP (ds ∷ dss) with governing ds
  ... | nothing = allP dss
  ... | just vs = anyL admits vs ∧ allP dss

-- Whether no page script runs at all under the policies (header values as
-- sent; report-only ones not passed): some policy's script-element
-- directive (script-src-elem, else script-src, else default-src) and some
-- policy's attribute directive (script-src-attr, else script-src, else
-- default-src) each allow nothing. An element directive allows nothing
-- when none of its tokens is a source (only 'none', 'unsafe-eval',
-- 'wasm-unsafe-eval', 'report-sample', 'unsafe-hashes',
-- 'inline-speculation-rules', or no token) — under 'strict-dynamic', when
-- it has no nonce or hash; an attribute directive — inline
-- handlers — unless it has 'unsafe-inline' and no nonce, hash or
-- 'strict-dynamic', or 'unsafe-hashes' and a hash. Then the
-- document needs no runtime (nothing of the page's reads anything), and
-- gets none: natively it runs no script, and neither does it proxied.
-- It is sound, not complete, over several policies: a script must pass
-- each, so two that admit different scripts (one a nonce, one a hash)
-- may together admit none, which this does not see — the runtime is then
-- injected, needlessly. Checked against Chromium (no-scripts-vs-chromium):
-- exact for one policy; for two, "none" here is none there.
noScriptsRun : List Str → Bool
noScriptsRun headers = anyP elem pols ∧ anyP attr pols
  where
  pols : List (List Directive)
  pols = concatPolicies headers
    where
    concatPolicies : List Str → List (List Directive)
    concatPolicies []       = []
    concatPolicies (h ∷ hs) = parseHeader h ++ concatPolicies hs

  find : Str → List Directive → Maybe (List Str)
  find n []              = nothing
  find n ((m , vs) ∷ xs) = if eqStr n m then just vs else find n xs

  pick : List Directive → List Str → Maybe (List Str)
  pick ds []       = nothing
  pick ds (n ∷ ns) with find n ds
  ... | just vs = just vs
  ... | nothing = pick ds ns

  kw : String → Str → Bool
  kw k t = eqStr (lowerAll t) (toList k)

  noSource : Str → Bool
  noSource t = kw "'none'" t ∨ kw "'unsafe-eval'" t ∨ kw "'wasm-unsafe-eval'" t ∨ kw "'report-sample'" t
             ∨ kw "'unsafe-hashes'" t ∨ kw "'inline-speculation-rules'" t

  -- under 'strict-dynamic' only a nonce or a hash admits a script
  elemNothing : Maybe (List Str) → Bool
  elemNothing (just vs) =
    if anyL (kw "'strict-dynamic'") vs then not (anyL (λ t → isNonce t ∨ hashSource t) vs)
    else not (anyL (λ t → not (noSource t)) vs)
  elemNothing nothing   = false

  attrNothing : Maybe (List Str) → Bool
  attrNothing (just vs) = not ((anyL (kw "'unsafe-inline'") vs ∧ not (anyL (λ t → isNonce t ∨ hashSource t ∨ kw "'strict-dynamic'" t) vs))
                               ∨ (anyL (kw "'unsafe-hashes'") vs ∧ anyL hashSource vs))
  attrNothing nothing   = false

  elem attr : List Directive → Bool
  elem ds = elemNothing (pick ds (toList "script-src-elem" ∷ toList "script-src" ∷ toList "default-src" ∷ []))
  attr ds = attrNothing (pick ds (toList "script-src-attr" ∷ toList "script-src" ∷ toList "default-src" ∷ []))

  anyP : (List Directive → Bool) → List (List Directive) → Bool
  anyP f []         = false
  anyP f (ds ∷ dss) = f ds ∨ anyP f dss

------------------------------------------------------------------------
-- Source expressions against an ancestor's origin (CSP3 §6.7.2.8–9), for
-- frame-ancestors: the URL matched is the ancestor origin's serialization,
-- so its path is "/" and it has no query.

-- scheme-part matching: an expression's scheme also admits its secure
-- upgrade. Chromium's rule (services/network csp_source.cc), checked by
-- framing-vs-chromium: "http" admits "https", "ws" admits "wss". (CSP3
-- §6.7.2.9 would also let "ws" admit http(s); Chromium 147 does not.)
schemePartMatch : Str → Scheme → Bool
schemePartMatch a b =
  eqStr a bs
  ∨ (eqStr a (toList "http") ∧ eqStr bs (toList "https"))
  ∨ (eqStr a (toList "ws") ∧ eqStr bs (toList "wss"))
  where
  bs : Str
  bs = schemeChars b

-- The explicit port of a canonical URL (none when it is the scheme's default).
portOf : Abs → Maybe Str
portOf a = after (hostPort (auth a))
  where
  -- what follows the host: "[…]" or up to the last ':'.
  afterColon : Str → Maybe Str
  afterColon []       = nothing
  afterColon (c ∷ cs) = if is 58 c then just cs else afterColon cs

  after : Str → Maybe Str
  after s with hostOf a
  ... | h = afterColon (dropN h s)
    where
    dropN : Str → Str → Str
    dropN []       t        = t
    dropN (_ ∷ xs) []       = []
    dropN (_ ∷ xs) (_ ∷ ys) = dropN xs ys

isSchemeStart : Char → Bool
isSchemeStart = isAlpha

isSchemeCharCsp : Char → Bool
isSchemeCharCsp c = isAlpha c ∨ isDigit c ∨ is 43 c ∨ is 45 c ∨ is 46 c

-- "scheme:" alone (scheme-source).
schemeSource : Str → Maybe Str
schemeSource s with reverse s
... | c ∷ rs = if is 58 c then (body (reverse rs)) else nothing
  where
  body : Str → Maybe Str
  body []       = nothing
  body (d ∷ ds) = if isSchemeStart d ∧ all isSchemeCharCsp ds then just (d ∷ ds) else nothing
... | []     = nothing

record HostSource : Set where
  field
    hsScheme : Maybe Str
    hsHost   : Str
    hsPort   : Maybe Str
    hsPath   : Str
open HostSource

-- [ scheme "://" ] host [ ":" port ] [ path ], lowercased; nothing when
-- the host is empty or a part holds what its grammar does not.
hostSource : Str → Maybe HostSource
hostSource s with splitScheme s
  where
  splitScheme : Str → Maybe Str × Str
  splitScheme t = find [] t
    where
    find : Str → Str → Maybe Str × Str
    find acc []                     = nothing , t
    find acc (':' ∷ '/' ∷ '/' ∷ rest) = just (reverse acc) , rest
    find acc (c ∷ rest)             = if isSchemeCharCsp c then find (c ∷ acc) rest else (nothing , t)
... | (sch , rest) with break (λ c → is 58 c ∨ is 47 c) rest
...   | (h , tl) = build h (portAndPath tl)
  where
  portAndPath : Str → Maybe (Maybe Str) × Str
  portAndPath (':' ∷ more) with break (is 47) more
  ... | (pt , path) = (if isEmpty pt then nothing else
                        if eqStr pt (toList "*") ∨ all isDigit pt then just (just pt) else nothing) , path
  portAndPath other = just nothing , other

  hostChar : Char → Bool
  hostChar c = isAlpha c ∨ isDigit c ∨ is 45 c ∨ is 46 c ∨ is 42 c

  schemeOK : Maybe Str → Bool
  schemeOK (just []) = false
  schemeOK (just (c ∷ cs)) = isAlpha c
  schemeOK nothing = true

  build : Str → Maybe (Maybe Str) × Str → Maybe HostSource
  build h (just pt , path) =
    if isEmpty h ∨ not (all hostChar h) ∨ not (schemeOK sch) then nothing
    else just (record { hsScheme = lowerM sch ; hsHost = lowerAll h ; hsPort = pt ; hsPath = path })
    where
    lowerM : Maybe Str → Maybe Str
    lowerM (just x) = just (lowerAll x)
    lowerM nothing  = nothing
  build h (nothing , _) = nothing

-- host-part matching: "*" alone matches any host, "*.x" a proper
-- subdomain of x, otherwise ASCII case-insensitive equality.
hostPartMatch : Str → Str → Bool
hostPartMatch ('*' ∷ []) host = true
hostPartMatch ('*' ∷ rest) host = endsWithL rest (lowerAll host)
  where
  endsWithL : Str → Str → Bool
  endsWithL suf h = startsWithR (reverse suf) (reverse h)
    where
    startsWithR : Str → Str → Bool
    startsWithR []       _        = true
    startsWithR (_ ∷ _)  []       = false
    startsWithR (a ∷ as) (b ∷ bs) = eqStr (a ∷ []) (b ∷ []) ∧ startsWithR as bs
hostPartMatch pat host = eqStr pat (lowerAll host)

portPartMatch : Maybe Str → Abs → Bool
portPartMatch nothing  u = isNothing (portOf u)
  where
  isNothing : Maybe Str → Bool
  isNothing nothing  = true
  isNothing (just _) = false
portPartMatch (just p) u =
  eqStr p (toList "*") ∨ same (portOf u)
  where
  same : Maybe Str → Bool
  same (just q) = digitsValue p ≡ᵇ digitsValue q
  same nothing  = digitsValue p ≡ᵇ defaultPort (scheme u)

-- The url's path is "/": a path-part matches it when empty or "/".
pathPartMatchRoot : Str → Bool
pathPartMatchRoot p = isEmpty p ∨ eqStr p (toList "/")

httpLike : Scheme → Bool
httpLike http  = true
httpLike https = true
httpLike _     = false

-- 'self' (§6.7.2.8 step for 'self'): the same origin, or the same host and
-- port (or default ports) with a secure (or same, http) scheme.
selfMatch : Abs → Abs → Bool
selfMatch self u =
  sameOriginOf self u
  ∨ (eqStr (lowerAll (hostOf self)) (lowerAll (hostOf u)) ∧ portsAgree
     ∧ (eqStr us (toList "https") ∨ eqStr us (toList "wss")
        ∨ (eqStr (schemeChars (scheme self)) (toList "http") ∧ (eqStr us (toList "http") ∨ eqStr us (toList "ws")))))
  where
  us : Str
  us = schemeChars (scheme u)

  portsAgree : Bool
  portsAgree with portOf self | portOf u
  ... | nothing | nothing = true
  ... | just a  | just b  = eqStr a b
  ... | _       | _       = false

-- Does the ancestor's origin (as a URL) match the source expression, for a
-- document of origin self?
sourceMatch : Abs → Abs → Str → Bool
sourceMatch self u expr with lowerAll expr
... | e = if eqStr e (toList "*") then httpLike (scheme u) ∨ sameScheme (scheme u) (scheme self)
          else if eqStr e (toList "'self'") then selfMatch self u
          else viaScheme (schemeSource e)
  where
  viaHost : Maybe HostSource → Bool
  viaHost nothing   = false
  viaHost (just hs) =
    schemeOK (hsScheme hs)
    ∧ hostPartMatch (hsHost hs) (hostOf u)
    ∧ portPartMatch (hsPort hs) u
    ∧ pathPartMatchRoot (hsPath hs)
    where
    schemeOK : Maybe Str → Bool
    schemeOK (just sc) = schemePartMatch sc (scheme u)
    schemeOK nothing   = schemePartMatch (schemeChars (scheme self)) (scheme u)

  viaScheme : Maybe Str → Bool
  viaScheme (just sc) = schemePartMatch sc (scheme u)
  viaScheme nothing   = viaHost (hostSource e)

-- A header's frame-ancestors verdict for an embedder: nothing when no
-- policy of it has the directive; otherwise whether every policy that has
-- it admits the embedder (a source list that is 'none', or empty, admits
-- none).
frameAncestors : Str → Abs → Abs → Maybe Bool
frameAncestors header ancestor self = over (parseHeader header) nothing
  where
  find : List Directive → Maybe (List Str)
  find []              = nothing
  find ((n , vs) ∷ ds) = if eqStr n (toList "frame-ancestors") then just vs else find ds

  admits : List Str → Bool
  admits []       = false
  admits (v ∷ vs) = sourceMatch self ancestor v ∨ admits vs

  combineV : Maybe Bool → Bool → Maybe Bool
  combineV nothing  b = just b
  combineV (just a) b = just (a ∧ b)

  over : List (List Directive) → Maybe Bool → Maybe Bool
  over []         acc = acc
  over (ds ∷ dss) acc with find ds
  ... | nothing = over dss acc
  ... | just vs = over dss (combineV acc (admits vs))

------------------------------------------------------------------------
-- X-Frame-Options (HTML §7.1.? "check a navigation response's adherence to
-- X-Frame-Options"), when no enforced policy has frame-ancestors: the
-- header's values (every field line, split on ",", trimmed of space and
-- tab, lowercased, as a set); conflicting values block; "deny" blocks;
-- "sameorigin" admits a same-origin embedder only; anything else admits.

xfoAllows : List Str → Bool → Bool
xfoAllows lines sameOriginEmbedder with dedupe (concatMapL values lines) []
  where
  isOWS′ : Char → Bool
  isOWS′ c = is 32 c ∨ is 9 c

  trimO : Str → Str
  trimO s = reverse (dropWhile isOWS′ (reverse (dropWhile isOWS′ s)))

  values : Str → List Str
  values l = map (λ v → lowerAll (trimO v)) (splitOn (is 44) l)

  concatMapL : (Str → List Str) → List Str → List Str
  concatMapL f []       = []
  concatMapL f (x ∷ xs) = f x ++ concatMapL f xs

  dedupe : List Str → List Str → List Str
  dedupe []       acc = reverse acc
  dedupe (x ∷ xs) acc = if member x acc then dedupe xs acc else dedupe xs (x ∷ acc)
... | []          = true
... | v ∷ []      = if eqStr v (toList "deny") then false
                    else if eqStr v (toList "sameorigin") then sameOriginEmbedder
                    else true
... | vs@(_ ∷ _ ∷ _) = not (member (toList "deny") vs ∨ member (toList "allowall") vs ∨ member (toList "sameorigin") vs)
