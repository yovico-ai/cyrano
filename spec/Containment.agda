{-# OPTIONS --safe #-}
-- URL containment (REQUIREMENTS §1): what a URL found in a page becomes,
-- and how a proxified URL reads back as the original.
--
-- Implemented by go/src/internal/urlrewrite (Rewrite, Unwrap) and
-- ts/client/src/url/containment.ts (rewriteUrl, unwrapProxiedUrl). The
-- two must agree byte for byte: the server rewrites static HTML, the
-- client rewrites what scripts set later, and both name the same
-- resources.
--
-- The governing principle (owner, 2026-11-17; REQUIREMENTS.md): page
-- code cannot tell it runs through cyrano. Here that is the law
--
--     unwrap (rewrite base raw) = href (parse base raw)
--
-- — what page code reads back for a URL is what the browser shows for
-- the original. Every rule below serves it, and it decides what the
-- rulings once did: userinfo and a bare "?" or "#" are kept (they show
-- in href); unwrap reads the host segment as the browser would
-- (H.com:443 is h.com).
--
-- A proxified URL may carry the referrer policy its request is made under
-- (an element's referrerpolicy, fetch's referrerPolicy): the scheme segment
-- is then "<scheme>!<policy>" — /cyrano/https!origin/a.example/x (owner,
-- 2026-11-18). The browser is told unsafe-url, so the proxy learns the
-- requesting page, and the proxy applies the request's own policy
-- (`targetPolicy`); unwrap ignores the marker, so the law below holds for
-- marked URLs alike.
--
-- Decisions (owner, 2026-11-17):
--   * Targets are normalized as the browser does (see Url.agda).
--   * A URL that is not proxified comes back exactly as given — no
--     whitespace stripped ("data is never modified as data").
--   * Remap and unwrap apply only to what proxify itself produces:
--     /cyrano/<http|https|ws|wss>/<non-empty host>…
-- Ours: an empty string stays empty, while a string of only spaces is,
-- as for the browser, a reference to the page itself.
module Containment where

open import Data.Bool.Base using (Bool; true; false; _∧_; _∨_; not; if_then_else_)
open import Data.Char.Base using (Char; toℕ; fromℕ)
open import Data.List.Base using (List; []; _∷_; _++_; map)
open import Data.Maybe.Base using (Maybe; just; nothing)
open import Data.Nat.Base using (ℕ; zero; suc; _≡ᵇ_)
open import Data.Product.Base using (_×_; _,_; Σ)
open import Data.String.Base using (toList)
open import Data.Char.Properties using (toℕ-injective)
open import Data.Nat.Properties using (≡ᵇ⇒≡)
open import Relation.Binary.PropositionalEquality using (_≡_; refl; sym; cong; cong₂; subst)

open import Scheme
open import Url
import Referrer as R

-- The proxy's public origin, as the browser sees it.
record Proxy : Set where
  constructor proxy
  field
    pScheme : Scheme
    pAuth   : Str
open Proxy public

-- Which rule decided the answer. Reported by the oracle so a failing
-- property names the rule, not only the bytes.
data Kind : Set where
  emptyRef         : Kind   -- "" : nothing to rewrite
  anchor           : Kind   -- "#…": an in-page fragment
  notProxifiable   : Kind   -- javascript:, data:, mailto:, ftp:, …
  unparseable      : Kind   -- the browser's parser rejects it
  alreadyProxified : Kind   -- on the proxy, under /cyrano/
  proxyOrigin      : Kind   -- on the proxy, elsewhere: a request to cyrano itself
  remapped         : Kind   -- a /cyrano/ path glued to the page's virtual origin
  proxified        : Kind   -- the ordinary case
  foreignOrigin    : Kind   -- unwrap: not on the proxy
  plainProxyPath   : Kind   -- unwrap: on the proxy, not a proxified path
  unwrapped        : Kind   -- unwrap: the original URL
  shownDirect      : Kind   -- direct: what the browser itself shows

data Answer : Set where
  keep   : Kind → Answer         -- the input, exactly as given
  emit   : Kind → Str → Answer   -- this string
  silent : Answer                -- outside the model: the spec does not decide

-- The text an answer stands for, given the input.
answerText : Str → Answer → Maybe Str
answerText raw (keep _)   = just raw
answerText raw (emit _ s) = just s
answerText raw silent     = nothing

------------------------------------------------------------------------

-- An origin is scheme, host and port; userinfo is not part of it.
sameOrigin : Proxy → Abs → Bool
sameOrigin p a = sameScheme (pScheme p) (scheme a) ∧ eqStr (hostPort (pAuth p)) (hostPort (auth a))

isCyrano : Str → Bool
isCyrano s = eqStr s (toList "cyrano")

-- pathname starts with "/cyrano/".
underCyrano : List Str → Bool
underCyrano []           = false
underCyrano (c ∷ [])     = false
underCyrano (c ∷ _ ∷ _)  = isCyrano c

-- The scheme segment: "<scheme>" or "<scheme>!<policy>"; nothing when the
-- scheme is not one cyrano proxifies or the policy is not a policy's name.
schemeSegment : Str → Maybe (Scheme × Maybe R.Policy)
schemeSegment s with splitBang s
  where
  splitBang : Str → Str × Maybe Str
  splitBang []       = [] , nothing
  splitBang (c ∷ cs) with is 33 c | splitBang cs
  ... | true  | _        = [] , just cs
  ... | false | (a , b)  = (c ∷ a) , b
... | (sc , nothing) = withPolicy (schemeOf sc) (just nothing)
  where
  withPolicy : Maybe Scheme → Maybe (Maybe R.Policy) → Maybe (Scheme × Maybe R.Policy)
  withPolicy (just x) (just pol) = just (x , pol)
  withPolicy _        _          = nothing
... | (sc , just pt) = withPolicy (schemeOf sc) (byName (R.policyToken pt) pt)
  where
  withPolicy : Maybe Scheme → Maybe (Maybe R.Policy) → Maybe (Scheme × Maybe R.Policy)
  withPolicy (just x) (just pol) = just (x , pol)
  withPolicy _        _          = nothing

  -- Only the policy's own name, as cyrano writes it.
  byName : Maybe R.Policy → Str → Maybe (Maybe R.Policy)
  byName (just pol) t = if eqStr t (toList (R.policyName pol)) then just (just pol) else nothing
  byName nothing    t = nothing

-- A path proxify can have produced: /cyrano/<scheme>[!<policy>]/<host><rest>.
target : List Str → Maybe (Scheme × Str × List Str)
target []                 = nothing
target (_ ∷ [])           = nothing
target (_ ∷ _ ∷ [])       = nothing
target (c ∷ s ∷ h ∷ rest) =
  if isCyrano c ∧ not (isEmpty h) then withScheme (schemeSegment s) else nothing
  where
  withScheme : Maybe (Scheme × Maybe R.Policy) → Maybe (Scheme × Str × List Str)
  withScheme nothing         = nothing
  withScheme (just (sc , _)) = just (sc , h , rest)

-- The referrer policy a proxified path carries, if any.
targetPolicy : List Str → Maybe R.Policy
targetPolicy (c ∷ s ∷ h ∷ rest) with isCyrano c ∧ not (isEmpty h) | schemeSegment s
... | true | just (_ , pol) = pol
... | _    | _              = nothing
targetPolicy _ = nothing

-- The authority as a path segment. A host of "." or ".." is a valid
-- host, but as a segment it would be a dot segment the browser removes;
-- an empty port (".:"), which the authority parser reads as no port,
-- keeps it a plain segment.
segmentOf : Str → Str
segmentOf a = if isSingleDot a ∨ isDoubleDot a then a ++ fromℕ 58 ∷ [] else a

-- Every '%' of the target's text is written %25 in the proxified path,
-- so the proxified path is always valid percent-encoding: a server
-- (Go's among them) rejects a request whose path has a '%' that is not
-- an escape, while the origin itself would serve "/100%.jpg". Reading a
-- proxified path back is percent-decoding it (`pctDecode`), which gives
-- the target's text exactly (`decode-escape` below) — "%2F" stays "%2F".
escapePct : Str → Str
escapePct []       = []
escapePct (c ∷ cs) = if is 37 c then c ∷ '2' ∷ '5' ∷ escapePct cs else c ∷ escapePct cs

-- The proxified form of a target, as a URL on the proxy.
proxify : Proxy → Abs → Abs
proxify p a = mkAbs (pScheme p) (pAuth p)
                    (toList "cyrano" ∷ schemeChars (scheme a) ∷ escapePct (segmentOf (auth a)) ∷ map escapePct (path a))
                    (query a) (frag a)

-- … and requested under a referrer policy of its own.
proxifyWith : Proxy → Maybe R.Policy → Abs → Abs
proxifyWith p nothing    a = proxify p a
proxifyWith p (just pol) a = mkAbs (pScheme p) (pAuth p)
                    (toList "cyrano" ∷ (schemeChars (scheme a) ++ '!' ∷ toList (R.policyName pol))
                      ∷ escapePct (segmentOf (auth a)) ∷ map escapePct (path a))
                    (query a) (frag a)

-- What a parsed URL becomes (requested under policy pol, if given).
rewriteAbsWith : Proxy → Maybe R.Policy → Abs → Answer
rewriteAbsWith p pol a = decide (sameOrigin p a) (target (path a))
  where
  decide : Bool → Maybe (Scheme × Str × List Str) → Answer
  -- On the proxy: already proxified, or a request to cyrano itself.
  decide true  _        = if underCyrano (path a) then keep alreadyProxified
                          else emit proxyOrigin (href a)
  -- A script joined the virtual origin (https://site) to a real proxy
  -- path (/cyrano/https/site/…): move it to the proxy instead of
  -- wrapping it a second time.
  decide false (just _) = emit remapped (href (mkAbs (pScheme p) (pAuth p) (path a) (query a) (frag a)))
  decide false nothing  = emit proxified (href (proxifyWith p pol a))

rewriteAbs : Proxy → Abs → Answer
rewriteAbs p a = rewriteAbsWith p nothing a

-- REQUIREMENTS §1, for a URL `raw` found on the page whose original URL
-- is `base`.
rewriteUrlWith : Proxy → Maybe R.Policy → Abs → Str → Answer
rewriteUrlWith p pol b []       = keep emptyRef
rewriteUrlWith p pol b (c ∷ cs) = classify (preprocess (c ∷ cs))
  where
  byParse : Parsed → Answer
  byParse (url a)     = rewriteAbsWith p pol a
  byParse otherScheme = keep notProxifiable
  byParse invalid     = keep unparseable
  byParse outside     = silent

  classify : Str → Answer
  classify []       = byParse (parse (just b) [])
  classify (d ∷ ds) = if isHash d then keep anchor else byParse (parse (just b) (d ∷ ds))

rewriteUrl : Proxy → Abs → Str → Answer
rewriteUrl p b raw = rewriteUrlWith p nothing b raw

------------------------------------------------------------------------
-- Direct: what page code is shown for `raw` on a page at `base` when the
-- site is loaded without cyrano — the right-hand side of the law.

direct : Abs → Str → Answer
direct b raw = byParse (parse (just b) (preprocess raw))
  where
  byParse : Parsed → Answer
  byParse (url a)     = emit shownDirect (href a)
  byParse otherScheme = keep notProxifiable
  byParse invalid     = keep unparseable
  byParse outside     = silent

------------------------------------------------------------------------
-- Unwrap: what page code reading a proxified URL back (location.href,
-- a.href, …) is shown.

atLeastRoot : List Str → List Str
atLeastRoot []       = [] ∷ []
atLeastRoot (x ∷ xs) = x ∷ xs

-- What a URL on the proxy stands for.
data Unwrapped : Set where
  original : Abs → Unwrapped   -- a proxified URL: this original
  notOurs  : Unwrapped         -- not a proxified URL (or its host is not one)
  beyond   : Unwrapped         -- its host is outside the model

-- The host segment is read as the browser reads an authority, so a
-- segment typed by hand (H.com:443) shows as the browser shows it (h.com).
-- A segment cyrano wrote reads back unchanged (see `canonical` below).
unwrapTarget : Abs → Maybe (Scheme × Str × List Str) → Unwrapped
unwrapTarget a nothing                = notOurs
unwrapTarget a (just (sc , h , rest)) = byAuth (authority sc (pctDecode h))
  where
  byAuth : AuthResult → Unwrapped
  byAuth (authOk h′ [])      = original (mkAbs sc h′ (atLeastRoot (map pctDecode rest)) (query a) (frag a))
  byAuth (authOk h′ (_ ∷ _)) = notOurs
  byAuth authInvalid         = notOurs
  byAuth authOutside         = beyond

unwrapIf : Bool → Abs → Unwrapped
unwrapIf true  a = unwrapTarget a (target (path a))
unwrapIf false a = notOurs

unwrapAbs : Proxy → Abs → Unwrapped
unwrapAbs p a = unwrapIf (sameOrigin p a) a

unwrap : Proxy → Str → Answer
unwrap p s = byParse (parse nothing (preprocess s))
  where
  fromAbs : Abs → Unwrapped → Answer
  fromAbs a (original t) = emit unwrapped (href t)
  fromAbs a notOurs      = if sameOrigin p a then keep plainProxyPath else keep foreignOrigin
  fromAbs a beyond       = silent

  byParse : Parsed → Answer
  byParse (url a)     = fromAbs a (unwrapAbs p a)
  byParse otherScheme = keep notProxifiable
  byParse invalid     = keep unparseable
  byParse outside     = silent

------------------------------------------------------------------------
-- Laws (checked by Agda, not by tests).

≡ᵇ-refl : ∀ n → (n ≡ᵇ n) ≡ true
≡ᵇ-refl zero    = refl
≡ᵇ-refl (suc n) = ≡ᵇ-refl n

eqStr-refl : ∀ s → eqStr s s ≡ true
eqStr-refl []       = refl
eqStr-refl (c ∷ cs) rewrite ≡ᵇ-refl (toℕ c) = eqStr-refl cs

sameScheme-refl : ∀ s → sameScheme s s ≡ true
sameScheme-refl s = eqStr-refl (schemeChars s)

sameOrigin-proxify : ∀ p a → sameOrigin p (proxify p a) ≡ true
sameOrigin-proxify p a rewrite sameScheme-refl (pScheme p) | eqStr-refl (hostPort (pAuth p)) = refl

-- A URL that is kept comes back byte for byte (owner: "exact input").
keep-is-input : ∀ p b raw k → rewriteUrl p b raw ≡ keep k → answerText raw (rewriteUrl p b raw) ≡ just raw
keep-is-input p b raw k eq rewrite eq = refl

-- Rewriting is idempotent: a proxified URL is never wrapped again.
rewrite-proxified : ∀ p a → rewriteAbs p (proxify p a) ≡ keep alreadyProxified
rewrite-proxified p a rewrite sameOrigin-proxify p a = refl

-- An authority the parser itself produced, written as a segment, reads
-- back as itself. (That every parsed URL's authority is canonical is
-- checked by the oracle properties for now; proving it is the next step
-- — see README.)
canonical : Scheme → Str → Set
canonical s a = authority s (segmentOf a) ≡ authOk a []

-- Reading back undoes the escaping, for every string.
decode-escape : ∀ s → pctDecode (escapePct s) ≡ s
decode-escape []       = refl
decode-escape (c ∷ cs) with is 37 c in eq
... | true rewrite eq = cong₂ _∷_ isPct (decode-escape cs)
  where
  isPct : fromℕ 37 ≡ c
  isPct = toℕ-injective (fromℕ 37) c (sym (≡ᵇ⇒≡ (toℕ c) 37 (subst T (sym eq) _)))
    where open import Data.Bool.Base using (T)
... | false rewrite eq = cong (c ∷_) (decode-escape cs)

decode-escape-map : ∀ ps → map pctDecode (map escapePct ps) ≡ ps
decode-escape-map []       = refl
decode-escape-map (p ∷ ps) = cong₂ _∷_ (decode-escape p) (decode-escape-map ps)

escape-nonEmpty : ∀ h hs → isEmpty (escapePct (h ∷ hs)) ≡ false
escape-nonEmpty h hs with is 37 h
... | true  = refl
... | false = refl

segmentOf-cons : ∀ h hs → Σ Char (λ c → Σ Str (λ cs → segmentOf (h ∷ hs) ≡ c ∷ cs))
segmentOf-cons h hs with isSingleDot (h ∷ hs) ∨ isDoubleDot (h ∷ hs)
... | true  = h , (hs ++ fromℕ 58 ∷ []) , refl
... | false = h , hs , refl

segment-nonEmpty : ∀ h hs → isEmpty (escapePct (segmentOf (h ∷ hs))) ≡ false
segment-nonEmpty h hs with segmentOf-cons h hs
... | c , cs , eq rewrite eq = escape-nonEmpty c cs

-- The law, on parsed URLs: page code reads back exactly the URL that was
-- proxified (every parsed URL has a non-empty host and path).
unwrap-proxify : ∀ p s h hs x xs q f → canonical s (h ∷ hs) →
  unwrapAbs p (proxify p (mkAbs s (h ∷ hs) (x ∷ xs) q f)) ≡ original (mkAbs s (h ∷ hs) (x ∷ xs) q f)
unwrap-proxify p http  h hs x xs q f c rewrite sameOrigin-proxify p (mkAbs http  (h ∷ hs) (x ∷ xs) q f) | segment-nonEmpty h hs | decode-escape (segmentOf (h ∷ hs)) | c | decode-escape-map (x ∷ xs) = refl
unwrap-proxify p https h hs x xs q f c rewrite sameOrigin-proxify p (mkAbs https (h ∷ hs) (x ∷ xs) q f) | segment-nonEmpty h hs | decode-escape (segmentOf (h ∷ hs)) | c | decode-escape-map (x ∷ xs) = refl
unwrap-proxify p ws    h hs x xs q f c rewrite sameOrigin-proxify p (mkAbs ws    (h ∷ hs) (x ∷ xs) q f) | segment-nonEmpty h hs | decode-escape (segmentOf (h ∷ hs)) | c | decode-escape-map (x ∷ xs) = refl
unwrap-proxify p wss   h hs x xs q f c rewrite sameOrigin-proxify p (mkAbs wss   (h ∷ hs) (x ∷ xs) q f) | segment-nonEmpty h hs | decode-escape (segmentOf (h ∷ hs)) | c | decode-escape-map (x ∷ xs) = refl

sameOrigin-proxifyWith : ∀ p pol a → sameOrigin p (proxifyWith p pol a) ≡ true
sameOrigin-proxifyWith p nothing    a = sameOrigin-proxify p a
sameOrigin-proxifyWith p (just pol) a rewrite sameScheme-refl (pScheme p) | eqStr-refl (hostPort (pAuth p)) = refl

-- The law for a URL that carries a referrer policy: the marker is not
-- part of what page code reads back.
unwrap-proxifyWith : ∀ p s pol h hs x xs q f → canonical s (h ∷ hs) →
  unwrapAbs p (proxifyWith p (just pol) (mkAbs s (h ∷ hs) (x ∷ xs) q f)) ≡ original (mkAbs s (h ∷ hs) (x ∷ xs) q f)
unwrap-proxifyWith p http R.noReferrer h hs x xs q f c rewrite sameOrigin-proxifyWith p (just R.noReferrer) (mkAbs http (h ∷ hs) (x ∷ xs) q f) | segment-nonEmpty h hs | decode-escape (segmentOf (h ∷ hs)) | c | decode-escape-map (x ∷ xs) = refl
unwrap-proxifyWith p http R.noReferrerWhenDowngrade h hs x xs q f c rewrite sameOrigin-proxifyWith p (just R.noReferrerWhenDowngrade) (mkAbs http (h ∷ hs) (x ∷ xs) q f) | segment-nonEmpty h hs | decode-escape (segmentOf (h ∷ hs)) | c | decode-escape-map (x ∷ xs) = refl
unwrap-proxifyWith p http R.sameOrigin h hs x xs q f c rewrite sameOrigin-proxifyWith p (just R.sameOrigin) (mkAbs http (h ∷ hs) (x ∷ xs) q f) | segment-nonEmpty h hs | decode-escape (segmentOf (h ∷ hs)) | c | decode-escape-map (x ∷ xs) = refl
unwrap-proxifyWith p http R.origin h hs x xs q f c rewrite sameOrigin-proxifyWith p (just R.origin) (mkAbs http (h ∷ hs) (x ∷ xs) q f) | segment-nonEmpty h hs | decode-escape (segmentOf (h ∷ hs)) | c | decode-escape-map (x ∷ xs) = refl
unwrap-proxifyWith p http R.strictOrigin h hs x xs q f c rewrite sameOrigin-proxifyWith p (just R.strictOrigin) (mkAbs http (h ∷ hs) (x ∷ xs) q f) | segment-nonEmpty h hs | decode-escape (segmentOf (h ∷ hs)) | c | decode-escape-map (x ∷ xs) = refl
unwrap-proxifyWith p http R.originWhenCrossOrigin h hs x xs q f c rewrite sameOrigin-proxifyWith p (just R.originWhenCrossOrigin) (mkAbs http (h ∷ hs) (x ∷ xs) q f) | segment-nonEmpty h hs | decode-escape (segmentOf (h ∷ hs)) | c | decode-escape-map (x ∷ xs) = refl
unwrap-proxifyWith p http R.strictOriginWhenCrossOrigin h hs x xs q f c rewrite sameOrigin-proxifyWith p (just R.strictOriginWhenCrossOrigin) (mkAbs http (h ∷ hs) (x ∷ xs) q f) | segment-nonEmpty h hs | decode-escape (segmentOf (h ∷ hs)) | c | decode-escape-map (x ∷ xs) = refl
unwrap-proxifyWith p http R.unsafeUrl h hs x xs q f c rewrite sameOrigin-proxifyWith p (just R.unsafeUrl) (mkAbs http (h ∷ hs) (x ∷ xs) q f) | segment-nonEmpty h hs | decode-escape (segmentOf (h ∷ hs)) | c | decode-escape-map (x ∷ xs) = refl
unwrap-proxifyWith p https R.noReferrer h hs x xs q f c rewrite sameOrigin-proxifyWith p (just R.noReferrer) (mkAbs https (h ∷ hs) (x ∷ xs) q f) | segment-nonEmpty h hs | decode-escape (segmentOf (h ∷ hs)) | c | decode-escape-map (x ∷ xs) = refl
unwrap-proxifyWith p https R.noReferrerWhenDowngrade h hs x xs q f c rewrite sameOrigin-proxifyWith p (just R.noReferrerWhenDowngrade) (mkAbs https (h ∷ hs) (x ∷ xs) q f) | segment-nonEmpty h hs | decode-escape (segmentOf (h ∷ hs)) | c | decode-escape-map (x ∷ xs) = refl
unwrap-proxifyWith p https R.sameOrigin h hs x xs q f c rewrite sameOrigin-proxifyWith p (just R.sameOrigin) (mkAbs https (h ∷ hs) (x ∷ xs) q f) | segment-nonEmpty h hs | decode-escape (segmentOf (h ∷ hs)) | c | decode-escape-map (x ∷ xs) = refl
unwrap-proxifyWith p https R.origin h hs x xs q f c rewrite sameOrigin-proxifyWith p (just R.origin) (mkAbs https (h ∷ hs) (x ∷ xs) q f) | segment-nonEmpty h hs | decode-escape (segmentOf (h ∷ hs)) | c | decode-escape-map (x ∷ xs) = refl
unwrap-proxifyWith p https R.strictOrigin h hs x xs q f c rewrite sameOrigin-proxifyWith p (just R.strictOrigin) (mkAbs https (h ∷ hs) (x ∷ xs) q f) | segment-nonEmpty h hs | decode-escape (segmentOf (h ∷ hs)) | c | decode-escape-map (x ∷ xs) = refl
unwrap-proxifyWith p https R.originWhenCrossOrigin h hs x xs q f c rewrite sameOrigin-proxifyWith p (just R.originWhenCrossOrigin) (mkAbs https (h ∷ hs) (x ∷ xs) q f) | segment-nonEmpty h hs | decode-escape (segmentOf (h ∷ hs)) | c | decode-escape-map (x ∷ xs) = refl
unwrap-proxifyWith p https R.strictOriginWhenCrossOrigin h hs x xs q f c rewrite sameOrigin-proxifyWith p (just R.strictOriginWhenCrossOrigin) (mkAbs https (h ∷ hs) (x ∷ xs) q f) | segment-nonEmpty h hs | decode-escape (segmentOf (h ∷ hs)) | c | decode-escape-map (x ∷ xs) = refl
unwrap-proxifyWith p https R.unsafeUrl h hs x xs q f c rewrite sameOrigin-proxifyWith p (just R.unsafeUrl) (mkAbs https (h ∷ hs) (x ∷ xs) q f) | segment-nonEmpty h hs | decode-escape (segmentOf (h ∷ hs)) | c | decode-escape-map (x ∷ xs) = refl
unwrap-proxifyWith p ws R.noReferrer h hs x xs q f c rewrite sameOrigin-proxifyWith p (just R.noReferrer) (mkAbs ws (h ∷ hs) (x ∷ xs) q f) | segment-nonEmpty h hs | decode-escape (segmentOf (h ∷ hs)) | c | decode-escape-map (x ∷ xs) = refl
unwrap-proxifyWith p ws R.noReferrerWhenDowngrade h hs x xs q f c rewrite sameOrigin-proxifyWith p (just R.noReferrerWhenDowngrade) (mkAbs ws (h ∷ hs) (x ∷ xs) q f) | segment-nonEmpty h hs | decode-escape (segmentOf (h ∷ hs)) | c | decode-escape-map (x ∷ xs) = refl
unwrap-proxifyWith p ws R.sameOrigin h hs x xs q f c rewrite sameOrigin-proxifyWith p (just R.sameOrigin) (mkAbs ws (h ∷ hs) (x ∷ xs) q f) | segment-nonEmpty h hs | decode-escape (segmentOf (h ∷ hs)) | c | decode-escape-map (x ∷ xs) = refl
unwrap-proxifyWith p ws R.origin h hs x xs q f c rewrite sameOrigin-proxifyWith p (just R.origin) (mkAbs ws (h ∷ hs) (x ∷ xs) q f) | segment-nonEmpty h hs | decode-escape (segmentOf (h ∷ hs)) | c | decode-escape-map (x ∷ xs) = refl
unwrap-proxifyWith p ws R.strictOrigin h hs x xs q f c rewrite sameOrigin-proxifyWith p (just R.strictOrigin) (mkAbs ws (h ∷ hs) (x ∷ xs) q f) | segment-nonEmpty h hs | decode-escape (segmentOf (h ∷ hs)) | c | decode-escape-map (x ∷ xs) = refl
unwrap-proxifyWith p ws R.originWhenCrossOrigin h hs x xs q f c rewrite sameOrigin-proxifyWith p (just R.originWhenCrossOrigin) (mkAbs ws (h ∷ hs) (x ∷ xs) q f) | segment-nonEmpty h hs | decode-escape (segmentOf (h ∷ hs)) | c | decode-escape-map (x ∷ xs) = refl
unwrap-proxifyWith p ws R.strictOriginWhenCrossOrigin h hs x xs q f c rewrite sameOrigin-proxifyWith p (just R.strictOriginWhenCrossOrigin) (mkAbs ws (h ∷ hs) (x ∷ xs) q f) | segment-nonEmpty h hs | decode-escape (segmentOf (h ∷ hs)) | c | decode-escape-map (x ∷ xs) = refl
unwrap-proxifyWith p ws R.unsafeUrl h hs x xs q f c rewrite sameOrigin-proxifyWith p (just R.unsafeUrl) (mkAbs ws (h ∷ hs) (x ∷ xs) q f) | segment-nonEmpty h hs | decode-escape (segmentOf (h ∷ hs)) | c | decode-escape-map (x ∷ xs) = refl
unwrap-proxifyWith p wss R.noReferrer h hs x xs q f c rewrite sameOrigin-proxifyWith p (just R.noReferrer) (mkAbs wss (h ∷ hs) (x ∷ xs) q f) | segment-nonEmpty h hs | decode-escape (segmentOf (h ∷ hs)) | c | decode-escape-map (x ∷ xs) = refl
unwrap-proxifyWith p wss R.noReferrerWhenDowngrade h hs x xs q f c rewrite sameOrigin-proxifyWith p (just R.noReferrerWhenDowngrade) (mkAbs wss (h ∷ hs) (x ∷ xs) q f) | segment-nonEmpty h hs | decode-escape (segmentOf (h ∷ hs)) | c | decode-escape-map (x ∷ xs) = refl
unwrap-proxifyWith p wss R.sameOrigin h hs x xs q f c rewrite sameOrigin-proxifyWith p (just R.sameOrigin) (mkAbs wss (h ∷ hs) (x ∷ xs) q f) | segment-nonEmpty h hs | decode-escape (segmentOf (h ∷ hs)) | c | decode-escape-map (x ∷ xs) = refl
unwrap-proxifyWith p wss R.origin h hs x xs q f c rewrite sameOrigin-proxifyWith p (just R.origin) (mkAbs wss (h ∷ hs) (x ∷ xs) q f) | segment-nonEmpty h hs | decode-escape (segmentOf (h ∷ hs)) | c | decode-escape-map (x ∷ xs) = refl
unwrap-proxifyWith p wss R.strictOrigin h hs x xs q f c rewrite sameOrigin-proxifyWith p (just R.strictOrigin) (mkAbs wss (h ∷ hs) (x ∷ xs) q f) | segment-nonEmpty h hs | decode-escape (segmentOf (h ∷ hs)) | c | decode-escape-map (x ∷ xs) = refl
unwrap-proxifyWith p wss R.originWhenCrossOrigin h hs x xs q f c rewrite sameOrigin-proxifyWith p (just R.originWhenCrossOrigin) (mkAbs wss (h ∷ hs) (x ∷ xs) q f) | segment-nonEmpty h hs | decode-escape (segmentOf (h ∷ hs)) | c | decode-escape-map (x ∷ xs) = refl
unwrap-proxifyWith p wss R.strictOriginWhenCrossOrigin h hs x xs q f c rewrite sameOrigin-proxifyWith p (just R.strictOriginWhenCrossOrigin) (mkAbs wss (h ∷ hs) (x ∷ xs) q f) | segment-nonEmpty h hs | decode-escape (segmentOf (h ∷ hs)) | c | decode-escape-map (x ∷ xs) = refl
unwrap-proxifyWith p wss R.unsafeUrl h hs x xs q f c rewrite sameOrigin-proxifyWith p (just R.unsafeUrl) (mkAbs wss (h ∷ hs) (x ∷ xs) q f) | segment-nonEmpty h hs | decode-escape (segmentOf (h ∷ hs)) | c | decode-escape-map (x ∷ xs) = refl
