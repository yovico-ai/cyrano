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
--   sniff <body>                       → {"out":"<html><xml>"} each 1|0 (Disposition.sniffOf)
--   disposition … <sniffed html> [<xml magic>] (0 when absent)
--   metadatasent <name> <0|1>          → {"out":"yes"|"no"} (reaches a target of that trustworthiness)
--   dictae <accept-encoding>            → {"out":"<without dcb/dcz>"} (Dictionary.acceptEncoding)
--   dictreg <use-as-dictionary>         → {"out":"<as the browser is given it>"}
--   dictoffer <request header name>     → {"out":"yes"|"no"} (removed: a dictionary offer)
--   priority <dest> <mode> <method> <purpose> → {"out":"<Priority>"|"none"}
--   fetchlatersize <href> <headers k:v, LF> <none|text|params|buffer|blob:type> <body bytes> → {"out":"<n>"|"unknown-length"}
--   frameorigin <object 0|1> <srcdoc 0|1> <src as read> <creator origin> → {"out":"same"|"cross"|"opaque"}
--   netdest <proxy> <destination>      → {"out":"<where the navigation goes instead>"|"none"} (Route.netDestination)
--   framedest <has sandbox 0|1> <sandbox>  → {"out":"frame"|"inert"} (Frames.frameDest)
--   inertframe <mark inert 0|1> <marked 0|1> <recorded 0|1> → {"out":"yes"|"no"} (Frames.inertFrame)
--   frameruntime <held 0|1> <pending|blank|booted|bare|inert> → {"out":"none"|"creators"|"own"|"creators-own-url"} (Frames.frameRuntime)
--   embedder <marked 0|1> <recorded embedder|"-"> <referer document> → {"out":"<the embedder>"} (Frames.embedderOf)
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
--   toolbarleft <vw> <width> <start> <grab> <now> → {"out":"<left>"} (Toolbar.dragLeft)
--   toolbarplace <vw> <width> <left>   → {"out":"<left>"} (Toolbar.placeLeft)
--   toolbarinitial <vw> <width>        → {"out":"<left>"} (Toolbar.initialLeft)
--   toolbarregion <left> <width> <height> <grip> <jump> <x> <y> → {"out":"outside"|"grip"|"toLeft"|"home"|"toRight"}
--   toolbarcursor <dragging 0|1> <left> <width> <height> <grip> <jump> <x> <y> → {"out":"page"|"grab"|"grabbing"|"pointer"}
--   toolbarright <vw> <width>          → {"out":"<left>"} (Toolbar.rightEnd; the left end is 0)
--   orbblocks <ct|"-"> <body>         → {"out":"yes"|"no"} (ORB blocks a cross-origin no-cors script)
--   unchan <in|out> <name> <value> → the channel entry read back (lines: h|d, domain, path, name, value,
--     s|i, samesite, priority, expiry ""|x|seconds, number, applied|-), or null
--   chan <in|out> <url> <set-cookie> <expiry ""|x|ms[.µs]> <number> <applied|-> → name LF value of the
--     channel entry for the cookie the Set-Cookie stores at url (http), or null
--   jar <script> → the jar after the script (lines, fields U+001F):
--     put <api|http> <now> <site> <url> <set-cookie> | outbox <now> <site> <name> <value> | touch <now> <url> | end
--     out: "E" scope flags expiry created accessed order site value, per entry; "G" gen; "I" name value, per inbox change
--   unpack <slot value> → its records, lines "name U+001F value"
--   pack <name U+001F value U+001F …> → the slot value of those records
--   mem <script> → a runtime's memory after the script (lines, fields U+001F):
--     absorb <inbox name> <inbox value> | write <outbox name> <outbox value> |
--     snap <url> <gen> (<inbox name> <inbox value>)* | read <now> <url> | ack <n> <gen>
--     out: "R" cookie string, per read; "K" scope flags expiry gen pending|- value, per known cookie
--   cookiedate <Expires string> → {"out":"<seconds after the epoch, 0 before it>"|"none"}
--   (jar: times in µs after the epoch; mem: in ms, as the runtime keeps them)
--   orbproxy <cross-origin 0|1> <redirect 0|1> <ct|"-"> <no-cors 0|1> <body> → {"out":"yes"|"no"} (the proxy fails it: ORB)
--   sheetnosniff <same-origin 0|1> <ct|"-"> <nosniff 0|1> → {"out":"yes"|"no"} (the proxy adds nosniff)
--   htmltail <scripting 0|1> <markup>  → {"out":"<offset>"|"none"} (where an unfinished construct at the end begins)
--   nosniff <field lines, LF>          → {"out":"yes"|"no"} (X-Content-Type-Options says nosniff)
--   workerruns <module 0|1> <mime>      → {"out":"yes"|"no"} (a blob:/data: worker runs)
--   mixed <context|-> <target> <dest|-> [set] → {"out":"allow"|"upgrade"|"block"} (MixedContent.mixed; set: a srcset's image)
--   xmlrw <document>                    → {"out":"<the document rewritten by the stand-ins (XmlDoc.agda)>"}
--   specrules <proxy> <base> <header>   → {"out":"<the Speculation-Rules value the browser is given>"}
--   dataurl <url>                       → {"out":"none"} (given as is) or
--                                         {"out":"<rewritable 0|1>\t<head>\t<bytes, hex>\t<wrapped URL of those bytes>"}
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
--   altsvc <header>                     → {"out":"clear"} or {"out":"<proto>\t<host>\t<port>\t<ma>" lines joined by "\n"} (Alpn.readAltSvc)
--   h3proto <scheme> <host> <port> <rr alpn, comma-joined|-> <alt-svc header|-> <broken 0|1> → {"out":"h3"|"h2"} (Alpn.protocol)
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
--   origin  <mode> <safe|unsafe> <policy> <from> <to> [<dest>]
--                                       → {"out":"…"} / {"none":true}
--   setcookie <api|http> <ps|nops> <url> <set-cookie-string>
--                                       → {"out":"<12 lines>"} / {"none":true}
--                                         lines: h|d, domain, path, name, value,
--                                         s|i, H|-, n|l|t|u, "="maxAge|"",
--                                         "="expires|"", wire name, wire value
--   samesite <n|l|t|u> <same|cross> <nav|other> [<top|other> <age ms>]
--                                       → {"out":"yes"} / {"out":"no"}
--   cookies <api|http> <url> <jar "n=v; n=v">
--                                       → {"out":"a=1; b=2"}
--   site    <from> <fromSite|-> <to> <toSite|->
--                                       → {"out":"same-origin|same-site|cross-site"}
--   uirdeclared <CSP header>             → yes/no
--   uir <context|-> <target> <dest|->   → yes/no: an upgrade-insecure-requests document upgrades it
--   encquery <special|other> <query>   → {"out":"<the query, latin1, percent-encoded>"}
--   corp <CORP|-> <none|require-corp|credentialless> <yes|no> <origin> <site|-> <target> <site|-> → block/allow
--   challenge <site> <WWW-Authenticate line> → {"out":"<the line the browser gets>"}
--   clearsitedata <yes|no> <value>      → yes/no: it clears the response's site's cookies
--   storable <top> <cross|same> <Set-Cookie>   → {"out":"<partition key>|-|refused|malformed"}
--   inctx <script|http> <top> <cross|same> <key|-> <n|l|t|u> → yes/no
--   cookiestoreset <139|later> <ps yes|no> <url> <name> <value> <-|=domain> <-|=path> <n|l|t>
--   cookiestoredelete <139|later> <ps yes|no> <url> <name> <-|=domain> <-|=path>
--                                       → {"out":"!<error>"} / {"out":"<wire name>\n<wire value>"}
--   cookiestoreget <url> <-|=name> <jar>   → {"out":"name\tvalue\tdomain|-\tpath\tsameSite\tyes|no\n…"}
--   credentials <omit|same-origin|include> <same|cross>
--   namescontext <opaque> <cross> <unreferred> <cors mode>   (each yes|no) → yes|no
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
--   ruleset <proxy> <base> <text>       → {"out":"<the speculation rule set rewritten>"} (Speculation.rewriteRuleSet)
--   importmapintegrity <base> <url> <map> [<map> …] → the URL's integrity metadata, maps merged | -
--   attrkind <html|svg> <tag> <attr>    → {"out":"url|urllist|srcset|css|reflected|handler|none"}
--   urldest <html|svg> <tag> <attr> <rel types> <as|-> → {"out":"js|css|-"}
--   urllist <proxy> <base> <text>       → {"out":"<each token proxified>"}
--   animurls <proxy> <base> <text>      → {"out":"<each ';' item proxified>"}
--   attrkind <html|svg> <tag> <attr> <attributeName|->  (an animation's)
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
import CookieDate
import CookieJar
open import Data.Nat.Show using () renaming (show to showNat)
import Toolbar
import Refresh
import WsOrigin
import Carry
import Query
import Hints
import Upgrades
import Alpn
import Permissions
import Allow
import Storage
import Metadata
import Dictionary
import Priority
import FetchLater
import WorkerSource
import DataUrl
import Speculation
import ClearSiteData
import Auth
import Corp
import Encoding
import XmlDoc
import MixedContent
import Frames
import Stack
import H1
import Eval
import Payment
import AdAuction
import ErrorEvents
import LocalStore
import Route
import Features
import Messaging
import Selectors
import JsUrl
import Canvas
import Preflight
import XPath
import Sri
import Coop
import Lna
import Oac
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
  else if eqStr op (toList "targetintegrity") then targetIntegrityReq args
  else if eqStr op (toList "rewritemarki") then rewriteMarkIReq args
  else if eqStr op (toList "srimark") then sriMarkReq args
  else if eqStr op (toList "sripasses") then sriPassesReq args
  else if eqStr op (toList "srihonored") then sriHonoredReq args
  else if eqStr op (toList "srifails") then sriFailsReq args
  else if eqStr op (toList "cooptoken") then coopTokenReq args
  else if eqStr op (toList "lnaspace4") then lnaSpace4Req args
  else if eqStr op (toList "lnarefused") then lnaRefusedReq args
  else if eqStr op (toList "oacreads") then oacReadsReq args
  else if eqStr op (toList "csprefuses") then cspRefusesReq args
  else if eqStr op (toList "csprefusal") then out Csp.refusalLocation
  else if eqStr op (toList "csppairs") then cspPairsReq args
  else if eqStr op (toList "xsltype") then oneArg (λ t → if XmlDoc.xslType t then toList "yes" else toList "no") args
  else if eqStr op (toList "xslnet") then out XmlDoc.xslNetPolicy
  else if eqStr op (toList "sameoriginmode") then sameOriginModeReq args
  else if eqStr op (toList "corsorigin") then corsOriginReq args
  else if eqStr op (toList "coopof") then coopOfReq args
  else if eqStr op (toList "coopemulated") then coopEmulatedReq args
  else if eqStr op (toList "coopemulatedat") then coopEmulatedAtReq args
  else if eqStr op (toList "rewritemark") then rewriteMarkReq args
  else if eqStr op (toList "disposition") then dispositionReq args
  else if eqStr op (toList "judgeddest") then judgedDestReq args
  -- needspreflight <method> <force 0|1> [<name> <value>]…: "yes" / "no";
  -- preflightheaders [<name> <value>]…; maxage <0|1 present> <value>;
  -- preflightok <status> <0|1> <ACAO> <0|1> <ACAC> <cred 0|1> <origin>
  -- <method> <unsafe names, ","-joined> <ACAM lines, U+001E-joined> <ACAH lines, same>
  -- credblocked <userinfo 0|1> <Sec-Fetch-Dest>: "yes" when the proxy refuses the request
  else if eqStr op (toList "credblocked") then twoArgs (λ u d → toList (if Fetch.credentialsBlocked (eqStr u (toList "1")) d then "yes" else "no")) args
  -- domainset <host> <ip 0|1> <current> <value> <empty 0|1> <public suffix 0|1>: set:V | empty | tld:V | notsuffix:V:CURRENT
  else if eqStr op (toList "domainset") then domainSetReq args
  -- canintercept <document URL> <destination>: "yes" / "no" ("bad" when the document URL does not parse)
  else if eqStr op (toList "canintercept") then twoArgs (λ d t → interceptAnswer d t) args
  -- corsdest <Sec-Fetch-Dest>: "yes" when a cors-mode request of it is CORS-checked by the proxy
  else if eqStr op (toList "corsdest") then oneArg (λ d → toList (if Orb.corsElementDest d then "yes" else "no")) args
  -- responsetype <cors|no-cors|same-origin|navigate> <cross 0|1>: basic, cors or opaque
  else if eqStr op (toList "responsetype") then twoArgs (λ m c → toList (typeName (Fetch.responseType (fetchModeOf m) (eqStr c (toList "1"))))) args
  else if eqStr op (toList "needspreflight") then needsPreflightReq args
  else if eqStr op (toList "preflightheaders") then out (Preflight.requestHeaders (pairs args))
  else if eqStr op (toList "maxage") then maxAgeReq args
  else if eqStr op (toList "preflightok") then preflightOkReq args
  else if eqStr op (toList "sniffhtml") then sniffHtmlReq args
  else if eqStr op (toList "sniff") then sniffReq args
  else if eqStr op (toList "setspolicy") then setsPolicyReq args
  else if eqStr op (toList "postdelivery") then postDeliveryReq args
  else if eqStr op (toList "widenselector") then widenSelectorReq args
  -- widenxpath <proxy> <base> <expression>: the expression the DOM is given
  else if eqStr op (toList "widenxpath") then widenXPathReq args
  else if eqStr op (toList "crossorigin") then crossoriginReq args
  else if eqStr op (toList "refreshread") then refreshReadReq args
  else if eqStr op (toList "wsmark") then wsMarkReq args
  else if eqStr op (toList "jsonbytes") then jsonBytesReq args
  else if eqStr op (toList "unproxyquery") then unproxyQueryReq args
  else if eqStr op (toList "acceptch") then acceptCHReq args
  else if eqStr op (toList "hintsent") then hintSentReq args
  else if eqStr op (toList "secchua") then secChUaReq args
  else if eqStr op (toList "upgradable") then upgradableReq args
  else if eqStr op (toList "altsvc") then altSvcReq args
  else if eqStr op (toList "h3proto") then h3ProtoReq args
  else if eqStr op (toList "ppallows") then ppAllowsReq args
  else if eqStr op (toList "pptable") then ppTableReq args
  else if eqStr op (toList "ppallowlist") then ppAllowlistReq args
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
  else if eqStr op (toList "dataurl") then dataUrlReq args
  else if eqStr op (toList "frameorigin") then frameOriginReq args
  else if eqStr op (toList "htmltail") then htmlTailReq args
  else if eqStr op (toList "nosniff") then oneArg (λ v → if Disposition.nosniff (if Data.List.Base.null v then [] else splitOn (is 10) v) then toList "yes" else toList "no") args
  else if eqStr op (toList "sheetapplies") then sheetReq args
  else if eqStr op (toList "orbblocks") then orbReq args
  else if eqStr op (toList "toolbarleft") then toolbarLeftReq args
  else if eqStr op (toList "toolbarplace") then toolbarPlaceReq args
  else if eqStr op (toList "toolbarinitial") then toolbarInitialReq args
  else if eqStr op (toList "toolbarregion") then toolbarRegionReq args
  else if eqStr op (toList "toolbarcursor") then toolbarCursorReq args
  else if eqStr op (toList "toolbarright") then toolbarRightReq args
  else if eqStr op (toList "cookiedate") then oneArg (λ v → cdOut (CookieDate.cookieDate v)) args
  else if eqStr op (toList "orbproxy") then orbProxyReq args
  else if eqStr op (toList "sheetnosniff") then sheetNosniffReq args
  else if eqStr op (toList "featuresources") then oneArg (λ f → joinNL (Features.sources f)) args
  else if eqStr op (toList "featuresmap") then oneArg (Features.mapSources (λ v → fromℕ 91 ∷ v ++ fromℕ 93 ∷ [])) args
  else if eqStr op (toList "refererroute") then refererRouteReq args
  else if eqStr op (toList "evalcall") then evalCallReq args
  else if eqStr op (toList "adjoin") then adJoinReq args
  -- The stand-in for the JS rules: code naming 'x' becomes J(…), any other stays.
  else if eqStr op (toList "jsurl") then oneArg (λ u → JsUrl.rewriteUrl (λ c → if Url.any (Url.is 120) c then toList "J(" Data.List.Base.++ c Data.List.Base.++ toList ")" else c) u) args
  -- imageclean <0|1 crossorigin> <document origin> <url>: "yes" or "no".
  else if eqStr op (toList "imageclean") then threeArgs (λ c d u → toList (if Canvas.imageClean (eqStr c (toList "1")) d u then "yes" else "no")) args
  else if eqStr op (toList "datadockind") then oneArg (λ u → toList (dataDocName (Frames.dataDocKind u))) args
  else if eqStr op (toList "datadoc") then oneArg (λ u → toList (if Frames.dataDocument u then "yes" else "no")) args
  else if eqStr op (toList "errmuted") then errMutedReq args
  else if eqStr op (toList "paymentrefused") then oneArg (λ t → paymentAnswer (Payment.refused t)) args
  else if eqStr op (toList "blobbase") then oneArg (λ t → if Frames.blobBase t then toList "yes" else toList "no") args
  else if eqStr op (toList "blobdocument") then oneArg (λ t → if Frames.blobDocument t then toList "yes" else toList "no") args
  else if eqStr op (toList "opfsdir") then oneArg (λ k → Storage.opfsDir k) args
  -- fspath <key> <entry's page path> <given path>; fsshown <key> <real path>
  else if eqStr op (toList "fspath") then threeArgs (λ k a g → Storage.fsPath k a g) args
  else if eqStr op (toList "fsshown") then twoArgs (λ k r → Storage.shownPath k r) args
  else if eqStr op (toList "lockname") then twoArgs (λ k n → lockOut (Storage.lockName k n)) args
  else if eqStr op (toList "storename") then twoArgs (λ k n → Storage.stored k n) args
  else if eqStr op (toList "storeshown") then storeShownReq args
  else if eqStr op (toList "lsfits") then lsFitsReq args
  else if eqStr op (toList "h1head") then oneArg (λ v → joinNL (H1.h1Head (if Data.List.Base.null v then [] else splitOn (is 10) v))) args
  else if eqStr op (toList "h1orders") then oneArg (λ st → Data.List.Base.concatMap (λ ns → fromℕ 60 ∷ joinComma ns ++ fromℕ 62 ∷ []) (H1.recordsOf st)) args
  else if eqStr op (toList "framedlength") then framedLengthReq args
  else if eqStr op (toList "varyforbrowser") then oneArg Carry.varyForBrowser args
  else if eqStr op (toList "stackurls") then oneArg (λ st → joinNL (Stack.stackUrls st)) args
  else if eqStr op (toList "evalorigin") then twoArgs (λ n l → Stack.evalOrigin n l) args
  else if eqStr op (toList "untag") then threeArgs (λ t o f → Stack.untag t o f) args
  else if eqStr op (toList "streamorigin") then oneArg (λ u → streamOut (Messaging.streamOrigin u)) args
  else if eqStr op (toList "frameoriginof") then frameOriginOfReq args
  else if eqStr op (toList "embedder") then embedderReq args
  else if eqStr op (toList "framedest") then frameDestReq args
  else if eqStr op (toList "inertframe") then inertFrameReq args
  else if eqStr op (toList "frameruntime") then frameRuntimeReq args
  else if eqStr op (toList "netdest") then netDestReq args
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
  -- metapolicy <content>: the policy name, or nothing
  else if eqStr op (toList "metapolicy") then oneArg (λ c → metaAnswer c) args
  -- srcdocreferrer <policy> <parent URL>: a srcdoc frame's document.referrer
  else if eqStr op (toList "srcdocreferrer") then srcdocReq args
  else if eqStr op (toList "origin") then originReq args
  else if eqStr op (toList "site") then siteReq args
  else if eqStr op (toList "setcookie") then setCookieReq args
  else if eqStr op (toList "unchan") then unchanReq args
  else if eqStr op (toList "chan") then chanReq args
  else if eqStr op (toList "jar") then jarReq args
  else if eqStr op (toList "mem") then memReq args
  else if eqStr op (toList "storable") then storableReq args
  else if eqStr op (toList "clearsitedata") then csdReq args
  else if eqStr op (toList "challenge") then challengeReq args
  else if eqStr op (toList "corp") then corpReq args
  else if eqStr op (toList "encquery") then encQueryReq args
  else if eqStr op (toList "elemcookies") then elemCookiesReq args
  else if eqStr op (toList "markedcookies") then markedCookiesReq args
  else if eqStr op (toList "inctx") then inCtxReq args
  else if eqStr op (toList "unpack") then oneArg (λ v → lines (Data.List.Base.map (λ r → Data.Product.Base.proj₁ r ++ usC ∷ Data.Product.Base.proj₂ r) (CookieJar.unpackSlot v))) args
  else if eqStr op (toList "pack") then oneArg (λ v → CookieJar.packSlot (packArgs (splitOn (is 31) v))) args
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
  else if eqStr op (toList "ruleset") then ruleSetReq args
  else if eqStr op (toList "importmapintegrity") then importMapIntegrityReq args
  else if eqStr op (toList "urllike") then urlLikeReq args
  else if eqStr op (toList "attrkind") then attrKindReq args
  else if eqStr op (toList "urldest") then urlDestReq args
  else if eqStr op (toList "urllist") then urlListReq args
  else if eqStr op (toList "animurls") then animUrlsReq args
  else if eqStr op (toList "jsonobject") then jsonObjectReq args
  else if eqStr op (toList "link") then linkReq args
  else if eqStr op (toList "specrules") then specRulesReq args
  else if eqStr op (toList "xmlrw") then xmlRwReq args
  else if eqStr op (toList "xslrw") then oneArg (λ v → XmlDoc.rewriteXsl (λ u → 'P' ∷ u) v) args
  else if eqStr op (toList "mixed") then mixedReq args
  else if eqStr op (toList "uir") then uirReq args
  else if eqStr op (toList "uirdeclared") then uirDeclReq args
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
            else if eqStr t (toList "frame") then just (just destFrame)
            else if eqStr t (toList "inert") then just (just destInert)
            else if eqStr t (toList "set") then just (just destImageSet)
            else if eqStr t (toList "mjs") then just (just destModuleWorker)
            else if eqStr t (toList "cred") then just (just destCred)
            else if eqStr t (toList "jsc") then just (just destScriptCred)
            else if eqStr t (toList "cssc") then just (just destStyleCred)
            else if eqStr t (toList "anon") then just (just destAnon)
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

  -- rewritemarki <proxy> <base> <policy|-> <dest|-> <integrity mark> <url> (rewriteUrlWithI)
  markPol : Str → Maybe (Maybe Policy)
  markPol t = if eqStr t (toList "-") then just nothing else polOf (policyToken t)
    where
    polOf : Maybe Policy → Maybe (Maybe Policy)
    polOf (just x) = just (just x)
    polOf nothing  = nothing

  markDst : Str → Maybe (Maybe Dest)
  markDst t = if eqStr t (toList "-") then just nothing
              else if eqStr t (toList "js") then just (just destScript)
              else if eqStr t (toList "css") then just (just destStyle)
              else if eqStr t (toList "jsc") then just (just destScriptCred)
              else if eqStr t (toList "cssc") then just (just destStyleCred)
              else nothing

  rewriteMarkIReq : List Str → Str
  rewriteMarkIReq (p ∷ b ∷ pt ∷ dt ∷ it ∷ raw ∷ []) with proxyOf p | baseOf b | markPol pt | markDst dt
  ... | just px | just base | just x | just d = answerReply raw (rewriteUrlWithI px (mark x d) (just it) base raw)
  ... | _ | _ | _ | _ = errorReply "BadRequest"
  rewriteMarkIReq _ = errorReply "BadRequest"

  -- targetintegrity <url> → its integrity mark, or none
  targetIntegrityReq : List Str → Str
  targetIntegrityReq (u ∷ []) with parse nothing (preprocess u)
  ... | url a = maybeOut (targetIntegrity (path a))
  ... | _ = maybeOut nothing
  targetIntegrityReq _ = errorReply "BadRequest"

  -- srimark <metadata> → the mark, or none
  sriMarkReq : List Str → Str
  sriMarkReq (m ∷ []) = maybeOut (Sri.markOf m)
  sriMarkReq _ = errorReply "BadRequest"

  sriDigest : Str → Str → Str → Sri.Alg → Str
  sriDigest d1 d2 d3 Sri.sha256 = d1
  sriDigest d1 d2 d3 Sri.sha384 = d2
  sriDigest d1 d2 d3 Sri.sha512 = d3

  -- sripasses <mark> <sha256 digest> <sha384> <sha512> (canonical base64url) → yes|no
  sriPassesReq : List Str → Str
  sriPassesReq (m ∷ d1 ∷ d2 ∷ d3 ∷ []) = out (if Sri.passes m (sriDigest d1 d2 d3) then toList "yes" else toList "no")
  sriPassesReq _ = errorReply "BadRequest"

  -- srifails <mark|-> <eligible 0|1> <sha256> <sha384> <sha512> → yes|no
  sriFailsReq : List Str → Str
  sriFailsReq (m ∷ e ∷ d1 ∷ d2 ∷ d3 ∷ []) =
    out (if Sri.fails (if eqStr m (toList "-") then nothing else just m) (eqStr e (toList "1")) (sriDigest d1 d2 d3) then toList "yes" else toList "no")
  sriFailsReq _ = errorReply "BadRequest"

  -- srihonored <svg 0|1> <tag> <attr> <rels, space-separated> → yes|no
  sriHonoredReq : List Str → Str
  sriHonoredReq (sv ∷ t ∷ a ∷ rs ∷ []) = out (if Sri.honored (eqStr sv (toList "1")) t a (splitOn (is 32) rs) then toList "yes" else toList "no")
  sriHonoredReq _ = errorReply "BadRequest"

  -- sameoriginmode <Sec-Fetch-Mode> <client origin> <target origin> → yes|no (Fetch.sameOriginModeFails)
  sameOriginModeReq : List Str → Str
  sameOriginModeReq (m ∷ c ∷ t ∷ []) = out (if Fetch.sameOriginModeFails m c t then toList "yes" else toList "no")
  sameOriginModeReq _ = errorReply "BadRequest"

  -- corsorigin <mode> <dest> <named|-> <referred|-> <target> → origin | - (Fetch.corsOrigin)
  corsOriginReq : List Str → Str
  corsOriginReq (m ∷ d ∷ n ∷ r ∷ tg ∷ []) = out (shown (Fetch.corsOrigin m d (opt n) (opt r) tg))
    where
    opt : Str → Maybe Str
    opt s = if eqStr s (toList "-") then nothing else just s
    shown : Maybe Str → Str
    shown (just o) = o
    shown nothing  = toList "-"
  corsOriginReq _ = errorReply "BadRequest"

  lnaName : Lna.Space → Str
  lnaName Lna.spLoopback = toList "loopback"
  lnaName Lna.spLocal    = toList "local"
  lnaName Lna.spPublic   = toList "public"

  lnaNamed : Str → Lna.Space
  lnaNamed s = if eqStr s (toList "loopback") then Lna.spLoopback else if eqStr s (toList "local") then Lna.spLocal else Lna.spPublic

  -- lnaspace4 <a> <b> <c> <d> → loopback|local|public
  lnaSpace4Req : List Str → Str
  lnaSpace4Req (a ∷ b ∷ c ∷ d ∷ []) with CookieJar.natOf a | CookieJar.natOf b | CookieJar.natOf c | CookieJar.natOf d
  ... | just a′ | just b′ | just c′ | just d′ = out (lnaName (Lna.space4 a′ b′ c′ d′))
  ... | _ | _ | _ | _ = errorReply "BadRequest"
  lnaSpace4Req _ = errorReply "BadRequest"

  -- lnarefused <doc space> <target space> <navigation 0|1> → yes|no
  lnaRefusedReq : List Str → Str
  lnaRefusedReq (d ∷ t ∷ n ∷ []) = out (if Lna.refused (lnaNamed d) (lnaNamed t) (eqStr n (toList "1")) then toList "yes" else toList "no")
  lnaRefusedReq _ = errorReply "BadRequest"

  -- oacreads <recorded true|false|-> <secure 0|1> <header|-> → true|false
  oacReadsReq : List Str → Str
  oacReadsReq (r ∷ sc ∷ h ∷ []) =
    out (if Oac.reads (if eqStr r (toList "-") then nothing else just (eqStr r (toList "true"))) (eqStr sc (toList "1")) (if eqStr h (toList "-") then nothing else just h) then toList "true" else toList "false")
  oacReadsReq _ = errorReply "BadRequest"

  -- cooptoken <0|1 present> <header value> → the token, or none
  coopTokenReq : List Str → Str
  coopTokenReq (pr ∷ v ∷ []) = maybeOut (Coop.coopToken (if eqStr pr (toList "1") then just v else nothing))
  coopTokenReq _ = errorReply "BadRequest"

  -- coopof <token|-> <secure 0|1> <corp 0|1> → the value's name
  coopOfReq : List Str → Str
  coopOfReq (t ∷ sc ∷ cp ∷ []) = out (Coop.coopName (Coop.coopFromToken (if eqStr t (toList "-") then nothing else just t) (eqStr sc (toList "1")) (eqStr cp (toList "1"))))
  coopOfReq _ = errorReply "BadRequest"

  -- coopemulated <coop a> <origin a> <coop b> <origin b> <proxy origin> → yes|no
  coopEmulatedReq : List Str → Str
  coopEmulatedReq (a ∷ oa ∷ b ∷ ob ∷ px ∷ []) = out (if Coop.emulated (Coop.coopNamed a) oa (Coop.coopNamed b) ob px then toList "yes" else toList "no")
  coopEmulatedReq _ = errorReply "BadRequest"

  -- coopemulatedat <initial yes|no> <coop a> <origin a> <coop b> <origin b> <proxy origin> → yes|no
  coopEmulatedAtReq : List Str → Str
  coopEmulatedAtReq (i ∷ a ∷ oa ∷ b ∷ ob ∷ px ∷ []) = out (if Coop.emulatedAt (eqStr i (toList "yes")) (Coop.coopNamed a) oa (Coop.coopNamed b) ob px then toList "yes" else toList "no")
  coopEmulatedAtReq _ = errorReply "BadRequest"

  -- disposition <js|css|-> <0|1 Sec-Fetch-Dest present> <Sec-Fetch-Dest> <0|1 Content-Type present> <Content-Type> <0|1 sniffed>
  dispositionReq : List Str → Str
  dispositionReq (m ∷ sp ∷ sd ∷ cp ∷ ct ∷ sn ∷ []) = dispositionReq (m ∷ sp ∷ sd ∷ cp ∷ ct ∷ sn ∷ toList "0" ∷ [])
  dispositionReq (m ∷ sp ∷ sd ∷ cp ∷ ct ∷ sn ∷ sx ∷ []) =
    out (toList (Disposition.kindName (Disposition.responseKind dst (opt sp sd) (opt cp ct)
      (Disposition.sniff (eqStr sn (toList "1")) (eqStr sx (toList "1"))))))
    where
    dst : Maybe Dest
    dst = if eqStr m (toList "js") then just destScript else if eqStr m (toList "css") then just destStyle
          else if eqStr m (toList "frame") then just destFrame
          else if eqStr m (toList "inert") then just destInert
          else if eqStr m (toList "set") then just destImageSet
          else if eqStr m (toList "mjs") then just destModuleWorker
          else if eqStr m (toList "cred") then just destCred else if eqStr m (toList "jsc") then just destScriptCred
          else if eqStr m (toList "cssc") then just destStyleCred
          else if eqStr m (toList "anon") then just destAnon else nothing
    opt : Str → Str → Maybe Str
    opt p v = if eqStr p (toList "1") then just v else nothing
  dispositionReq _ = errorReply "BadRequest"

  -- errmuted <same|cross> <cors|nocors> <module|classic> → yes/no
  errMutedReq : List Str → Str
  errMutedReq (a ∷ b ∷ c ∷ []) = out (toList (if ErrorEvents.muted (eqStr a (toList "same")) (eqStr b (toList "cors")) (eqStr c (toList "module")) then "yes" else "no"))
  errMutedReq _ = errorReply "BadRequest"

  -- adjoin <complete|missing> <owner> <page origin> → native/joined/denied/outside
  adJoinReq : List Str → Str
  adJoinReq (c ∷ o ∷ pg ∷ []) = out (toList (joinName (AdAuction.joinAnswer (eqStr c (toList "complete")) o pg)))
    where
    joinName : Maybe AdAuction.Join → String
    joinName (just AdAuction.native) = "native"
    joinName (just AdAuction.joined) = "joined"
    joinName (just AdAuction.denied) = "denied"
    joinName nothing = "outside"
  adJoinReq _ = errorReply "BadRequest"

  dataDocName : Frames.DataDoc → String
  dataDocName Frames.htmlDoc = "html"
  dataDocName Frames.xmlDoc  = "xml"
  dataDocName Frames.notDoc  = "no"

  streamOut : Maybe Str → Str
  streamOut (just o) = o
  streamOut nothing  = toList "-none-"

  lockOut : Maybe Str → Str
  lockOut (just n) = n
  lockOut nothing  = toList "-native-"

  paymentAnswer : Maybe Bool → Str
  paymentAnswer (just true)  = toList "yes"
  paymentAnswer (just false) = toList "no"
  paymentAnswer nothing      = toList "outside"

  -- judgeddest <0|1 Sec-Fetch-Dest present> <Sec-Fetch-Dest> <0|1 Sec-Purpose present> <Sec-Purpose>: "just D" or "nothing".
  judgedDestReq : List Str → Str
  judgedDestReq (sp ∷ sd ∷ pp ∷ pv ∷ []) with Disposition.judgedDest (o sp sd) (o pp pv)
    where
    o : Str → Str → Maybe Str
    o p v = if eqStr p (toList "1") then just v else nothing
  ... | just d  = out (toList "just " ++ d)
  ... | nothing = out (toList "nothing")
  judgedDestReq _ = errorReply "BadRequest"

  fetchModeOf : Str → Fetch.ReqMode
  fetchModeOf m = if eqStr m (toList "cors") then Fetch.modeCors else if eqStr m (toList "no-cors") then Fetch.modeNoCors
             else if eqStr m (toList "same-origin") then Fetch.modeSameOrigin else Fetch.modeNavigate
  typeName : Fetch.RespType → String
  typeName Fetch.basicT = "basic"
  typeName Fetch.corsT = "cors"
  typeName Fetch.opaqueT = "opaque"

  domainSetReq : List Str → Str
  domainSetReq (h ∷ ip ∷ cur ∷ v ∷ e ∷ ps ∷ []) with Frames.domainSet h (eqStr ip (toList "1")) cur v (eqStr e (toList "1")) (eqStr ps (toList "1"))
  ... | Frames.setTo x = out (toList "set:" ++ x)
  ... | Frames.emptyDom = out (toList "empty")
  ... | Frames.topLevel x = out (toList "tld:" ++ x)
  ... | Frames.notSuffix x c = out (toList "notsuffix:" ++ x ++ (':' ∷ c))
  domainSetReq _ = errorReply "BadRequest"

  interceptAnswer : Str → Str → Str
  interceptAnswer d t with Url.parse nothing (Url.preprocess d)
  ... | Url.url a = toList (if Route.canIntercept a t then "yes" else "no")
  ... | _ = toList "bad"

  pairs : List Str → List (Str × Str)
  pairs (n ∷ v ∷ rest) = (n , v) ∷ pairs rest
  pairs _ = []

  needsPreflightReq : List Str → Str
  needsPreflightReq (m ∷ f ∷ rest) = out (toList (if Preflight.needsPreflight m (eqStr f (toList "1")) (pairs rest) then "yes" else "no"))
  needsPreflightReq _ = errorReply "BadRequest"

  maxAgeReq : List Str → Str
  maxAgeReq (p ∷ v ∷ []) = out (toList (showNat (Preflight.maxAge (if eqStr p (toList "1") then just v else nothing))))
  maxAgeReq _ = errorReply "BadRequest"

  preflightOkReq : List Str → Str
  preflightOkReq (st ∷ aop ∷ ao ∷ acp ∷ ac ∷ cr ∷ org ∷ m ∷ un ∷ am ∷ ah ∷ []) =
    out (toList (if Preflight.preflightOk (Preflight.digitsValue st) (opt aop ao) (opt acp ac) (lines am) (lines ah) org (eqStr cr (toList "1")) m (names un) then "yes" else "no"))
    where
    -- one field line, as Fetch's "get" gives it
    opt : Str → Str → Maybe Str
    opt p v = if eqStr p (toList "1") then Fetch.combine (v ∷ []) else nothing
    lines : Str → List Str
    lines [] = []
    lines s = Url.splitOn (Url.is 30) s
    names : Str → List Str
    names [] = []
    names s = Url.splitOn (Url.is 44) s
  preflightOkReq _ = errorReply "BadRequest"

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

  widenXPathReq : List Str → Str
  widenXPathReq (p ∷ b ∷ e ∷ []) with proxyOf p | baseOf b
  ... | just px | just base = out (XPath.widenXPath (λ raw → answerText raw (rewriteUrl px base raw)) e)
  ... | nothing | _ = errorReply "BadProxy"
  ... | just _ | nothing = errorReply "BadBase"
  widenXPathReq _ = errorReply "BadRequest"

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

  -- sniff <body>: what it sniffs as, two flags: html xml ("1"/"0").
  sniffReq : List Str → Str
  sniffReq (b ∷ []) = out (f (Disposition.sniffHtml b) ∷ f (Disposition.xmlMagic b) ∷ [])
    where
    f : Bool → Char
    f true  = '1'
    f false = '0'
  sniffReq _ = errorReply "BadRequest"

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

  nats : List Str → Maybe (List ℕ)
  nats [] = just []
  nats (a ∷ as) with Carry.digitsValue a | nats as
  ... | just n | just ns = just (n ∷ ns)
  ... | _      | _       = nothing

  toolbarLeftReq : List Str → Str
  toolbarLeftReq as with nats as
  ... | just (vw ∷ w ∷ st ∷ g ∷ nw ∷ []) = out (Url.showN (Toolbar.dragLeft vw w st g nw))
  ... | _ = errorReply "BadRequest"

  toolbarInitialReq : List Str → Str
  toolbarInitialReq as with nats as
  ... | just (vw ∷ w ∷ []) = out (Url.showN (Toolbar.initialLeft vw w))
  ... | _ = errorReply "BadRequest"

  toolbarPlaceReq : List Str → Str
  toolbarPlaceReq as with nats as
  ... | just (vw ∷ w ∷ l ∷ []) = out (Url.showN (Toolbar.placeLeft vw w l))
  ... | _ = errorReply "BadRequest"

  regionName : Toolbar.Region → Str
  regionName Toolbar.outside = toList "outside"
  regionName Toolbar.grip    = toList "grip"
  regionName Toolbar.toLeft  = toList "toLeft"
  regionName Toolbar.home    = toList "home"
  regionName Toolbar.toRight = toList "toRight"

  toolbarRegionReq : List Str → Str
  toolbarRegionReq as with nats as
  ... | just (l ∷ w ∷ h ∷ g ∷ j ∷ x ∷ y ∷ []) = out (regionName (Toolbar.region l w h g j x y))
  ... | _ = errorReply "BadRequest"

  -- dragging 0|1, then a point as toolbarregion
  toolbarCursorReq : List Str → Str
  toolbarCursorReq as with nats as
  ... | just (d ∷ l ∷ w ∷ h ∷ g ∷ j ∷ x ∷ y ∷ []) = out (cursorName (Toolbar.cursorOver (Data.Nat.Base._≡ᵇ_ d 1) (Toolbar.region l w h g j x y)))
    where
    cursorName : Toolbar.Cursor → Str
    cursorName Toolbar.pagesOwn = toList "page"
    cursorName Toolbar.grab     = toList "grab"
    cursorName Toolbar.grabbing = toList "grabbing"
    cursorName Toolbar.pointer  = toList "pointer"
  ... | _ = errorReply "BadRequest"

  toolbarRightReq : List Str → Str
  toolbarRightReq as with nats as
  ... | just (vw ∷ w ∷ []) = out (Url.showN (Toolbar.rightEnd vw w))
  ... | _ = errorReply "BadRequest"

  frameDestReq : List Str → Str
  frameDestReq (h ∷ sb ∷ []) = out (toList (Containment.destName (Frames.frameDest (if eqStr h (toList "1") then just sb else nothing))))
  frameDestReq (h ∷ []) = out (toList (Containment.destName (Frames.frameDest (if eqStr h (toList "1") then just [] else nothing))))
  frameDestReq _ = errorReply "BadRequest"

  inertFrameReq : List Str → Str
  inertFrameReq (a ∷ b ∷ c ∷ []) = yn (Frames.inertFrame (eqStr a (toList "1")) (eqStr b (toList "1")) (eqStr c (toList "1")))
  inertFrameReq _ = errorReply "BadRequest"

  frameRuntimeReq : List Str → Str
  frameRuntimeReq (h ∷ d ∷ []) = byDoc (docOf d)
    where
    docOf : Str → Maybe Frames.FrameDoc
    docOf d = if eqStr d (toList "pending") then just Frames.pendingFrame
      else if eqStr d (toList "blank") then just Frames.blankLater
      else if eqStr d (toList "booted") then just Frames.ownBooted
      else if eqStr d (toList "bare") then just Frames.ownBare
      else if eqStr d (toList "inert") then just Frames.inertSame
      else nothing
    rtName : Frames.FrameRuntime → Str
    rtName Frames.noRuntime = toList "none"
    rtName Frames.creators = toList "creators"
    rtName Frames.ownConfig = toList "own"
    rtName Frames.creatorsOwnUrl = toList "creators-own-url"
    byDoc : Maybe Frames.FrameDoc → Str
    byDoc (just fd) = out (rtName (Frames.frameRuntime (eqStr h (toList "1")) fd))
    byDoc nothing = errorReply "BadRequest"
  frameRuntimeReq _ = errorReply "BadRequest"

  embedderReq : List Str → Str
  embedderReq (m ∷ rec ∷ ref ∷ []) =
    out (Frames.embedderOf (eqStr m (toList "1")) (if eqStr rec (toList "-") then nothing else just rec) ref)
  embedderReq _ = errorReply "BadRequest"

  -- evalcall CALLEE SHAPE ARG [TEXT]: CALLEE intrinsic|notEval, SHAPE
  -- named|seen|renamed, ARG text|script|other; the proxied outcome, the
  -- rewrite marked R(…).
  evalCallReq : List Str → Str
  evalCallReq (c ∷ sh ∷ a ∷ rest) = out (Eval.show (Eval.proxied Eval.marked callee shape arg))
    where
    callee : Eval.Callee
    callee = if eqStr c (toList "intrinsic") then Eval.intrinsic else Eval.notEval
    shape : Eval.Shape
    shape = if eqStr sh (toList "named") then Eval.named else (if eqStr sh (toList "seen") then Eval.seen else Eval.renamed)
    body : Str
    body = Data.List.Base.foldr (λ x acc → x) [] rest
    arg : Eval.Arg
    arg = if eqStr a (toList "text") then Eval.text body else (if eqStr a (toList "script") then Eval.script body else Eval.other)
  evalCallReq _ = errorReply "BadRequest"

  -- storeshown KEY STORED: "just NAME" or "nothing".
  storeShownReq : List Str → Str
  storeShownReq (k ∷ st ∷ []) with Storage.shown k st
  ... | just n  = out (toList "just " ++ n)
  ... | nothing = out (toList "nothing")
  storeShownReq _ = errorReply "BadRequest"

  -- lsfits Q KEY VALUE K1 V1 K2 V2 …: whether setting KEY to VALUE in a
  -- partition holding K1=V1, … stays within quota Q.
  lsFitsReq : List Str → Str
  lsFitsReq (q ∷ k ∷ v ∷ rest) = yn (LocalStore.fitsWithin (Url.digitsValue q) p k v (LocalStore.store (entries rest) []))
    where
    p : Str
    p = toList "P"
    entries : List Str → List LocalStore.Entry
    entries (a ∷ b ∷ more) = LocalStore.entry p a b ∷ entries more
    entries _ = []
  lsFitsReq _ = errorReply "BadRequest"

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

  netDestReq : List Str → Str
  netDestReq (p ∷ d ∷ []) with proxyOf p
  ... | nothing = errorReply "BadProxy"
  ... | just px with parse nothing (preprocess d)
  ...   | outside = errorReply "OutOfModel"   -- a host the model does not read: no answer
  ...   | _ with Route.netDestination px d
  ...     | just to = out to
  ...     | nothing = out (toList "none")
  netDestReq _ = errorReply "BadRequest"

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

  dataUrlReq : List Str → Str
  dataUrlReq (u ∷ []) = answer (DataUrl.read u)
    where
    hexOf : List ℕ → Str
    hexOf []       = []
    hexOf (b ∷ bs) = dig (b / 16) ∷ dig (b % 16) ∷ hexOf bs
      where
      dig : ℕ → Char
      dig n = if n <ᵇ 10 then fromℕ (48 + n) else fromℕ (87 + n)
    answer : Maybe DataUrl.DataUrl → Str
    answer nothing  = out (toList "none")
    answer (just d) = out ((if DataUrl.rewritable d then toList "1" else toList "0") ++ '\t' ∷ DataUrl.head d ++ '\t' ∷ hexOf (DataUrl.body d) ++ '\t' ∷ DataUrl.wrapped (DataUrl.head d) (DataUrl.body d))
  dataUrlReq _ = errorReply "BadRequest"

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

  cdOut : Maybe ℕ → Str
  cdOut (just n) = toList (showNat n)
  cdOut nothing  = toList "none"

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

  -- pptable <field lines, LF-separated> → lines "feature US entry US …", or "none"
  ppTableReq : List Str → Str
  ppTableReq (ls ∷ []) with Permissions.table (splitOn (is 10) ls)
  ... | nothing = out (toList "none")
  ... | just t  = out (joinPP '\n' (Data.List.Base.map (λ { (k , es) → joinPP (fromℕ 31) (k ∷ es) }) t))
    where
    import Data.List.Base
    joinPP : Char → List Str → Str
    joinPP c [] = []
    joinPP c (x ∷ []) = x
    joinPP c (x ∷ xs) = x ++ c ∷ joinPP c xs
  ppTableReq _ = errorReply "BadRequest"

  -- ppallowlist <field lines, LF-separated> <feature> <default * 0|1> <doc origin> → entries, LF-separated
  ppAllowlistReq : List Str → Str
  ppAllowlistReq (ls ∷ f ∷ d ∷ doc ∷ []) = out (joinNL (Permissions.allowlist (eqStr d (toList "1")) (splitOn (is 10) ls) f doc))
  ppAllowlistReq _ = errorReply "BadRequest"

  -- pptranslate <field lines, LF-separated> → the lines, LF-separated
  ppTranslateReq : List Str → Str
  ppTranslateReq (ls ∷ []) = out (joinLF (Permissions.translate (splitOn (is 10) ls)))
    where
    joinLF : List Str → Str
    joinLF []       = []
    joinLF (x ∷ []) = x
    joinLF (x ∷ xs) = x ++ fromℕ 10 ∷ joinLF xs
  ppTranslateReq _ = errorReply "BadRequest"

  altSvcReq : List Str → Str
  altSvcReq (h ∷ []) with Alpn.readAltSvc h
  ... | Alpn.clear = out (toList "clear")
  ... | Alpn.offers os = out (joinNl (Data.List.Base.map line os))
    where
    line : Alpn.Offer → Str
    line o = Alpn.proto o ++ toList "\t" ++ Alpn.host o ++ toList "\t" ++ toList (showNat (Alpn.port o)) ++ toList "\t" ++ toList (showNat (Alpn.maxAge o))
    joinNl : List Str → Str
    joinNl [] = []
    joinNl (x ∷ []) = x
    joinNl (x ∷ xs) = x ++ toList "\n" ++ joinNl xs
  altSvcReq _ = errorReply "BadRequest"

  h3ProtoReq : List Str → Str
  h3ProtoReq (sc ∷ h ∷ p ∷ rr ∷ alt ∷ br ∷ []) with Alpn.natOf p
  ... | nothing = errorReply "BadRequest"
  ... | just n = out (protoName (Alpn.protocol sc h n rrOf altOf (eqStr br (toList "1"))))
    where
    protoName : Alpn.Proto → Str
    protoName Alpn.h3 = toList "h3"
    protoName Alpn.h2 = toList "h2"
    rrOf : Maybe (List Str)
    rrOf = if eqStr rr (toList "-") then nothing else just (splitOn (is 44) rr)
    altOf : List Alpn.Offer
    altOf with eqStr alt (toList "-") | Alpn.readAltSvc alt
    ... | true  | _ = []
    ... | false | Alpn.clear = []
    ... | false | Alpn.offers os = os
  h3ProtoReq _ = errorReply "BadRequest"

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

  metaAnswer : Str → Str
  metaAnswer c with metaPolicy c
  ... | just pol = toList (policyName pol)
  ... | nothing  = toList "none"

  srcdocReq : List Str → Str
  srcdocReq (p ∷ f ∷ []) with policyToken p | baseOf f
  ... | just pol | just from = maybeOut (srcdocReferrer pol from)
  ... | _        | _         = errorReply "OutOfModel"
  srcdocReq _ = errorReply "BadRequest"

  referrerReq : List Str → Str
  referrerReq (p ∷ f ∷ t ∷ []) with policyToken p | baseOf f | baseOf t
  ... | just pol | just from | just to = maybeOut (referrer pol from to)
  ... | _        | _         | _       = errorReply "OutOfModel"
  referrerReq _ = errorReply "BadRequest"

  originUrl : Str → Str → Str → Str → Str → Maybe Str → Str
  originUrl m sm p f t d with modeOf m | policyToken p | baseOf f | baseOf t
  ... | just mode | just pol | just from | just to =
    maybeOut (originHeader mode (eqStr sm (toList "safe")) pol from to d)
  ... | _ | _ | _ | _ = errorReply "OutOfModel"

  originReq : List Str → Str
  originReq (m ∷ sm ∷ p ∷ f ∷ t ∷ []) with eqStr f (toList "null") | modeOf m
  ... | true | just mode = maybeOut (originHeaderOpaque mode (eqStr sm (toList "safe")))
  ... | true | nothing   = errorReply "OutOfModel"
  ... | false | _ = originUrl m sm p f t nothing
  originReq (m ∷ sm ∷ p ∷ f ∷ t ∷ d ∷ []) with eqStr f (toList "null") | modeOf m
  ... | true | just mode = maybeOut (originHeaderOpaque mode (eqStr sm (toList "safe")))
  ... | true | nothing   = errorReply "OutOfModel"
  ... | false | _ = originUrl m sm p f t (just d)
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
    ∷ wireName c ∷ wireValue c ∷ (prio (sPriority c) ∷ []) ∷ [] )
    where
    prio : Priority → Char
    prio pLow    = 'L'
    prio pMedium = 'M'
    prio pHigh   = 'H'

  -- The channel and the jar (CookieJar.agda).
  usC : Char
  usC = fromℕ 31

  jarExpTxt : CookieJar.Change → Str
  jarExpTxt ch = CookieJar.expiryText ch

  jarDumpChan : CookieJar.Change → ℕ → Maybe ℕ → Str
  jarDumpChan ch k ap = lines
    ( ((if sHostOnly c then 'h' else 'd') ∷ []) ∷ sDomain c ∷ sPath c ∷ sName c ∷ val ch
    ∷ ((if sSecure c then 's' else 'i') ∷ []) ∷ (sameSiteFlag (sSameSite c) ∷ []) ∷ (CookieJar.prioFlag (sPriority c) ∷ [])
    ∷ jarExpTxt ch ∷ toList (showNat k) ∷ apTxt ap ∷ [] )
    where
    c : Stored
    c = CookieJar.changed ch
    val : CookieJar.Change → Str
    val (CookieJar.put′ x _) = sValue x
    val (CookieJar.gone _)   = []
    apTxt : Maybe ℕ → Str
    apTxt nothing  = toList "-"
    apTxt (just a) = toList (showNat a)

  unchanReq : List Str → Str
  unchanReq (io ∷ n ∷ v ∷ []) with CookieJar.unchan (eqStr io (toList "in")) n v
  ... | just (ch , k , ap) = out (jarDumpChan ch k ap)
  ... | nothing = maybeOut nothing
  unchanReq _ = errorReply "BadRequest"

  jarNat : Str → Maybe ℕ
  jarNat = CookieJar.natOf

  -- (the runtime's memory keeps ms: its `now` in µs)
  msNow : Str → Maybe ℕ
  msNow n = CookieJar.msNum n


  jarChangeOf : Stored → Str → Maybe CookieJar.Change
  jarChangeOf c e with e
  ... | [] = just (CookieJar.put′ c CookieJar.session)
  ... | x ∷ [] = if is 120 x then just (CookieJar.gone c) else secs (CookieJar.msNum (x ∷ []))
    where
    secs : Maybe ℕ → Maybe CookieJar.Change
    secs (just t) = just (CookieJar.put′ c (CookieJar.until t))
    secs nothing  = nothing
  ... | e′ = secs (CookieJar.msNum e′)
    where
    secs : Maybe ℕ → Maybe CookieJar.Change
    secs (just t) = just (CookieJar.put′ c (CookieJar.until t))
    secs nothing  = nothing

  placed : Maybe Str → Stored → Stored
  placed nothing  c = c
  placed (just k) c = record c { sPartition = just k }

  -- (a partition key: the cookie as a context of that key placed it)
  chanWith : Maybe Str → Str → Str → Str → Str → Str → Str → Str
  chanWith pk io u str e k ap with baseOf u | parseSetCookie str | jarNat k
  ... | just base | just sc | just kn with store false false base sc
  ...   | nothing = maybeOut nothing
  ...   | just c0 with jarChangeOf (placed pk c0) e
  ...     | nothing = errorReply "BadRequest"
  ...     | just ch = out (CookieJar.chanName inbox ch ++ fromℕ 10 ∷ CookieJar.chanValue ch kn (if inbox then jarNat ap else nothing))
    where
    inbox : Bool
    inbox = eqStr io (toList "in")
  chanWith pk io u str e k ap | _ | _ | _ = errorReply "BadRequest"

  chanReq : List Str → Str
  chanReq (io ∷ u ∷ str ∷ e ∷ k ∷ ap ∷ []) = chanWith nothing io u str e k ap
  chanReq (io ∷ u ∷ str ∷ e ∷ k ∷ ap ∷ pk ∷ []) = chanWith (just pk) io u str e k ap
  chanReq _ = errorReply "BadRequest"

  -- The jar's script.
  record JarRun : Set where
    constructor mkJarRun
    field
      rJar : CookieJar.Jar
      rOut : List Str          -- inbox lines, reversed

  jarInboxLine : CookieJar.Jar → CookieJar.Change × ℕ → Str
  jarInboxLine j (ch , g) =
    toList "I" ++ usC ∷ CookieJar.chanName true ch ++ usC ∷
    CookieJar.chanValue ch g (just (CookieJar.lastApplied (CookieJar.scope (CookieJar.changed ch)) (CookieJar.applied j)))

  jarEmit : CookieJar.Jar × List (CookieJar.Change × ℕ) → List Str → JarRun
  jarEmit (j , chs) acc = mkJarRun j (revApp (Data.List.Base.map (jarInboxLine j) chs) acc)
    where
    revApp : List Str → List Str → List Str
    revApp []       a = a
    revApp (x ∷ xs) a = revApp xs (x ∷ a)

  jarLine : JarRun → Str → JarRun
  jarLine r line with splitOn (is 31) line
  ... | (cmd ∷ ap ∷ now ∷ site ∷ u ∷ str ∷ []) =
    if eqStr cmd (toList "put") then doPut (jarNat now) (baseOf u) (parseSetCookie str) else r
    where
    api : Bool
    api = eqStr ap (toList "api")
    doPut : Maybe ℕ → Maybe Abs → Maybe SetCookie → JarRun
    doPut (just t) (just base) (just sc) with store api false base sc
    ... | nothing = r
    ... | just c with CookieJar.expiryOf t sc
    ...   | just e  = jarEmit (CookieJar.put api t site (CookieJar.put′ c e) (JarRun.rJar r)) (JarRun.rOut r)
    ...   | nothing = jarEmit (CookieJar.put api t site (CookieJar.gone c) (JarRun.rJar r)) (JarRun.rOut r)
    doPut _ _ _ = r
  ... | (cmd ∷ now ∷ site ∷ n ∷ v ∷ []) =
    if eqStr cmd (toList "outbox") then doOut (jarNat now) (CookieJar.unchan false n v) else r
    where
    doOut : Maybe ℕ → Maybe (CookieJar.Change × ℕ × Maybe ℕ) → JarRun
    doOut (just t) (just (ch , k , _)) = jarEmit (CookieJar.applyOutbox t site ch k (JarRun.rJar r)) (JarRun.rOut r)
    doOut _ _ = r
  ... | (cmd ∷ now ∷ u ∷ []) =
    if eqStr cmd (toList "touch") then doTouch (jarNat now) (baseOf u) else r
    where
    doTouch : Maybe ℕ → Maybe Abs → JarRun
    doTouch (just t) (just base) = record r { rJar = CookieJar.touch t (matches false base) (JarRun.rJar r) }
    doTouch _ _ = r
  ... | (cmd ∷ []) = if eqStr cmd (toList "end") then record r { rJar = CookieJar.endSession (JarRun.rJar r) } else r
  ... | _ = r

  jarAll : JarRun → List Str → JarRun
  jarAll r []       = r
  jarAll r (l ∷ ls) = jarAll (jarLine r l) ls

  jarEntryLine : CookieJar.Entry → Str
  jarEntryLine e =
    toList "E" ++ usC ∷ CookieJar.scope c ++ usC ∷ CookieJar.flagsOf c ++ ((if sHttpOnly c then 'H' else '-') ∷ []) ++ usC ∷ ex (CookieJar.eExpiry e)
    ++ usC ∷ toList (showNat (CookieJar.eCreated e)) ++ usC ∷ toList (showNat (CookieJar.eAccessed e)) ++ usC ∷ toList (showNat (CookieJar.eOrder e)) ++ usC ∷ CookieJar.eSite e ++ usC ∷ sValue c
    where
    c : Stored
    c = CookieJar.eCookie e
    ex : CookieJar.Expiry → Str
    ex CookieJar.session   = []
    ex (CookieJar.until t) = toList (showNat t)

  jarReq : List Str → Str
  jarReq (script ∷ []) = jarOut (jarAll (mkJarRun CookieJar.emptyJar []) (splitOn (is 10) script))
    where
    jarOut : JarRun → Str
    jarOut r = let j = JarRun.rJar r ; outs = JarRun.rOut r in out (lines (Data.List.Base.map jarEntryLine (CookieJar.entries j) ++ (toList "G" ++ usC ∷ toList (showNat (CookieJar.gen j))) ∷ Data.List.Base.reverse outs))
  jarReq _ = errorReply "BadRequest"

  packArgs : List Str → List (Str × Str)
  packArgs (n ∷ v ∷ rest) = (n , v) ∷ packArgs rest
  packArgs _ = []

  -- A runtime's memory (CookieJar.Mem), by script.
  record MemRun : Set where
    constructor mkMemRun
    field
      mMem  : CookieJar.Mem
      mOut  : List Str            -- reads, reversed

  memSnapEntries : List Str → List (CookieJar.Change × ℕ × ℕ)
  memSnapEntries (n ∷ v ∷ rest) with CookieJar.unchan true n v
  ... | just (ch , k , just a) = (ch , k , a) ∷ memSnapEntries rest
  ... | _ = memSnapEntries rest
  memSnapEntries _ = []

  memLine : MemRun → Str → MemRun
  memLine r line = byCmd (splitOn (is 31) line)
    where
    byAbsorb : Maybe (CookieJar.Change × ℕ × Maybe ℕ) → MemRun
    byAbsorb (just (ch , k , just ap)) = record r { mMem = CookieJar.absorb ch k ap (MemRun.mMem r) }
    byAbsorb _ = r
    byWrite : Maybe (CookieJar.Change × ℕ × Maybe ℕ) → MemRun
    byWrite (just (ch , k , nothing)) = record r { mMem = CookieJar.write ch k (MemRun.mMem r) }
    byWrite _ = r
    -- writel <name> <value> <now ms>: a write, then the site limit (the site: the cookie's domain)
    byWriteL : Maybe (CookieJar.Change × ℕ × Maybe ℕ) → Maybe ℕ → MemRun
    byWriteL (just (ch , k , nothing)) (just t) =
      record r { mMem = CookieJar.memEvict sDomain t (sDomain (CookieJar.changed ch)) (CookieJar.write ch k (MemRun.mMem r)) }
    byWriteL _ _ = r
    bySnap : Maybe CookieCtx → Maybe Abs → Maybe ℕ → List Str → MemRun
    bySnap x (just u) (just g) rest = record r { mMem = CookieJar.snapshot x u g (memSnapEntries rest) (MemRun.mMem r) }
    bySnap _ _ _ _ = r
    byRead : Maybe CookieCtx → Maybe ℕ → Maybe Abs → MemRun
    byRead x (just t) (just u) = record r { mOut = (toList "R" ++ usC ∷ CookieJar.memCookies x t u (MemRun.mMem r)) ∷ MemRun.mOut r }
    byRead _ _ _ = r
    byAck : Maybe ℕ → Maybe ℕ → MemRun
    byAck (just n) (just k) = record r { mMem = CookieJar.ack n k (MemRun.mMem r) }
    byAck _ _ = r
    -- (snapx / readx: a context, top and cross|same, before the rest)
    ctxArg : Str → Str → Maybe CookieCtx
    ctxArg t c = just (mkCtx t (eqStr c (toList "cross")))
    snapX : Str → Str → List Str → MemRun
    snapX t c (u ∷ g ∷ es) = bySnap (ctxArg t c) (baseOf u) (jarNat g) es
    snapX _ _ _ = r
    readX : Str → Str → List Str → MemRun
    readX t c (n ∷ u ∷ _) = byRead (ctxArg t c) (msNow n) (baseOf u)
    readX _ _ _ = r
    nowOf : List Str → Maybe ℕ
    nowOf (t ∷ _) = msNow t
    nowOf [] = nothing
    byCmd : List Str → MemRun
    byCmd (cmd ∷ a ∷ b ∷ rest) =
      if eqStr cmd (toList "absorb") then byAbsorb (CookieJar.unchan true a b)
      else if eqStr cmd (toList "write") then byWrite (CookieJar.unchan false a b)
      else if eqStr cmd (toList "writel") then byWriteL (CookieJar.unchan false a b) (nowOf rest)
      else if eqStr cmd (toList "snap") then bySnap nothing (baseOf a) (jarNat b) rest
      else if eqStr cmd (toList "snapx") then snapX a b rest
      else if eqStr cmd (toList "read") then byRead nothing (msNow a) (baseOf b)
      else if eqStr cmd (toList "readx") then readX a b rest
      else if eqStr cmd (toList "ack") then byAck (jarNat a) (jarNat b)
      else r
    byCmd _ = r

  memAll : MemRun → List Str → MemRun
  memAll r []       = r
  memAll r (l ∷ ls) = memAll (memLine r l) ls

  memKnownLine : CookieJar.Known → Str
  memKnownLine k =
    toList "K" ++ usC ∷ CookieJar.scope c ++ usC ∷ CookieJar.flagsOf c ++ usC ∷ CookieJar.expiryText ch ++ usC ∷ toList (showNat (CookieJar.kGen k))
    ++ usC ∷ pend (CookieJar.kPending k) ++ usC ∷ val ch
    where
    ch : CookieJar.Change
    ch = CookieJar.kChange k
    c : Stored
    c = CookieJar.changed ch
    pend : Maybe ℕ → Str
    pend nothing  = toList "-"
    pend (just p) = toList (showNat p)
    val : CookieJar.Change → Str
    val (CookieJar.put′ x _) = sValue x
    val (CookieJar.gone _)   = []

  memReq : List Str → Str
  memReq (script ∷ []) = memOut (memAll (mkMemRun [] []) (splitOn (is 10) script))
    where
    memOut : MemRun → Str
    memOut r = out (lines (Data.List.Base.reverse (MemRun.mOut r) ++ Data.List.Base.map memKnownLine (MemRun.mMem r)))
  memReq _ = errorReply "BadRequest"

  setCookieReq : List Str → Str
  setCookieReq (api ∷ ps ∷ u ∷ str ∷ []) with baseOf u | parseSetCookie str
  ... | nothing   | _       = errorReply "OutOfModel"
  ... | just _    | nothing = maybeOut nothing
  ... | just base | just sc with store (eqStr api (toList "api")) (eqStr ps (toList "ps")) base sc
  ...   | nothing = maybeOut nothing
  ...   | just c  = out (dump sc c)
  setCookieReq _ = errorReply "BadRequest"

  sameSiteReq : List Str → Str
  sameSiteReq (f ∷ site ∷ nav ∷ []) = sameSiteReq (f ∷ site ∷ nav ∷ toList "other" ∷ toList "999999999" ∷ [])
  sameSiteReq (f ∷ site ∷ nav ∷ top ∷ age ∷ []) with flagOf f | CookieJar.natOf age
    where
    flagOf : Str → Maybe SameSite
    flagOf x = if eqStr x (toList "n") then just ssNone else if eqStr x (toList "l") then just ssLax
               else if eqStr x (toList "t") then just ssStrict else if eqStr x (toList "u") then just ssDefault
               else nothing
  ... | just ss | just a = out (toList (if sameSiteAllows ss (eqStr site (toList "same")) (eqStr nav (toList "nav")) (eqStr top (toList "top")) a then "yes" else "no"))
  ... | _ | _ = errorReply "BadRequest"
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
  ... | just base = storeOut (cookieStoreSet (eqStr g (toList "later")) (eqStr ps (toList "yes")) base (mkStoreSet n v (optional d) (optional p) sso false))
    where
    sso : SameSite
    sso = if eqStr ss (toList "n") then ssNone else if eqStr ss (toList "l") then ssLax else ssStrict
  cookieStoreSetReq _ = errorReply "BadRequest"

  -- clearsitedata <trustworthy yes|no> <value> → whether it clears cookies
  csdReq : List Str → Str
  csdReq (tw ∷ v ∷ []) = out (toList (if ClearSiteData.clearsCookies (eqStr tw (toList "yes")) v then "yes" else "no"))
  csdReq _ = errorReply "BadRequest"

  challengeReq : List Str → Str
  challengeReq (site ∷ line ∷ []) = out (Auth.rewriteChallenge site line)
  challengeReq _ = errorReply "BadRequest"

  -- corp <header|-> <none|require-corp|credentialless> <cred yes|no> <origin> <originSite|-> <target> <targetSite|->
  corpReq : List Str → Str
  corpReq (h ∷ e ∷ c ∷ o ∷ os ∷ t ∷ ts ∷ []) with baseOf o | baseOf t
  ... | just ou | just tu = out (toList (if Corp.corpBlocks (dashOpt h) emb (eqStr c (toList "yes")) ou (dashOpt os) tu (dashOpt ts) then "block" else "allow"))
    where
    dashOpt : Str → Maybe Str
    dashOpt x = if eqStr x (toList "-") then nothing else just x
    emb : Corp.Embedder
    emb = if eqStr e (toList "require-corp") then Corp.requireCorp else if eqStr e (toList "credentialless") then Corp.credentialless else Corp.unsafeNone
  ... | _ | _ = errorReply "OutOfModel"
  corpReq _ = errorReply "BadRequest"

  -- encquery <special|other> <query> → the query in latin1 (the model)
  encQueryReq : List Str → Str
  encQueryReq (sp ∷ q ∷ []) = out (Encoding.encodeQuery Encoding.latin1 (eqStr sp (toList "special")) q)
  encQueryReq _ = errorReply "BadRequest"

  -- elemcookies <cors|other> <cred|plain> <same|cross> → yes/no
  elemCookiesReq : List Str → Str
  elemCookiesReq (m ∷ c ∷ o ∷ []) = out (toList (if elementCookies (eqStr m (toList "cors")) (eqStr c (toList "cred")) (eqStr o (toList "same")) then "yes" else "no"))
  elemCookiesReq _ = errorReply "BadRequest"

  -- markedcookies <anon|other> <cors|other> <cred|plain> <same|cross> → yes/no
  markedCookiesReq : List Str → Str
  markedCookiesReq (a ∷ m ∷ c ∷ o ∷ []) = out (toList (if markedCookies (eqStr a (toList "anon")) (eqStr m (toList "cors")) (eqStr c (toList "cred")) (eqStr o (toList "same")) then "yes" else "no"))
  markedCookiesReq _ = errorReply "BadRequest"

  -- storable <top> <cross|same> <Set-Cookie>: whether that context stores it,
  -- and its partition key ("-": none).
  storableReq : List Str → Str
  storableReq (top ∷ x ∷ raw ∷ []) with parseSetCookie raw
  ... | nothing = out (toList "malformed")
  ... | just sc = out (if storableIn ctx sc then (if partitioned sc then partitionKey ctx else toList "-") else toList "refused")
    where
    ctx : CookieCtx
    ctx = mkCtx top (eqStr x (toList "cross"))
  storableReq _ = errorReply "BadRequest"

  -- inctx <script|http> <top> <cross|same> <partition key|-> <n|l|t|u>
  inCtxReq : List Str → Str
  inCtxReq (k ∷ top ∷ x ∷ pk ∷ ss ∷ []) with CookieJar.ssOf′ ss
  ... | nothing = errorReply "BadRequest"
  ... | just sm = out (toList (if inCtx (eqStr k (toList "script")) (mkCtx top (eqStr x (toList "cross")))
                    (mkStored true (toList "h") (toList "/") (toList "n") (toList "v") true false sm pMedium (if eqStr pk (toList "-") then nothing else just pk)) then "yes" else "no"))
  inCtxReq _ = errorReply "BadRequest"

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
  namesContextReq (a ∷ b ∷ c ∷ d ∷ []) = yesNo (namesContext (eqStr a (toList "yes")) (eqStr b (toList "yes")) (eqStr c (toList "yes")) (eqStr d (toList "yes")))
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

  -- csppairs <proxy origin> <tt policy> <header> → each policy "translated<TAB>original", one a line (Csp.policyPairs)
  cspPairsReq : List Str → Str
  cspPairsReq (o ∷ tt ∷ v ∷ []) = out (Csp.joinWith (toList "\n") (Data.List.Base.map (λ pr → Data.Product.Base.proj₁ pr ++ toList "\t" ++ Data.Product.Base.proj₂ pr) (policyPairs px v)))
    where
    px : CspProxy
    px = record { origin = o ; ttPolicy = tt ; plainHttp = prefixCI (toList "http://") o }
  cspPairsReq _ = errorReply "BadRequest"

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

  docDst : Str → Maybe (Maybe Dest)
  docDst t = if eqStr t (toList "-") then just nothing
             else if eqStr t (toList "frame") then just (just destFrame)
             else if eqStr t (toList "inert") then just (just destInert) else nothing

  importMapIntegrityReq : List Str → Str
  importMapIntegrityReq (b ∷ u ∷ maps) with baseOf b
  ... | just base = out (shown (ImportMap.integrityFor (merged maps []) u))
    where
    merged : List Str → List (Str × Str) → List (Str × Str)
    merged [] acc = acc
    merged (m ∷ ms) acc = merged ms (ImportMap.mergeIntegrity acc (ImportMap.integrityEntries base m))
    shown : Maybe Str → Str
    shown (just v) = v
    shown nothing  = toList "-"
  ... | nothing = errorReply "BadBase"
  importMapIntegrityReq _ = errorReply "BadRequest"

  ruleSetReq : List Str → Str
  ruleSetReq (p ∷ b ∷ text ∷ []) with proxyOf p | baseOf b
  ... | just px | just base = out (Speculation.rewriteRuleSet rw text)
    where
    -- prefetched and prerendered URLs are documents: no mark
    rw : Str → Maybe Str
    rw u with rewriteUrlWith px (mark nothing nothing) base u
    ... | emit _ v = just v
    ... | _        = nothing
  ... | nothing | _ = errorReply "BadProxy"
  ... | just _  | nothing = errorReply "BadBase"
  ruleSetReq _ = errorReply "BadRequest"

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
  -- importmap … <document's policy|-> <document's dest frame|inert|-> <text>: scope prefixes twice (rewriteImportMapT)
  importMapReq (p ∷ b ∷ pt ∷ dt ∷ text ∷ []) with proxyOf p | baseOf b | markPol pt | docDst dt
  ... | just px | just base | just x | just d = out (ImportMap.rewriteImportMapT rw twin text)
    where
    rw : Str → Maybe Str
    rw u with rewriteUrlWith px (mark nothing (just destScript)) base u
    ... | emit _ v = just v
    ... | _        = nothing
    twin : Str → Maybe Str
    twin u with rewriteUrlWith px (mark x d) base u | rw u
    ... | emit _ v | just w = if eqStr v w then nothing else just v
    ... | _ | _ = nothing
  ... | _ | _ | _ | _ = errorReply "BadRequest"
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
  attrKindReq (n ∷ t ∷ a ∷ an ∷ []) =
    out (Attrs.kindName (Attrs.attrKindIn (if eqStr n (toList "svg") then Attrs.svgNs else Attrs.htmlNs) t a
                          (if eqStr an (toList "-") then nothing else just an)))
  attrKindReq _ = errorReply "BadRequest"

  animUrlsReq : List Str → Str
  animUrlsReq (p ∷ b ∷ text ∷ []) with proxyOf p | baseOf b
  ... | just px | just base = out (Attrs.rewriteAnimUrls rw text)
    where
    rw : Str → Maybe Str
    rw u with rewriteUrl px base u
    ... | emit _ v = just v
    ... | _        = nothing
  ... | nothing | _ = errorReply "BadProxy"
  ... | just _  | nothing = errorReply "BadBase"
  animUrlsReq _ = errorReply "BadRequest"

  -- urldest <html|svg> <tag> <attr> <rel types, space-separated> <as|->
  urlDestReq : List Str → Str
  urlDestReq (n ∷ t ∷ a ∷ rel ∷ as ∷ cr ∷ []) =
    out (dname (Attrs.credDest (eqStr cr (toList "cred")) (Attrs.urlDest (if eqStr n (toList "svg") then Attrs.svgNs else Attrs.htmlNs) t a (relWords rel)
                 (if eqStr as (toList "-") then nothing else just as))))
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

  -- An XML document rewritten by stand-ins that show what each part was
  -- taken for: P<dest>:url, L(urls), S(srcset), V(value), D(declarations),
  -- C(sheet), J(script), Q<url> (xml-stylesheet); the bootstrap <B/>
  -- (SVG root) or <H/> (XHTML root).
  xmlRwReq : List Str → Str
  xmlRwReq (d ∷ []) = out (XmlDoc.rewriteXml rws bootFor d)
    where
    wrap : Char → Str → Str
    wrap t s = t ∷ '(' ∷ s ++ ')' ∷ []
    destOf : Maybe Dest → Str
    destOf nothing  = []
    destOf (just x) = toList (destName x)
    rws : XmlDoc.Rws
    rws = record { url = λ x s → 'P' ∷ destOf x ++ ':' ∷ s ; urls = wrap 'L' ; srcset = wrap 'S' ; cssVal = wrap 'V'
                 ; cssDecl = wrap 'D' ; css = wrap 'C' ; js = wrap 'J' ; sheet = λ s → 'Q' ∷ s }
    bootFor : XmlDoc.XNs → Str
    bootFor XmlDoc.xSvg   = toList "<B/>"
    bootFor XmlDoc.xXhtml = toList "<H/>"
    bootFor XmlDoc.xOther = []
  xmlRwReq _ = errorReply "BadRequest"

  -- mixed <context URL | -> <target URL> <Sec-Fetch-Dest | ->
  mixedWith : Str → Str → Str → Bool → Str
  mixedWith c t d set with baseOf t
  ... | nothing = errorReply "BadTarget"
  ... | just target = out (MixedContent.verdictName (MixedContent.mixed ctx target dest set))
    where
    ctx : Maybe Abs
    ctx = if eqStr c (toList "-") then nothing else baseOf c
    dest : Maybe Str
    dest = if eqStr d (toList "-") then nothing else just d

  mixedReq : List Str → Str
  mixedReq (c ∷ t ∷ d ∷ []) = mixedWith c t d false
  mixedReq (c ∷ t ∷ d ∷ s ∷ []) = mixedWith c t d (eqStr s (toList "set"))
  mixedReq _ = errorReply "BadRequest"

  -- uir <context|-> <target> <dest|-> → yes/no (the document declared it)
  uirReq : List Str → Str
  uirReq (c ∷ t ∷ d ∷ []) with baseOf t
  ... | nothing = errorReply "OutOfModel"
  ... | just tgt = out (toList (if MixedContent.uirUpgrades true (baseOf c) tgt (if eqStr d (toList "-") then nothing else just d) then "yes" else "no"))
  uirReq _ = errorReply "BadRequest"

  uirDeclReq : List Str → Str
  uirDeclReq (h ∷ []) = out (toList (if Csp.declaresUIR h then "yes" else "no"))
  uirDeclReq _ = errorReply "BadRequest"


  specRulesReq : List Str → Str
  specRulesReq (p ∷ b ∷ h ∷ []) with proxyOf p | baseOf b
  ... | just px | just base = out (Speculation.rewriteSpeculationRules rw h)
    where
    rw : Str → Maybe Str
    rw u with rewriteUrlWith px (mark nothing nothing) base u
    ... | emit _ v = just v
    ... | _        = nothing
  ... | nothing | _ = errorReply "BadProxy"
  ... | just _  | nothing = errorReply "BadBase"
  specRulesReq _ = errorReply "BadRequest"

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

  -- csprefuses <policies, LF-separated> <Sec-Fetch-Dest> <document URL> <target URL> → yes|no
  cspRefusesReq : List Str → Str
  cspRefusesReq (ps ∷ d ∷ a ∷ t ∷ []) with baseOf a | baseOf t
  ... | just self | just u = out (if cspRefuses (splitOn (is 10) ps) d self u then toList "yes" else toList "no")
  ... | _ | _ = errorReply "OutOfModel"
  cspRefusesReq _ = errorReply "BadRequest"

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

