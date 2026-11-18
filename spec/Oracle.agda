{-# OPTIONS --safe #-}
-- Wire adapter only: the rules are in Url, Containment and Srcset.
-- One line in, one line out (spec-oracle skill, yovico-ai/agda-guardrails):
--
--   vocab                               → {"schemes":["http",..]}
--   rewrite <proxy> <base> <url>        → {"kind":"proxified","out":"…"}
--   unwrap  <proxy> <href>              → {"kind":"unwrapped","out":"…"}
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
open import Data.String.Base using (String; toList; fromList)

open import Scheme
open import Url
open import Containment
open import Srcset
open import Referrer
open import Cookies

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

policyName : Policy → String
policyName noReferrer                  = "no-referrer"
policyName noReferrerWhenDowngrade     = "no-referrer-when-downgrade"
policyName sameOrigin                  = "same-origin"
policyName origin                      = "origin"
policyName strictOrigin                = "strict-origin"
policyName originWhenCrossOrigin       = "origin-when-cross-origin"
policyName strictOriginWhenCrossOrigin = "strict-origin-when-cross-origin"
policyName unsafeUrl                   = "unsafe-url"

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
  else errorReply "UnknownRequest"
  where
  rewriteReq : List Str → Str
  rewriteReq (p ∷ b ∷ raw ∷ []) with proxyOf p | baseOf b
  ... | just px | just base = answerReply raw (rewriteUrl px base raw)
  ... | nothing | _         = errorReply "BadProxy"
  ... | just _  | nothing   = errorReply "BadBase"
  rewriteReq _ = errorReply "BadRequest"

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
