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
--   rewritemark <proxy> <base> <policy|-> <js|css|-> <url>
--                                       → as rewrite, the URL marked so
--   disposition <js|css|-> <0|1> <Sec-Fetch-Dest> <0|1> <Content-Type> <0|1 sniffed>
--                                       → {"out":"js|css|html|none"} (what the proxy does with the body)
--   acceptch <field lines>              → {"out":"<names, space-separated>"|"none"} (none: counts for nothing)
--   hintsent <hint> <set> <0|1> <0|1> <0|1> → {"out":"yes"|"no"}
--   crossorigin <0|1> <tag> <rel> <as>  → {"out":"<value written>"|"keep"}
--   widenselector <proxy> <base> <selector> → {"out":"<the selector the DOM is given>"}
--   postdelivery <sender> <recipient> <targetOrigin> → {"out":"deliver"|"drop"|"throw"}
--   setspolicy <dest>                  → {"out":"yes"|"no"} (its response sets a context's referrer policy)
--   sniffhtml <body>                   → {"out":"yes"|"no"} (Chromium's HTML sniff)
--   metadatasent <name> <0|1>          → {"out":"yes"|"no"} (reaches a target of that trustworthiness)
--   dictae <accept-encoding>            → {"out":"<without dcb/dcz>"} (Dictionary.acceptEncoding)
--   dictreg <use-as-dictionary>         → {"out":"<as the browser is given it>"}
--   dictoffer <request header name>     → {"out":"yes"|"no"} (removed: a dictionary offer)
--   priority <dest> <mode> <method> <purpose> → {"out":"<Priority>"|"none"}
--   fetchlatersize <href> <headers k:v, LF> <none|text|params|buffer|blob:type> <body bytes> → {"out":"<n>"|"unknown-length"}
--   frameorigin <object 0|1> <srcdoc 0|1> <src as read> <creator origin> → {"out":"same"|"cross"|"opaque"}
--   selforigin <native origin> <original origin> → {"out":"<self.origin>"} (Frames.selfOrigin)
--   documentdomain <native origin> <original host> → {"out":"<document.domain>"} (Frames.documentDomain)
--   frameoriginof <object 0|1> <srcdoc 0|1> <src as read> → {"out":"<origin>"|"creator"|"opaque"}
--   stackurls <V8 stack text>          → {"out":"<script URLs, innermost first, LF-separated>"}
--   evalorigin <name> <location>        → {"out":"eval at <name|<anonymous>> (<location>)"}
--   framedlength <h2|h1> <declared> <came> → {"out":"<length>"}
--   varyforbrowser <Vary as combined>       → {"out":"<Vary for the browser>"}
--   untag <tag> <origin> <frame text>   → {"out":"<frame text, tag → origin, <anonymous>>"}
--   h1orders <connection bytes>         → {"out":"<a,b,…><…>…"} (each recorded request's header names)
--   refererroute <proxy> <referer> <raw path> <"?query"|""> → {"out":"<redirect path>"|"none"}
--   cspnoscripts <header lines>        → {"out":"yes"|"no"} (no page script runs: no runtime)
--   featuresources <features>          → {"out":"<attributionsrc values, LF-separated>"}
--   featuresmap <features>              → {"out":"<the string, each such value v as [v]>"}
--   sheetapplies <quirks 0|1> <same-origin 0|1> <ct|"-"> <nosniff 0|1> → {"out":"yes"|"no"} (Chromium applies the stylesheet)
--   orbblocks <ct|"-"> <body>         → {"out":"yes"|"no"} (ORB blocks a cross-origin no-cors script)
--   orbproxy <cross-origin 0|1> <redirect 0|1> <ct|"-"> <acao 0|1> <body> → {"out":"yes"|"no"} (the proxy fails it)
--   sheetnosniff <same-origin 0|1> <ct|"-"> <nosniff 0|1> → {"out":"yes"|"no"} (the proxy adds nosniff)
--   htmltail <scripting 0|1> <markup>  → {"out":"<offset>"|"none"} (where an unfinished construct at the end begins)
--   nosniff <field lines, LF>          → {"out":"yes"|"no"} (X-Content-Type-Options says nosniff)
--   workerruns <module 0|1> <mime>      → {"out":"yes"|"no"} (a blob:/data: worker runs)
--   fetchlateradmit <used> <size>       → {"out":"ok"|"<the QuotaExceededError message>"}
--   storagekey <ancestors> <site> <origin> → {"out":"<the partition key>"}
--   storageaccess <mode> <dest> <cred> <chain> <from> <to> <site> <0|1> → {"out":"active"|"none"}
--   allowframe <attr> <f> <0|1> <parent> <src> <frame> → {"out":"yes"|"no"} (the frame's featurePolicy)
--   fpallows <pp lines|""> <fp> <f> <0|1> <doc> <origin> → {"out":"yes"|"no"} (featurePolicy.allowsFeature)
--   fprewrite <Feature-Policy>          → {"out":"<the header the browser is given>"}
--   allowrewrite <attr>                 → {"out":"<the attribute the browser is given>"}
--   ppallows <lines> <feature> <0|1> <doc> <origin> → {"out":"yes"|"no"} (featurePolicy.allowsFeature)
--   pptranslate <lines>                 → {"out":"<the lines the browser is given>"}
--   upgradable <host[:port]> <known TLD 0|1> → {"out":"yes"|"no"} (Chrome tries it over https)
--   swapscheme <from> <to> <target>     → {"out":"<target>"|"none"}
--   upgradesteps <events>               → {"out":"<decisions>"} (n<t> l f<t>; U P B -)
--   secchua <major> <brand>             → {"out":"<the Sec-CH-UA value>"}
--   unproxyquery <proxy> <query>        → {"out":"<query, proxified values unwrapped>"}
--   jsonbytes <value as bytes>          → {"out":"<JSON string, byte for byte>"}
--   crnh <entries>                      → {"out":"<the Crn-H object>"} (lines "name\tn" or "name\tv\tvalue…")
--   crnbread <description>              → {"out":"<encoded> <decoded>"|"none"}
--   wsmark <0|1> <query> <origin>       → {"out":"?<query>&__cyrano_ws_origin=<enc>"} (the runtime's marker)
--   wssplit <query>                     → {"out":"none"|"<1|0>\t<page query>\t<enc origin>"} (the server's reading)
--   refreshread <value>                 → {"out":"none"|"reload"|"url\t<url>"} (a Refresh's reading)
--   refresh <proxy> <base> <value>      → {"out":"<value, its URL proxified>"}
--   targetdest <proxied URL>            → {"out":"js"|"css"} / {"none":true}
--   srcset  <value>                     → {"out":"…"}  (each URL u written as [u])
--   direct  <base> <url>                → {"kind":"shownDirect","out":"…"}
--                                         (what the browser shows, no cyrano)
--   initref <base> <context URL> <value> → {"out":""|"about:client"|"TypeError"|"<url>"}
--                                         (a RequestInit's referrer, Chromium's reading)
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
--   cookiestoreset <139|later> <ps yes|no> <url> <name> <value> <-|=domain> <-|=path> <n|l|t>
--   cookiestoredelete <139|later> <ps yes|no> <url> <name> <-|=domain> <-|=path>
--                                       → {"out":"!<error>"} / {"out":"<wire name>\n<wire value>"}
--   cookiestoreget <url> <-|=name> <jar>   → {"out":"name\tvalue\tdomain|-\tpath\tsameSite\tyes|no\n…"}
--   credentials <omit|same-origin|include> <same|cross>
--   namescontext <opaque> <cross> <unreferred>   (each yes|no) → yes|no
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
--   urldest <html|svg> <tag> <attr> <rel types> <as|-> → {"out":"js|css|-"}
--   urllist <proxy> <base> <text>       → {"out":"<each token proxified>"}
--   urllike <specifier>                 → {"out":"yes"} / {"out":"no"}
--   jsonobject <text>                   → {"out":"yes"} / {"out":"no"} (a JSON object)
--   link    <proxy> <base> <Link header> → {"out":"<rewritten header>"}
--   linkpreloads <Link header>          → {"out":"target\tas\trel types\n…"} (the link-values that read)
--   htmltags <0|1> <text>             → {"out":"name ns id\n…"} (each start tag:
--                                         its namespace, its data-i or "-";
--                                         1: scripting on)
--   htmltagsin <0|1> <html|svg|math> <context element> <encoding|-> <text>
--                                       → as htmltags, parsed in that element
--   htmlspans <text>                    → {"out":"name from to[ attr nf nt vf vt]…\n…"}
--                                         (each start tag's attribute spans)
--   bootat  <marker> <text>             → {"out":"<text with the marker where
--                                         the bootstrap goes>"}
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
open import Data.Product.Base using (_×_; _,_)
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
import HtmlTok
import Link
import Disposition
import Orb
import Refresh
import WsOrigin
import Carry
import Query
import Hints
import Upgrades
import Permissions
import Allow
import Storage
import Metadata
import Dictionary
import Priority
import FetchLater
import WorkerSource
import Frames
import Stack
import H1
import Route
import Features
import Messaging
import Selectors
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
  else if eqStr op (toList "targetdest") then targetDestReq args
  else if eqStr op (toList "rewritemark") then rewriteMarkReq args
  else if eqStr op (toList "disposition") then dispositionReq args
  else if eqStr op (toList "sniffhtml") then sniffHtmlReq args
  else if eqStr op (toList "setspolicy") then setsPolicyReq args
  else if eqStr op (toList "postdelivery") then postDeliveryReq args
  else if eqStr op (toList "widenselector") then widenSelectorReq args
  else if eqStr op (toList "crossorigin") then crossoriginReq args
  else if eqStr op (toList "refreshread") then refreshReadReq args
  else if eqStr op (toList "wsmark") then wsMarkReq args
  else if eqStr op (toList "jsonbytes") then jsonBytesReq args
  else if eqStr op (toList "unproxyquery") then unproxyQueryReq args
  else if eqStr op (toList "acceptch") then acceptCHReq args
  else if eqStr op (toList "hintsent") then hintSentReq args
  else if eqStr op (toList "secchua") then secChUaReq args
  else if eqStr op (toList "upgradable") then upgradableReq args
  else if eqStr op (toList "ppallows") then ppAllowsReq args
  else if eqStr op (toList "allowframe") then allowFrameReq args
  else if eqStr op (toList "fpallows") then fpAllowsReq args
  else if eqStr op (toList "fprewrite") then fpRewriteReq args
  else if eqStr op (toList "storageaccess") then storageAccessReq args
  else if eqStr op (toList "storagekey") then storageKeyReq args
  else if eqStr op (toList "metadatasent") then metadataSentReq args
  else if eqStr op (toList "priority") then priorityReq args
  else if eqStr op (toList "fetchlatersize") then fetchLaterSizeReq args
  else if eqStr op (toList "fetchlateradmit") then fetchLaterAdmitReq args
  else if eqStr op (toList "workerruns") then workerRunsReq args
  else if eqStr op (toList "frameorigin") then frameOriginReq args
  else if eqStr op (toList "htmltail") then htmlTailReq args
  else if eqStr op (toList "nosniff") then oneArg (λ v → if Disposition.nosniff (if Data.List.Base.null v then [] else splitOn (is 10) v) then toList "yes" else toList "no") args
  else if eqStr op (toList "sheetapplies") then sheetReq args
  else if eqStr op (toList "orbblocks") then orbReq args
  else if eqStr op (toList "orbproxy") then orbProxyReq args
  else if eqStr op (toList "sheetnosniff") then sheetNosniffReq args
  else if eqStr op (toList "featuresources") then oneArg (λ f → joinNL (Features.sources f)) args
  else if eqStr op (toList "featuresmap") then oneArg (Features.mapSources (λ v → fromℕ 91 ∷ v ++ fromℕ 93 ∷ [])) args
  else if eqStr op (toList "refererroute") then refererRouteReq args
  else if eqStr op (toList "h1orders") then oneArg (λ st → Data.List.Base.concatMap (λ ns → fromℕ 60 ∷ joinComma ns ++ fromℕ 62 ∷ []) (H1.recordsOf st)) args
  else if eqStr op (toList "framedlength") then framedLengthReq args
  else if eqStr op (toList "varyforbrowser") then oneArg Carry.varyForBrowser args
  else if eqStr op (toList "stackurls") then oneArg (λ st → joinNL (Stack.stackUrls st)) args
  else if eqStr op (toList "evalorigin") then twoArgs (λ n l → Stack.evalOrigin n l) args
  else if eqStr op (toList "untag") then threeArgs (λ t o f → Stack.untag t o f) args
  else if eqStr op (toList "frameoriginof") then frameOriginOfReq args
  else if eqStr op (toList "selforigin") then twoArgs Frames.selfOrigin args
  else if eqStr op (toList "documentdomain") then twoArgs Frames.documentDomain args
  else if eqStr op (toList "dictae") then oneArg Dictionary.acceptEncoding args
  else if eqStr op (toList "dictreg") then oneArg Dictionary.noRegistration args
  else if eqStr op (toList "dictoffer") then oneArg (λ n → if Dictionary.offerHeader n then toList "yes" else toList "no") args
  else if eqStr op (toList "allowrewrite") then allowRewriteReq args
  else if eqStr op (toList "pptranslate") then ppTranslateReq args
  else if eqStr op (toList "swapscheme") then swapSchemeReq args
  else if eqStr op (toList "upgradesteps") then upgradeStepsReq args
  else if eqStr op (toList "crnh") then crnHReq args
  else if eqStr op (toList "crnbread") then crnbReadReq args
  else if eqStr op (toList "wssplit") then wsSplitReq args
  else if eqStr op (toList "refresh") then refreshReq args
  else if eqStr op (toList "unwrap") then unwrapReq args
  else if eqStr op (toList "srcset") then srcsetReq args
  else if eqStr op (toList "direct") then directReq args
  else if eqStr op (toList "initref") then initRefReq args
  else if eqStr op (toList "policy") then policyReq args
  else if eqStr op (toList "referrer") then referrerReq args
  else if eqStr op (toList "origin") then originReq args
  else if eqStr op (toList "site") then siteReq args
  else if eqStr op (toList "setcookie") then setCookieReq args
  else if eqStr op (toList "cookies") then cookiesReq args
  else if eqStr op (toList "cookiestoreset") then cookieStoreSetReq args
  else if eqStr op (toList "cookiestoredelete") then cookieStoreDeleteReq args
  else if eqStr op (toList "cookiestoreget") then cookieStoreGetReq args
  else if eqStr op (toList "samesite") then sameSiteReq args
  else if eqStr op (toList "credentials") then credentialsReq args
  else if eqStr op (toList "namescontext") then namesContextReq args
  else if eqStr op (toList "cors") then corsReq args
  else if eqStr op (toList "expose") then exposeReq args
  else if eqStr op (toList "csp") then cspReq args
  else if eqStr op (toList "cspnonce") then cspNonceReq args
  else if eqStr op (toList "cspinline") then cspInlineReq args
  else if eqStr op (toList "cspnoscripts") then oneArg (λ hs → if noScriptsRun (fieldLines hs) then toList "yes" else toList "no") args
  else if eqStr op (toList "scriptkind") then scriptKindReq args
  else if eqStr op (toList "docbase") then docBaseReq args
  else if eqStr op (toList "importmap") then importMapReq args
  else if eqStr op (toList "urllike") then urlLikeReq args
  else if eqStr op (toList "attrkind") then attrKindReq args
  else if eqStr op (toList "urldest") then urlDestReq args
  else if eqStr op (toList "urllist") then urlListReq args
  else if eqStr op (toList "jsonobject") then jsonObjectReq args
  else if eqStr op (toList "link") then linkReq args
  else if eqStr op (toList "linkpreloads") then linkPreloadsReq args
  else if eqStr op (toList "htmltags") then htmlTagsReq args
  else if eqStr op (toList "htmlspans") then htmlSpansReq args
  else if eqStr op (toList "htmltagsin") then htmlTagsInReq args
  else if eqStr op (toList "bootat") then bootAtReq args
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
  ... | just px | just base | just pol = answerReply raw (rewriteUrlWith px (mark (just pol) nothing) base raw)
  ... | nothing | _         | _        = errorReply "BadProxy"
  ... | just _  | nothing   | _        = errorReply "BadBase"
  ... | just _  | just _    | nothing  = errorReply "BadRequest"
  rewriteWithReq _ = errorReply "BadRequest"

  -- rewritemark <proxy> <base> <policy|-> <js|css|-> <url>
  rewriteMarkReq : List Str → Str
  rewriteMarkReq (p ∷ b ∷ pt ∷ dt ∷ raw ∷ []) with proxyOf p | baseOf b
  ... | just px | just base = byMark (pol pt) (dst dt)
    where
    pol : Str → Maybe (Maybe Policy)
    pol t = if eqStr t (toList "-") then just nothing else polOf (policyToken t)
      where
      polOf : Maybe Policy → Maybe (Maybe Policy)
      polOf (just x) = just (just x)
      polOf nothing  = nothing
    dst : Str → Maybe (Maybe Dest)
    dst t = if eqStr t (toList "-") then just nothing
            else if eqStr t (toList "js") then just (just destScript)
            else if eqStr t (toList "css") then just (just destStyle)
            else nothing
    byMark : Maybe (Maybe Policy) → Maybe (Maybe Dest) → Str
    byMark (just x) (just d) = answerReply raw (rewriteUrlWith px (mark x d) base raw)
    byMark _        _        = errorReply "BadRequest"
  ... | nothing | _ = errorReply "BadProxy"
  ... | just _  | nothing = errorReply "BadBase"
  rewriteMarkReq _ = errorReply "BadRequest"

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

  initRefReq : List Str → Str
  initRefReq (b ∷ c ∷ v ∷ []) with baseOf b | baseOf c
  ... | just base | just ctx = answer (initReferrer base ctx v)
    where
    answer : InitReferrer → Str
    answer initNone    = out []
    answer initClient  = out (toList "about:client")
    answer initError   = out (toList "TypeError")
    answer initOutside = errorReply "OutOfModel"
    answer (initUrl a) = out (href a)
  ... | _ | _ = errorReply "BadBase"
  initRefReq _ = errorReply "BadRequest"


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

  -- disposition <js|css|-> <0|1 Sec-Fetch-Dest present> <Sec-Fetch-Dest> <0|1 Content-Type present> <Content-Type> <0|1 sniffed>
  dispositionReq : List Str → Str
  dispositionReq (m ∷ sp ∷ sd ∷ cp ∷ ct ∷ sn ∷ []) =
    out (toList (Disposition.kindName (Disposition.responseKind dst (opt sp sd) (opt cp ct) (eqStr sn (toList "1")))))
    where
    dst : Maybe Dest
    dst = if eqStr m (toList "js") then just destScript else if eqStr m (toList "css") then just destStyle else nothing
    opt : Str → Str → Maybe Str
    opt p v = if eqStr p (toList "1") then just v else nothing
  dispositionReq _ = errorReply "BadRequest"

  -- crossorigin <html 0|1> <tag> <rel> <as>
  crossoriginReq : List Str → Str
  crossoriginReq (h ∷ t ∷ r ∷ a ∷ []) with Attrs.crossoriginValue (eqStr h (toList "1")) t r a
  ... | just v  = out v
  ... | nothing = out (toList "keep")
  crossoriginReq _ = errorReply "BadRequest"

  -- widenselector <proxy> <base> <selector>: the proxy's origin is the proxyBase
  widenSelectorReq : List Str → Str
  widenSelectorReq (p ∷ b ∷ sel ∷ []) with proxyOf p | baseOf b
  ... | just px | just base = out (Selectors.widenSelector (λ raw → answerText raw (rewriteUrl px base raw)) (trimSlash p) sel)
    where
    trimSlash : Str → Str
    trimSlash x = Data.List.Base.reverse (dropSlash (Data.List.Base.reverse x))
      where
      import Data.List.Base
      dropSlash : Str → Str
      dropSlash ('/' ∷ r) = r
      dropSlash r = r
  ... | nothing | _ = errorReply "BadProxy"
  ... | just _ | nothing = errorReply "BadBase"
  widenSelectorReq _ = errorReply "BadRequest"

  -- postdelivery <sender origin> <recipient origin> <targetOrigin>
  postDeliveryReq : List Str → Str
  postDeliveryReq (se ∷ re ∷ t ∷ []) = out (toList (deliveryName (Messaging.delivery se re t)))
    where
    deliveryName : Messaging.Delivery → String
    deliveryName Messaging.deliver = "deliver"
    deliveryName Messaging.drop    = "drop"
    deliveryName Messaging.throws  = "throw"
  postDeliveryReq _ = errorReply "BadRequest"

  setsPolicyReq : List Str → Str
  setsPolicyReq (d ∷ []) = out (if Referrer.setsPolicy d then toList "yes" else toList "no")
  setsPolicyReq _ = errorReply "BadRequest"

  sniffHtmlReq : List Str → Str
  sniffHtmlReq (b ∷ []) = out (if Disposition.sniffHtml b then toList "yes" else toList "no")
  sniffHtmlReq _ = errorReply "BadRequest"

  joinSp : List Str → Str
  joinSp []       = []
  joinSp (x ∷ []) = x
  joinSp (x ∷ xs) = x ++ fromℕ 32 ∷ joinSp xs

  -- acceptch <field lines, LF-separated>
  acceptCHReq : List Str → Str
  acceptCHReq (ls ∷ []) with Hints.acceptCH (splitOn (is 10) ls)
  ... | just ns = out (joinSp ns)
  ... | nothing = out (toList "none")
  acceptCHReq _ = errorReply "BadRequest"

  -- hintsent <hint> <set, space-separated> <secure 0|1> <navigation 0|1> <same page 0|1>
  hintSentReq : List Str → Str
  hintSentReq (h ∷ set ∷ s₁ ∷ n₁ ∷ p₁ ∷ []) =
    out (if Hints.hintSent h (splitOn (is 32) set) (eqStr s₁ (toList "1")) (eqStr n₁ (toList "1")) (eqStr p₁ (toList "1")) then toList "yes" else toList "no")
  hintSentReq _ = errorReply "BadRequest"

  -- metadatasent <header name> <trustworthy 0|1>
  metadataSentReq : List Str → Str
  metadataSentReq (n ∷ t ∷ []) = out (if Metadata.sentTo n (eqStr t (toList "1")) then toList "yes" else toList "no")
  metadataSentReq _ = errorReply "BadRequest"

  fetchLaterSizeReq : List Str → Str
  fetchLaterSizeReq (h ∷ hs ∷ b ∷ n ∷ []) =
    answer (FetchLater.requestSize h (if Data.List.Base.null hs then [] else Data.List.Base.map pair (splitOn (is 10) hs)) (body b) (Url.digitsValue n))
    where
    answer : Maybe ℕ → Str
    answer (just k) = out (showN k)
    answer nothing  = out (toList "unknown-length")
    pair : Str → Str × Str
    pair l with Url.break (is 58) l
    ... | k , (_ ∷ v) = k , v
    ... | k , []      = k , []
    body : Str → FetchLater.Body
    body x = if eqStr x (toList "text") then FetchLater.text
      else if eqStr x (toList "params") then FetchLater.params
      else if eqStr x (toList "buffer") then FetchLater.buffer
      else if eqStr (Data.List.Base.take 5 x) (toList "blob:") then FetchLater.blob (Data.List.Base.drop 5 x)
      else FetchLater.noBody
  fetchLaterSizeReq _ = errorReply "BadRequest"

  htmlTailReq : List Str → Str
  htmlTailReq (f ∷ m ∷ []) with HtmlTok.tail (eqStr f (toList "1")) m
  ... | just k  = out (showN k)
  ... | nothing = out (toList "none")
  htmlTailReq (f ∷ []) = out (toList "none")
  htmlTailReq _ = errorReply "BadRequest"

  yn : Bool → Str
  yn b = out (toList (if b then "yes" else "no"))

  ctArg : Str → Maybe Str
  ctArg t = if eqStr t (toList "-") then nothing else just t

  sheetReq : List Str → Str
  sheetReq (q ∷ so ∷ ct ∷ ns ∷ []) = yn (Disposition.sheetApplies (eqStr q (toList "1")) (eqStr so (toList "1")) (ctArg ct) (eqStr ns (toList "1")))
  sheetReq _ = errorReply "BadRequest"

  orbReq : List Str → Str
  orbReq (ct ∷ b ∷ []) = yn (Orb.blocks (ctArg ct) b)
  orbReq _ = errorReply "BadRequest"

  orbProxyReq : List Str → Str
  orbProxyReq (co ∷ rd ∷ ct ∷ a ∷ b ∷ []) = yn (Orb.proxyBlocks (eqStr co (toList "1")) (eqStr rd (toList "1")) (ctArg ct) (eqStr a (toList "1")) b)
  orbProxyReq _ = errorReply "BadRequest"

  sheetNosniffReq : List Str → Str
  sheetNosniffReq (so ∷ ct ∷ ns ∷ []) = yn (Disposition.addNosniff (eqStr so (toList "1")) (ctArg ct) (eqStr ns (toList "1")))
  sheetNosniffReq _ = errorReply "BadRequest"

  refererRouteReq : List Str → Str
  refererRouteReq (p ∷ r ∷ pa ∷ q ∷ []) with proxyOf p
  ... | nothing = errorReply "BadProxy"
  ... | just px with Route.refererRoute px r pa q
  ...   | just d  = out d
  ...   | nothing = out (toList "none")
  refererRouteReq _ = errorReply "BadRequest"

  joinComma : List Str → Str
  joinComma [] = []
  joinComma (x ∷ []) = x
  joinComma (x ∷ xs) = x ++ fromℕ 44 ∷ joinComma xs

  joinNL : List Str → Str
  joinNL [] = []
  joinNL (x ∷ []) = x
  joinNL (x ∷ xs) = x ++ fromℕ 10 ∷ joinNL xs

  frameOriginReq : List Str → Str
  frameOriginReq (ob ∷ d ∷ src ∷ mine ∷ []) with Frames.frameOrigin (eqStr ob (toList "1")) (eqStr d (toList "1")) src
  ... | Frames.originOf o = out (if eqStr o mine then toList "same" else toList "cross")
  ... | Frames.creator    = out (toList "same")
  ... | Frames.opaqueF    = out (toList "opaque")
  frameOriginReq _ = errorReply "BadRequest"

  frameOriginOfReq : List Str → Str
  frameOriginOfReq (ob ∷ d ∷ src ∷ []) with Frames.frameOrigin (eqStr ob (toList "1")) (eqStr d (toList "1")) src
  ... | Frames.originOf o = out o
  ... | Frames.creator    = out (toList "creator")
  ... | Frames.opaqueF    = out (toList "opaque")
  frameOriginOfReq (ob ∷ d ∷ []) = frameOriginOfReq (ob ∷ d ∷ [] ∷ [])
  frameOriginOfReq _ = errorReply "BadRequest"

  workerRunsReq : List Str → Str
  workerRunsReq (m ∷ t ∷ []) = out (if WorkerSource.runs (eqStr m (toList "1")) t then toList "yes" else toList "no")
  workerRunsReq (m ∷ []) = out (if WorkerSource.runs (eqStr m (toList "1")) [] then toList "yes" else toList "no")
  workerRunsReq _ = errorReply "BadRequest"

  fetchLaterAdmitReq : List Str → Str
  fetchLaterAdmitReq (u ∷ n ∷ []) with FetchLater.admit (Url.digitsValue u) (Url.digitsValue n)
  ... | nothing = out (toList "ok")
  ... | just m  = out m
  fetchLaterAdmitReq _ = errorReply "BadRequest"

  priorityReq : List Str → Str
  priorityReq (d ∷ m ∷ me ∷ pu ∷ []) with Priority.priority d m me pu
  ... | just v  = out v
  ... | nothing = out (toList "none")
  priorityReq (d ∷ m ∷ me ∷ []) with Priority.priority d m me []
  ... | just v  = out v
  ... | nothing = out (toList "none")
  priorityReq _ = errorReply "BadRequest"

  oneArg : (Str → Str) → List Str → Str
  oneArg f (v ∷ []) = out (f v)
  oneArg f _        = out (f [])

  framedLengthReq : List Str → Str
  framedLengthReq (p ∷ d ∷ c ∷ []) with Carry.digitsValue d | Carry.digitsValue c
  ... | just dn | just cn = out (Url.showN (Carry.framedLength (eqStr p (toList "h2")) dn cn))
  ... | _       | _       = errorReply "BadRequest"
  framedLengthReq _ = errorReply "BadRequest"

  twoArgs : (Str → Str → Str) → List Str → Str
  twoArgs f (a ∷ b ∷ []) = out (f a b)
  twoArgs f _            = errorReply "BadRequest"

  threeArgs : (Str → Str → Str → Str) → List Str → Str
  threeArgs f (a ∷ b ∷ c ∷ []) = out (f a b c)
  threeArgs f _                = errorReply "BadRequest"

  -- storagekey <ancestor sites, top first, space-separated> <site> <origin>
  storageKeyReq : List Str → Str
  storageKeyReq (a ∷ s ∷ o ∷ []) = out (Storage.partitionKey (if Data.List.Base.null a then [] else splitOn (is 32) a) s o)
    where import Data.List.Base
  storageKeyReq _ = errorReply "BadRequest"

  -- storageaccess <mode> <dest> <include|omit|same-origin> <chain sites, space-separated> <from origin> <to origin> <target site> <trustworthy 0|1>
  storageAccessReq : List Str → Str
  storageAccessReq (m ∷ d ∷ c ∷ ch ∷ f ∷ t ∷ ts ∷ tw ∷ []) =
    out (if Storage.storageAccess m d cred (splitOn (is 32) ch) f t ts (eqStr tw (toList "1")) then toList "active" else toList "none")
    where
    cred : Storage.Credentials
    cred = if eqStr c (toList "include") then Storage.include else if eqStr c (toList "omit") then Storage.omit else Storage.sameOrigin
  storageAccessReq _ = errorReply "BadRequest"

  -- allowframe <attr> <feature> <default * 0|1> <parent> <src origin> <frame origin>
  allowFrameReq : List Str → Str
  allowFrameReq (a ∷ f ∷ d ∷ p ∷ sr ∷ fr ∷ []) =
    out (if Allow.frameAllows (eqStr d (toList "1")) a f p sr fr then toList "yes" else toList "no")
  allowFrameReq _ = errorReply "BadRequest"

  -- fpallows <Permissions-Policy lines, LF-separated> <Feature-Policy> <feature> <default * 0|1> <doc> <origin>
  fpAllowsReq : List Str → Str
  fpAllowsReq (pp ∷ fp ∷ f ∷ d ∷ doc ∷ o ∷ []) =
    out (if Allow.fpAllows (eqStr d (toList "1")) (ppLines pp) fp f doc o then toList "yes" else toList "no")
    where
    ppLines : Str → List Str
    ppLines [] = []
    ppLines x  = splitOn (is 10) x
  fpAllowsReq _ = errorReply "BadRequest"

  fpRewriteReq : List Str → Str
  fpRewriteReq (a ∷ []) = out (Allow.rewriteFeaturePolicy a)
  fpRewriteReq _ = errorReply "BadRequest"

  allowRewriteReq : List Str → Str
  allowRewriteReq (a ∷ []) = out (Allow.rewriteAllow a)
  allowRewriteReq _ = errorReply "BadRequest"

  -- ppallows <field lines, LF-separated> <feature> <default * 0|1> <doc origin> <origin>
  ppAllowsReq : List Str → Str
  ppAllowsReq (ls ∷ f ∷ d ∷ doc ∷ o ∷ []) =
    out (if Permissions.allows (eqStr d (toList "1")) (splitOn (is 10) ls) f doc o then toList "yes" else toList "no")
  ppAllowsReq _ = errorReply "BadRequest"

  -- pptranslate <field lines, LF-separated> → the lines, LF-separated
  ppTranslateReq : List Str → Str
  ppTranslateReq (ls ∷ []) = out (joinLF (Permissions.translate (splitOn (is 10) ls)))
    where
    joinLF : List Str → Str
    joinLF []       = []
    joinLF (x ∷ []) = x
    joinLF (x ∷ xs) = x ++ fromℕ 10 ∷ joinLF xs
  ppTranslateReq _ = errorReply "BadRequest"

  upgradableReq : List Str → Str
  upgradableReq (h ∷ r ∷ []) = out (if Upgrades.upgradable (eqStr r (toList "1")) h then toList "yes" else toList "no")
  upgradableReq _ = errorReply "BadRequest"

  swapSchemeReq : List Str → Str
  swapSchemeReq (f ∷ t ∷ x ∷ []) with Upgrades.swapScheme f t x
  ... | just y  = out y
  ... | nothing = out (toList "none")
  swapSchemeReq _ = errorReply "BadRequest"

  -- upgradesteps <events, space-separated: n<t> (an http navigation at t),
  -- l (the https page loaded), f<t> (its load failed at t)>
  --   → the decisions: U (upgrade sent) / P (passed), B (fell back) / -
  upgradeStepsReq : List Str → Str
  upgradeStepsReq (es ∷ []) = out (run (splitOn (is 32) es) (Upgrades.hostState nothing nothing))
    where
    run : List Str → Upgrades.HostState → Str
    run [] _ = []
    run ((c ∷ t) ∷ rest) st =
      if is 110 c then step₁ (Upgrades.onHttpNavigation (digitsValue t) st)
      else if is 108 c then run rest (Upgrades.onLoaded st)
      else if is 102 c then step₂ (Upgrades.onFailed (digitsValue t) st)
      else run rest st
      where
      step₁ : Upgrades.Decision × Upgrades.HostState → Str
      step₁ (Upgrades.sendUpgrade , st′) = 'U' ∷ run rest st′
      step₁ (Upgrades.passThrough , st′) = 'P' ∷ run rest st′
      step₂ : Bool × Upgrades.HostState → Str
      step₂ (true , st′)  = 'B' ∷ run rest st′
      step₂ (false , st′) = '-' ∷ run rest st′
    run ([] ∷ rest) st = run rest st
  upgradeStepsReq _ = errorReply "BadRequest"

  -- secchua <major> <product brand>
  secChUaReq : List Str → Str
  secChUaReq (m ∷ p ∷ []) = out (Hints.secChUa (digitsValue m) p)
  secChUaReq _ = errorReply "BadRequest"

  unproxyQueryReq : List Str → Str
  unproxyQueryReq (p ∷ q ∷ []) with proxyOf p
  ... | just px = out (Query.unproxyQuery px q)
  ... | nothing = errorReply "BadProxy"
  unproxyQueryReq _ = errorReply "BadRequest"

  jsonBytesReq : List Str → Str
  jsonBytesReq (v ∷ []) = out (Carry.jsonBytes v)
  jsonBytesReq _ = errorReply "BadRequest"

  -- crnh <entries>: one per line, "name\tn" (null) or "name\tv\tvalue\tvalue…"
  crnHReq : List Str → Str
  crnHReq (e ∷ []) = out (Carry.crnH (entries (splitOn (is 10) e)))
    where
    entries : List Str → List (Str × Maybe (List Str))
    entries [] = []
    entries (l ∷ ls) with splitOn (is 9) l
    ... | n ∷ k ∷ vs = (n , (if eqStr k (toList "n") then nothing else just vs)) ∷ entries ls
    ... | _          = entries ls
  crnHReq _ = errorReply "BadRequest"

  crnbReadReq : List Str → Str
  crnbReadReq (d ∷ []) with Carry.crnbRead d
  ... | just (e , x) = out (showN e ++ fromℕ 32 ∷ showN x)
  ... | nothing      = out (toList "none")
  crnbReadReq _ = errorReply "BadRequest"

  -- wsmark <0|1 the URL has a query> <query> <origin>
  wsMarkReq : List Str → Str
  wsMarkReq (h ∷ q ∷ o ∷ []) = out (WsOrigin.marked (if eqStr h (toList "1") then just q else nothing) o)
  wsMarkReq _ = errorReply "BadRequest"

  -- wssplit <query, without its "?"> → "none" / "<1|0>\t<page query>\t<encoded origin>"
  wsSplitReq : List Str → Str
  wsSplitReq (q ∷ []) with WsOrigin.split q
  ... | just (just r , v)  = out (toList "1" ++ fromℕ 9 ∷ r ++ fromℕ 9 ∷ v)
  ... | just (nothing , v) = out (toList "0" ++ fromℕ 9 ∷ [] ++ fromℕ 9 ∷ v)
  ... | nothing            = out (toList "none")
  wsSplitReq _ = errorReply "BadRequest"

  refreshReadReq : List Str → Str
  refreshReadReq (v ∷ []) = out (shown (Refresh.read v))
    where
    shown : Refresh.Reading → Str
    shown Refresh.notRefresh         = toList "none"
    shown Refresh.reload             = toList "reload"
    shown (Refresh.navigate _ u _)   = toList "url" ++ fromℕ 9 ∷ u
  refreshReadReq _ = errorReply "BadRequest"

  refreshReq : List Str → Str
  refreshReq (p ∷ b ∷ v ∷ []) with proxyOf p | baseOf b
  ... | just px | just base = out (Refresh.rewriteRefresh rw v)
    where
    rw : Str → Maybe Str
    rw u with rewriteUrl px base u
    ... | emit _ x = just x
    ... | _        = nothing
  ... | nothing | _ = errorReply "BadProxy"
  ... | just _  | nothing = errorReply "BadBase"
  refreshReq _ = errorReply "BadRequest"

  targetDestReq : List Str → Str
  targetDestReq (u ∷ []) with parse nothing (preprocess u)
  ... | url a = maybeOut (named (targetDest (path a)))
    where
    named : Maybe Dest → Maybe Str
    named (just d) = just (toList (destName d))
    named nothing  = nothing
  ... | _ = maybeOut nothing
  targetDestReq _ = errorReply "BadRequest"


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

  originUrl : Str → Str → Str → Str → Str → Str
  originUrl m sm p f t with modeOf m | policyToken p | baseOf f | baseOf t
  ... | just mode | just pol | just from | just to =
    maybeOut (originHeader mode (eqStr sm (toList "safe")) pol from to)
  ... | _ | _ | _ | _ = errorReply "OutOfModel"

  originReq : List Str → Str
  originReq (m ∷ sm ∷ p ∷ f ∷ t ∷ []) with eqStr f (toList "null") | modeOf m
  ... | true | just mode = maybeOut (originHeaderOpaque mode (eqStr sm (toList "safe")))
  ... | true | nothing   = errorReply "OutOfModel"
  ... | false | _ = originUrl m sm p f t
  originReq _ = errorReply "BadRequest"

  siteReq : List Str → Str
  siteReq (f ∷ fs ∷ t ∷ ts ∷ []) with eqStr f (toList "null")
  ... | true = out (toList (siteName secFetchSiteOpaque))
  ... | false with baseOf f | baseOf t
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

  -- "-": absent; "=x": x.
  optional : Str → Maybe Str
  optional (c ∷ cs) = if is 61 c then just cs else nothing
  optional []       = nothing

  storeErr : StoreErr → Str
  storeErr emptyNameEq    = toList "!emptyNameEq"
  storeErr emptyBoth      = toList "!emptyBoth"
  storeErr domainDot      = toList "!domainDot"
  storeErr hostDomain     = toList "!hostDomain"
  storeErr domainMismatch = toList "!domainMismatch"
  storeErr nameEq         = toList "!nameEq"
  storeErr pathSlash      = toList "!pathSlash"
  storeErr hostPath       = toList "!hostPath"
  storeErr malformed      = toList "!malformed"

  storeOut : StoreResult → Str
  storeOut (rejected e) = out (storeErr e)
  storeOut (stored c)   = out (wireName c ++ fromℕ 10 ∷ wireValue c)

  cookieStoreSetReq : List Str → Str
  cookieStoreSetReq (g ∷ ps ∷ u ∷ n ∷ v ∷ d ∷ p ∷ ss ∷ []) with baseOf u
  ... | nothing = errorReply "OutOfModel"
  ... | just base = storeOut (cookieStoreSet (eqStr g (toList "later")) (eqStr ps (toList "yes")) base (mkStoreSet n v (optional d) (optional p) sso))
    where
    sso : SameSite
    sso = if eqStr ss (toList "n") then ssNone else if eqStr ss (toList "l") then ssLax else ssStrict
  cookieStoreSetReq _ = errorReply "BadRequest"

  cookieStoreDeleteReq : List Str → Str
  cookieStoreDeleteReq (g ∷ ps ∷ u ∷ n ∷ d ∷ p ∷ []) with baseOf u
  ... | nothing = errorReply "OutOfModel"
  ... | just base = storeOut (cookieStoreDelete (eqStr g (toList "later")) (eqStr ps (toList "yes")) base n (optional d) (optional p))
  cookieStoreDeleteReq _ = errorReply "BadRequest"

  -- One line per item: name TAB value TAB domain ("-": host-only) TAB path TAB sameSite TAB secure.
  cookieStoreGetReq : List Str → Str
  cookieStoreGetReq (u ∷ n ∷ jar ∷ []) with baseOf u
  ... | nothing = errorReply "OutOfModel"
  ... | just base = out (itemLines (cookieStoreQuery base (optional n) jar))
    where
    item : Stored → Str
    item c = sName c ++ fromℕ 9 ∷ sValue c ++ fromℕ 9 ∷ (if sHostOnly c then toList "-" else sDomain c)
             ++ fromℕ 9 ∷ sPath c ++ fromℕ 9 ∷ itemSameSite (sSameSite c) ++ fromℕ 9 ∷ toList (if sSecure c then "yes" else "no")
    itemLines : List Stored → Str
    itemLines []       = []
    itemLines (c ∷ []) = item c
    itemLines (c ∷ d ∷ cs) = item c ++ fromℕ 10 ∷ itemLines (d ∷ cs)
  cookieStoreGetReq _ = errorReply "BadRequest"

  yesNo : Bool → Str
  yesNo b = out (toList (if b then "yes" else "no"))

  -- A header's field lines, LF-separated; empty: none.
  fieldLines : Str → List Str
  fieldLines [] = []
  fieldLines v  = splitOn (is 10) v

  credOf : Str → Maybe Bool
  credOf x = if eqStr x (toList "cred") then just true
             else if eqStr x (toList "nocred") then just false else nothing

  namesContextReq : List Str → Str
  namesContextReq (a ∷ b ∷ c ∷ []) = yesNo (namesContext (eqStr a (toList "yes")) (eqStr b (toList "yes")) (eqStr c (toList "yes")))
  namesContextReq _ = errorReply "BadRequest"

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
    -- an import map's URLs are module URLs: marked as scripts
    rw : Str → Maybe Str
    rw u with rewriteUrlWith px (mark nothing (just destScript)) base u
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

  -- urldest <html|svg> <tag> <attr> <rel types, space-separated> <as|->
  urlDestReq : List Str → Str
  urlDestReq (n ∷ t ∷ a ∷ rel ∷ as ∷ []) =
    out (dname (Attrs.urlDest (if eqStr n (toList "svg") then Attrs.svgNs else Attrs.htmlNs) t a (relWords rel)
                 (if eqStr as (toList "-") then nothing else just as)))
    where
    dname : Maybe Dest → Str
    dname (just d) = toList (destName d)
    dname nothing  = toList "-"
    relWords : Str → List Str
    relWords s = drop0 (splitOn (is 32) s)
      where
      drop0 : List Str → List Str
      drop0 []        = []
      drop0 ([] ∷ vs) = drop0 vs
      drop0 (v ∷ vs)  = v ∷ drop0 vs
  urlDestReq _ = errorReply "BadRequest"

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
    rw : Maybe Dest → Str → Maybe Str
    rw d u with rewriteUrlWith px (mark nothing d) base u
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

  linkReq : List Str → Str
  linkReq (p ∷ b ∷ h ∷ []) with proxyOf p | baseOf b
  ... | just px | just base = out (Link.rewriteLink rwd (rewriteSrcset (λ u → keepOr u (rw u))) h)
    where
    rwd : Maybe Dest → Str → Maybe Str
    rwd d u with rewriteUrlWith px (mark nothing d) base u
    ... | emit _ v = just v
    ... | _        = nothing
    rw : Str → Maybe Str
    rw = rwd nothing
    keepOr : Str → Maybe Str → Str
    keepOr u (just v) = v
    keepOr u nothing  = u
  ... | nothing | _ = errorReply "BadProxy"
  ... | just _  | nothing = errorReply "BadBase"
  linkReq _ = errorReply "BadRequest"

  linkPreloadsReq : List Str → Str
  linkPreloadsReq (h ∷ []) = out (joinP (Link.links h))
    where
    one : Str × Str × List Str → Str
    one (t , a , rs) = t ++ fromℕ 9 ∷ a ++ fromℕ 9 ∷ Link.joinWith (fromℕ 32) rs
    joinP : List (Str × Str × List Str) → Str
    joinP []       = []
    joinP (x ∷ []) = one x
    joinP (x ∷ y ∷ xs) = one x ++ nl ∷ joinP (y ∷ xs)
  linkPreloadsReq _ = errorReply "BadRequest"

  htmlTagsReq : List Str → Str
  htmlTagsReq (f ∷ text ∷ []) = out (joinL (HtmlTok.startTags (eqStr f (toList "1")) text))
    where
    joinL : List Str → Str
    joinL []           = []
    joinL (u ∷ [])     = u
    joinL (u ∷ v ∷ us) = u ++ nl ∷ joinL (v ∷ us)
  htmlTagsReq _ = errorReply "BadRequest"

  htmlTagsInReq : List Str → Str
  htmlTagsInReq (f ∷ n ∷ nm ∷ e ∷ text ∷ []) =
    out (joinT (HtmlTok.startTagsOf (HtmlTok.tokensIn (eqStr f (toList "1")) ns nm enc text)))
    where
    ns : HtmlTok.Ns3
    ns = if eqStr n (toList "svg") then HtmlTok.nsSvg else if eqStr n (toList "math") then HtmlTok.nsMath else HtmlTok.nsHtml
    enc : Maybe Str
    enc = if eqStr e (toList "-") then nothing else just e
    joinT : List Str → Str
    joinT []           = []
    joinT (u ∷ [])     = u
    joinT (u ∷ v ∷ us) = u ++ nl ∷ joinT (v ∷ us)
  htmlTagsInReq _ = errorReply "BadRequest"

  htmlSpansReq : List Str → Str
  htmlSpansReq (text ∷ []) = out (joinS (HtmlTok.startSpans text))
    where
    joinS : List Str → Str
    joinS []           = []
    joinS (u ∷ [])     = u
    joinS (u ∷ v ∷ us) = u ++ nl ∷ joinS (v ∷ us)
  htmlSpansReq _ = errorReply "BadRequest"

  bootAtReq : List Str → Str
  bootAtReq (m ∷ text ∷ []) = out (HtmlTok.withBootstrap m text)
  bootAtReq _ = errorReply "BadRequest"

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
