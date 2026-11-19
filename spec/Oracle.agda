{-# OPTIONS --safe #-}
-- Wire adapter only: the rules are in Url, Containment and Srcset.
-- One line in, one line out (spec-oracle skill, yovico-ai/agda-guardrails):
--
--   vocab                               → {"schemes":["http",..]}
--   rewrite <proxy> <base> <url>        → {"kind":"proxified","out":"…"}
--   unwrap  <proxy> <href>              → {"kind":"unwrapped","out":"…"}
--   rewritewith <proxy> <base> <policy> <url>
--                                       → as rewrite, the request made under
--                                         that referrer policy (marked)
--   targetpolicy <proxied URL>          → {"out":"origin"} / {"none":true}
--   srcset  <value>                     → {"out":"…"}  (each URL u written as [u])
--   direct  <base> <url>                → {"kind":"shownDirect","out":"…"}
--                                         (what the browser shows, no cyrano)
--   policy  <Referrer-Policy value>     → {"out":"strict-origin"} / {"out":""}
--   referrer <policy> <from> <to>       → {"out":"…"} / {"none":true}
--   origin  <mode> <safe|unsafe> <policy> <from> <to>
--                                       → {"out":"…"} / {"none":true}
--   setcookie <api|http> <ps|nops> <url> <set-cookie-string>
--                                       → {"out":"<12 lines>"} / {"none":true}
--                                         lines: h|d, domain, path, name, value,
--                                         s|i, H|-, n|l|t|u, "="maxAge|"",
--                                         "="expires|"", wire name, wire value
--   samesite <n|l|t|u> <same|cross> <nav|other>
--                                       → {"out":"yes"} / {"out":"no"}
--   cookies <api|http> <url> <jar "n=v; n=v">
--                                       → {"out":"a=1; b=2"}
--   site    <from> <fromSite|-> <to> <toSite|->
--                                       → {"out":"same-origin|same-site|cross-site"}
--   credentials <omit|same-origin|include> <same|cross>
--                                       → {"out":"yes"} / {"out":"no"}
--   cors    <origin> <cred|nocred> <ACAO lines> <ACAC lines>
--                                       → {"out":"yes"} / {"out":"no"}
--   expose  <cred|nocred> <Access-Control-Expose-Headers lines> <name>
--                                       → {"out":"yes"} / {"out":"no"}
--   csp     <header|meta> <proxy origin> <tt policy> <value>
--                                       → {"out":"<translated policy>"}
--   cspnonce  <header values, LF-separated>  → {"out":"<nonce>"} / {"none":true}
--   cspinline <header values, LF-separated>  → {"out":"yes"} / {"out":"no"}
--   scriptkind <0|1> <type> <0|1> <language>
--                                       (1: the attribute is present)
--                                       → {"out":"classic|module|importmap|speculationrules|data"}
--   docbase <document URL> <href>…      → {"out":"<base URL>"} (the hrefs of
--                                         the document's <base> elements)
--   importmap <proxy> <base> <text>     → {"out":"<rewritten import map>"}
--   attrkind <html|svg> <tag> <attr>    → {"out":"url|urllist|srcset|reflected|none"}
--   urllist <proxy> <base> <text>       → {"out":"<each token proxified>"}
--   urllike <specifier>                 → {"out":"yes"} / {"out":"no"}
--   jsonobject <text>                   → {"out":"yes"} / {"out":"no"} (a JSON object)
--   css     <proxy> <base> <css text>  → {"out":"<rewritten css>"}
--   cssurls <css text>                  → {"out":"<url>\n<url>…"} (the URLs it names)
--   frameanc <CSP header value> <embedder URL> <document URL>
--                                       → {"out":"allow"|"deny"} / {"none":true}
--   xfo     <X-Frame-Options lines> <same|cross>
--                                       → {"out":"yes"} / {"out":"no"}
--     (a header's field lines: one field, the lines separated by LF;
--      an empty field is no line at all — Fetch.agda: they decide alike)
--
-- Fields are separated by one tab. In a field, "\u{HEX}" stands for that
-- code point: the harness writes every backslash, control character and
-- non-ASCII character that way, so a line is ASCII and has no stray tab.
-- Replies are ASCII JSON (\uXXXX escapes). A reply with "error" — the
-- request was malformed, or the URL is outside the model — must fail
-- the query, never decode as an answer. JSON is built by concatenation
-- on purpose (skill: a JSON library is more code than trust).
module Oracle where

open import Data.Bool.Base using (Bool; true; false; _∨_; if_then_else_)
open import Data.Char.Base using (Char; toℕ; fromℕ)
open import Data.List.Base using (List; []; _∷_; _++_; reverse; concatMap)
open import Data.Maybe.Base using (Maybe; just; nothing)
open import Data.Nat.Base using (ℕ; zero; suc; _+_; _∸_; _*_; _<ᵇ_; _/_; _%_)
import Data.String.Base
open import Data.String.Base using (String; toList; fromList)

open import Scheme
open import Url
open import Containment
open import Srcset
open import Referrer
open import Cookies
open import Fetch
open import Csp
open import Css using (rewriteCss; cssUrls)
import ImportMap
import Attrs
open import Html using (ScriptKind; scriptClassic; scriptModule; scriptImportMap; scriptSpeculation; scriptData; scriptKind; documentBase; BaseURL; baseOf′; aboutBlank; beyond)

------------------------------------------------------------------------
-- Requests.

hexValue : Char → ℕ
hexValue c = if isDigit c then toℕ c ∸ 48
             else if within 65 70 c then toℕ c ∸ 55
             else toℕ c ∸ 87

-- "\u{HEX}" escapes; nothing when one is malformed.
unescape : Str → Maybe Str
unescape [] = just []
unescape (c ∷ cs) = if is 92 c then escape cs else cons c (unescape cs)
  where
  cons : Char → Maybe Str → Maybe Str
  cons x (just xs) = just (x ∷ xs)
  cons x nothing   = nothing

  -- after "\": "u{" hex+ "}"
  hexRun : ℕ → Str → Maybe Str
  hexRun n []       = nothing
  hexRun n (d ∷ ds) = if is 125 d then cons (fromℕ n) (unescape ds)
                      else if isHex d then hexRun (n * 16 + hexValue d) ds
                      else nothing

  escape : Str → Maybe Str
  escape (u ∷ b ∷ ds) = if is 117 u then (if is 123 b then hexRun 0 ds else nothing) else nothing
  escape _            = nothing

fields : Str → List Str
fields = splitOn (is 9)

------------------------------------------------------------------------
-- Replies.

hex4 : ℕ → Str
hex4 n = hexDigit ((n / 4096) % 16) ∷ hexDigit ((n / 256) % 16) ∷ hexDigit ((n / 16) % 16) ∷ hexDigit (n % 16) ∷ []

uEscape : ℕ → Str
uEscape n = toList "\\u" ++ hex4 n

jsonChar : Char → Str
jsonChar c =
  if is 34 c then toList "\\\""
  else if is 92 c then toList "\\\\"
  else if (toℕ c <ᵇ 32) ∨ (126 <ᵇ toℕ c) then wide (toℕ c)
  else c ∷ []
  where
  wide : ℕ → Str
  wide n = if n <ᵇ 65536 then uEscape n
           else uEscape (55296 + (n ∸ 65536) / 1024) ++ uEscape (56320 + (n ∸ 65536) % 1024)

jsonString : Str → Str
jsonString s = toList "\"" ++ concatMap jsonChar s ++ toList "\""

kindText : Kind → String
kindText emptyRef         = "emptyRef"
kindText anchor           = "anchor"
kindText notProxifiable   = "notProxifiable"
kindText unparseable      = "unparseable"
kindText alreadyProxified = "alreadyProxified"
kindText proxyOrigin      = "proxyOrigin"
kindText remapped         = "remapped"
kindText proxified        = "proxified"
kindText foreignOrigin    = "foreignOrigin"
kindText plainProxyPath   = "plainProxyPath"
kindText unwrapped        = "unwrapped"
kindText shownDirect      = "shownDirect"



siteName : Site → String
siteName sameOriginSite = "same-origin"
siteName sameSite       = "same-site"
siteName crossSite      = "cross-site"

modeOf : Str → Maybe Mode
modeOf m =
  if eqStr m (toList "navigate") then just navigate
  else if eqStr m (toList "same-origin") then just sameOriginMode
  else if eqStr m (toList "no-cors") then just noCors
  else if eqStr m (toList "cors") then just cors
  else if eqStr m (toList "websocket") then just websocket
  else nothing

errorReply : String → Str
errorReply e = toList "{\"error\":\"" ++ toList e ++ toList "\"}"

answerReply : Str → Answer → Str
answerReply raw (keep k)   = toList "{\"kind\":\"" ++ toList (kindText k) ++ toList "\",\"out\":" ++ jsonString raw ++ toList "}"
answerReply raw (emit k s) = toList "{\"kind\":\"" ++ toList (kindText k) ++ toList "\",\"out\":" ++ jsonString s ++ toList "}"
answerReply raw silent     = errorReply "OutOfModel"

------------------------------------------------------------------------

-- The proxy's public origin: an absolute URL with no path beyond "/".
proxyOf : Str → Maybe Proxy
proxyOf s = fromParsed (parse nothing s)
  where
  rootOnly : List Str → Bool
  rootOnly ([] ∷ []) = true
  rootOnly _         = false

  fromParsed : Parsed → Maybe Proxy
  fromParsed (url a)     = if rootOnly (path a) then just (proxy (scheme a) (auth a)) else nothing
  fromParsed otherScheme = nothing
  fromParsed invalid     = nothing
  fromParsed outside     = nothing

baseOf : Str → Maybe Abs
baseOf s = fromParsed (parse nothing s)
  where
  fromParsed : Parsed → Maybe Abs
  fromParsed (url a)     = just a
  fromParsed otherScheme = nothing
  fromParsed invalid     = nothing
  fromParsed outside     = nothing

bracket : Str → Str
bracket u = fromℕ 91 ∷ u ++ fromℕ 93 ∷ []

vocabReply : Str
vocabReply = toList "{\"schemes\":[" ++ names allSchemes ++ toList "]}"
  where
  names : List Scheme → Str
  names []           = []
  names (s ∷ [])     = jsonString (schemeChars s)
  names (s ∷ t ∷ ss) = jsonString (schemeChars s) ++ toList "," ++ names (t ∷ ss)

-- Each argument unescaped, or nothing when one is malformed.
unescapeAll : List Str → Maybe (List Str)
unescapeAll []       = just []
unescapeAll (f ∷ fs) with unescape f | unescapeAll fs
... | just g  | just gs = just (g ∷ gs)
... | _       | _       = nothing

dispatch : Str → List Str → Str
dispatch op args =
  if eqStr op (toList "rewrite") then rewriteReq args
  else if eqStr op (toList "rewritewith") then rewriteWithReq args
  else if eqStr op (toList "targetpolicy") then targetPolicyReq args
  else if eqStr op (toList "unwrap") then unwrapReq args
  else if eqStr op (toList "srcset") then srcsetReq args
  else if eqStr op (toList "direct") then directReq args
  else if eqStr op (toList "policy") then policyReq args
  else if eqStr op (toList "referrer") then referrerReq args
  else if eqStr op (toList "origin") then originReq args
  else if eqStr op (toList "site") then siteReq args
  else if eqStr op (toList "setcookie") then setCookieReq args
  else if eqStr op (toList "cookies") then cookiesReq args
  else if eqStr op (toList "samesite") then sameSiteReq args
  else if eqStr op (toList "credentials") then credentialsReq args
  else if eqStr op (toList "cors") then corsReq args
  else if eqStr op (toList "expose") then exposeReq args
  else if eqStr op (toList "csp") then cspReq args
  else if eqStr op (toList "cspnonce") then cspNonceReq args
  else if eqStr op (toList "cspinline") then cspInlineReq args
  else if eqStr op (toList "scriptkind") then scriptKindReq args
  else if eqStr op (toList "docbase") then docBaseReq args
  else if eqStr op (toList "importmap") then importMapReq args
  else if eqStr op (toList "urllike") then urlLikeReq args
  else if eqStr op (toList "attrkind") then attrKindReq args
  else if eqStr op (toList "urllist") then urlListReq args
  else if eqStr op (toList "jsonobject") then jsonObjectReq args
  else if eqStr op (toList "css") then cssReq args
  else if eqStr op (toList "cssurls") then cssUrlsReq args
  else if eqStr op (toList "frameanc") then frameAncReq args
  else if eqStr op (toList "xfo") then xfoReq args
  else errorReply "UnknownRequest"
  where
  rewriteReq : List Str → Str
  rewriteReq (p ∷ b ∷ raw ∷ []) with proxyOf p | baseOf b
  ... | just px | just base = answerReply raw (rewriteUrl px base raw)
  ... | nothing | _         = errorReply "BadProxy"
  ... | just _  | nothing   = errorReply "BadBase"
  rewriteReq _ = errorReply "BadRequest"

  rewriteWithReq : List Str → Str
  rewriteWithReq (p ∷ b ∷ pt ∷ raw ∷ []) with proxyOf p | baseOf b | policyToken pt
  ... | just px | just base | just pol = answerReply raw (rewriteUrlWith px (just pol) base raw)
  ... | nothing | _         | _        = errorReply "BadProxy"
  ... | just _  | nothing   | _        = errorReply "BadBase"
  ... | just _  | just _    | nothing  = errorReply "BadRequest"
  rewriteWithReq _ = errorReply "BadRequest"

  unwrapReq : List Str → Str
  unwrapReq (p ∷ h ∷ []) with proxyOf p
  ... | just px = answerReply h (unwrap px h)
  ... | nothing = errorReply "BadProxy"
  unwrapReq _ = errorReply "BadRequest"

  directReq : List Str → Str
  directReq (b ∷ raw ∷ []) with baseOf b
  ... | just base = answerReply raw (direct base raw)
  ... | nothing   = errorReply "BadBase"
  directReq _ = errorReply "BadRequest"

  out : Str → Str
  out v = toList "{\"out\":" ++ jsonString v ++ toList "}"

  maybeOut : Maybe Str → Str
  maybeOut (just v) = out v
  maybeOut nothing  = toList "{\"none\":true}"

  targetPolicyReq : List Str → Str
  targetPolicyReq (u ∷ []) with parse nothing (preprocess u)
  ... | url a = maybeOut (named (targetPolicy (path a)))
    where
    named : Maybe Policy → Maybe Str
    named (just pol) = just (toList (policyName pol))
    named nothing    = nothing
  ... | _ = maybeOut nothing
  targetPolicyReq _ = errorReply "BadRequest"


  policyReq : List Str → Str
  policyReq (v ∷ []) with headerPolicy v
  ... | just p  = out (toList (policyName p))
  ... | nothing = out []
  policyReq _ = errorReply "BadRequest"

  referrerReq : List Str → Str
  referrerReq (p ∷ f ∷ t ∷ []) with policyToken p | baseOf f | baseOf t
  ... | just pol | just from | just to = maybeOut (referrer pol from to)
  ... | _        | _         | _       = errorReply "OutOfModel"
  referrerReq _ = errorReply "BadRequest"

  originReq : List Str → Str
  originReq (m ∷ sm ∷ p ∷ f ∷ t ∷ []) with modeOf m | policyToken p | baseOf f | baseOf t
  ... | just mode | just pol | just from | just to =
    maybeOut (originHeader mode (eqStr sm (toList "safe")) pol from to)
  ... | _ | _ | _ | _ = errorReply "OutOfModel"
  originReq _ = errorReply "BadRequest"

  siteReq : List Str → Str
  siteReq (f ∷ fs ∷ t ∷ ts ∷ []) with baseOf f | baseOf t
  ... | just from | just to = out (toList (siteName (secFetchSite from (dash fs) to (dash ts))))
    where
    dash : Str → Maybe Str
    dash x = if eqStr x (toList "-") then nothing else just x
  ... | _ | _ = errorReply "OutOfModel"
  siteReq _ = errorReply "BadRequest"

  nl : Char
  nl = fromℕ 10

  lines : List Str → Str
  lines []           = []
  lines (l ∷ [])     = l
  lines (l ∷ m ∷ ls) = l ++ nl ∷ lines (m ∷ ls)

  opt : Maybe Str → Str
  opt nothing  = []
  opt (just v) = fromℕ 61 ∷ v

  dump : SetCookie → Stored → Str
  dump sc c = lines
    ( ((if sHostOnly c then 'h' else 'd') ∷ []) ∷ sDomain c ∷ sPath c ∷ sName c ∷ sValue c
    ∷ ((if sSecure c then 's' else 'i') ∷ []) ∷ ((if sHttpOnly c then 'H' else '-') ∷ [])
    ∷ (sameSiteFlag (sSameSite c) ∷ []) ∷ opt (maxAge sc) ∷ opt (expires sc)
    ∷ wireName c ∷ wireValue c ∷ [] )

  setCookieReq : List Str → Str
  setCookieReq (api ∷ ps ∷ u ∷ str ∷ []) with baseOf u | parseSetCookie str
  ... | nothing   | _       = errorReply "OutOfModel"
  ... | just _    | nothing = maybeOut nothing
  ... | just base | just sc with store (eqStr api (toList "api")) (eqStr ps (toList "ps")) base sc
  ...   | nothing = maybeOut nothing
  ...   | just c  = out (dump sc c)
  setCookieReq _ = errorReply "BadRequest"

  sameSiteReq : List Str → Str
  sameSiteReq (f ∷ site ∷ nav ∷ []) with flagOf f
    where
    flagOf : Str → Maybe SameSite
    flagOf x = if eqStr x (toList "n") then just ssNone else if eqStr x (toList "l") then just ssLax
               else if eqStr x (toList "t") then just ssStrict else if eqStr x (toList "u") then just ssDefault
               else nothing
  ... | just ss = out (toList (if sameSiteAllows ss (eqStr site (toList "same")) (eqStr nav (toList "nav")) then "yes" else "no"))
  ... | nothing = errorReply "BadRequest"
  sameSiteReq _ = errorReply "BadRequest"

  cookiesReq : List Str → Str
  cookiesReq (api ∷ u ∷ jar ∷ []) with baseOf u
  ... | just base = out (cookiesFor (eqStr api (toList "api")) base jar)
  ... | nothing   = errorReply "OutOfModel"
  cookiesReq _ = errorReply "BadRequest"

  yesNo : Bool → Str
  yesNo b = out (toList (if b then "yes" else "no"))

  -- A header's field lines, LF-separated; empty: none.
  fieldLines : Str → List Str
  fieldLines [] = []
  fieldLines v  = splitOn (is 10) v

  credOf : Str → Maybe Bool
  credOf x = if eqStr x (toList "cred") then just true
             else if eqStr x (toList "nocred") then just false else nothing

  credentialsReq : List Str → Str
  credentialsReq (m ∷ so ∷ []) with modeOf′ m
    where
    modeOf′ : Str → Maybe Credentials
    modeOf′ x = if eqStr x (toList "omit") then just credOmit
                else if eqStr x (toList "same-origin") then just credSameOrigin
                else if eqStr x (toList "include") then just credInclude else nothing
  ... | just c  = yesNo (includesCredentials c (eqStr so (toList "same")))
  ... | nothing = errorReply "BadRequest"
  credentialsReq _ = errorReply "BadRequest"

  corsReq : List Str → Str
  corsReq (o ∷ c ∷ ao ∷ ac ∷ []) with credOf c
  ... | just cred = yesNo (corsCheck (combine (fieldLines ao)) (combine (fieldLines ac)) o cred)
  ... | nothing   = errorReply "BadRequest"
  corsReq _ = errorReply "BadRequest"

  exposeReq : List Str → Str
  exposeReq (c ∷ eh ∷ n ∷ []) with credOf c
  ... | just cred = yesNo (exposed cred (fieldLines eh) n)
  ... | nothing   = errorReply "BadRequest"
  exposeReq _ = errorReply "BadRequest"

  cspReq : List Str → Str
  cspReq (k ∷ o ∷ tt ∷ v ∷ []) =
    if eqStr k (toList "header") then out (translateHeader px v)
    else if eqStr k (toList "meta") then out (translateMeta px v)
    else errorReply "BadRequest"
    where
    px : CspProxy
    px = record { origin = o ; ttPolicy = tt ; plainHttp = prefixCI (toList "http://") o }
  cspReq _ = errorReply "BadRequest"

  cspNonceReq : List Str → Str
  cspNonceReq (hs ∷ []) = maybeOut (scriptNonce (fieldLines hs))
  cspNonceReq _ = errorReply "BadRequest"

  cspInlineReq : List Str → Str
  cspInlineReq (hs ∷ []) = yesNo (inlineScriptAllowed (fieldLines hs))
  cspInlineReq _ = errorReply "BadRequest"

  scriptKindReq : List Str → Str
  scriptKindReq (ht ∷ t ∷ hl ∷ l ∷ []) = out (toList (kindName (scriptKind (opt′ ht t) (opt′ hl l))))
    where
    opt′ : Str → Str → Maybe Str
    opt′ h v = if eqStr h (toList "1") then just v else nothing

    kindName : ScriptKind → Data.String.Base.String
    kindName scriptClassic     = "classic"
    kindName scriptModule      = "module"
    kindName scriptImportMap   = "importmap"
    kindName scriptSpeculation = "speculationrules"
    kindName scriptData        = "data"
  scriptKindReq _ = errorReply "BadRequest"

  docBaseReq : List Str → Str
  docBaseReq (d ∷ hrefs) with baseOf d
  ... | just doc = byBase (documentBase doc hrefs)
    where
    byBase : BaseURL → Str
    byBase (baseOf′ a) = out (href a)
    byBase aboutBlank  = out (toList "about:blank")
    byBase beyond      = errorReply "OutOfModel"
  ... | nothing  = errorReply "OutOfModel"
  docBaseReq _ = errorReply "BadRequest"

  importMapReq : List Str → Str
  importMapReq (p ∷ b ∷ text ∷ []) with proxyOf p | baseOf b
  ... | just px | just base = out (ImportMap.rewriteImportMap rw text)
    where
    rw : Str → Maybe Str
    rw u with rewriteUrl px base u
    ... | emit _ v = just v
    ... | _        = nothing
  ... | nothing | _ = errorReply "BadProxy"
  ... | just _  | nothing = errorReply "BadBase"
  importMapReq _ = errorReply "BadRequest"

  jsonObjectReq : List Str → Str
  jsonObjectReq (t ∷ []) = yesNo (isObj (ImportMap.tokenize t))
    where
    isObj : Maybe (List ImportMap.Tok) → Bool
    isObj nothing = false
    isObj (just ts) with ImportMap.roles ts
    ... | just _  = true
    ... | nothing = false
  jsonObjectReq _ = errorReply "BadRequest"

  attrKindReq : List Str → Str
  attrKindReq (n ∷ t ∷ a ∷ []) =
    if eqStr n (toList "svg") then out (Attrs.kindName (Attrs.attrKind Attrs.svgNs t a))
    else if eqStr n (toList "html") then out (Attrs.kindName (Attrs.attrKind Attrs.htmlNs t a))
    else errorReply "BadRequest"
  attrKindReq _ = errorReply "BadRequest"

  urlListReq : List Str → Str
  urlListReq (p ∷ b ∷ text ∷ []) with proxyOf p | baseOf b
  ... | just px | just base = out (Attrs.rewriteUrlList rw text)
    where
    rw : Str → Maybe Str
    rw u with rewriteUrl px base u
    ... | emit _ v = just v
    ... | _        = nothing
  ... | nothing | _ = errorReply "BadProxy"
  ... | just _  | nothing = errorReply "BadBase"
  urlListReq _ = errorReply "BadRequest"

  urlLikeReq : List Str → Str
  urlLikeReq (v ∷ []) = yesNo (ImportMap.urlLike v)
  urlLikeReq _ = errorReply "BadRequest"

  cssReq : List Str → Str
  cssReq (p ∷ b ∷ text ∷ []) with proxyOf p | baseOf b
  ... | just px | just base = out (rewriteCss rw text)
    where
    rw : Str → Maybe Str
    rw u with rewriteUrl px base u
    ... | emit _ v = just v
    ... | _        = nothing
  ... | nothing | _ = errorReply "BadProxy"
  ... | just _  | nothing = errorReply "BadBase"
  cssReq _ = errorReply "BadRequest"

  cssUrlsReq : List Str → Str
  cssUrlsReq (text ∷ []) = out (joinLF (cssUrls text))
    where
    joinLF : List Str → Str
    joinLF []           = []
    joinLF (u ∷ [])     = u
    joinLF (u ∷ v ∷ us) = u ++ nl ∷ joinLF (v ∷ us)
  cssUrlsReq _ = errorReply "BadRequest"

  frameAncReq : List Str → Str
  frameAncReq (h ∷ a ∷ d ∷ []) with baseOf a | baseOf d
  ... | just anc | just doc = maybeOut (verdict (frameAncestors h anc doc))
    where
    verdict : Maybe Bool → Maybe Str
    verdict (just true)  = just (toList "allow")
    verdict (just false) = just (toList "deny")
    verdict nothing      = nothing
  ... | _ | _ = errorReply "OutOfModel"
  frameAncReq _ = errorReply "BadRequest"

  xfoReq : List Str → Str
  xfoReq (ls ∷ so ∷ []) = yesNo (xfoAllows (fieldLines ls) (eqStr so (toList "same")))
  xfoReq _ = errorReply "BadRequest"

  srcsetReq : List Str → Str
  srcsetReq (v ∷ []) = toList "{\"out\":" ++ jsonString (rewriteSrcset bracket v) ++ toList "}"
  srcsetReq _        = errorReply "BadRequest"

respond : Str → Str
respond line with fields line
... | []          = errorReply "BadRequest"
... | op ∷ rest with unescapeAll rest
...   | nothing   = errorReply "BadEscape"
...   | just args = if eqStr op (toList "vocab") then vocabReply else dispatch op args

evaluate : String → String
evaluate line = fromList (respond (toList line))
