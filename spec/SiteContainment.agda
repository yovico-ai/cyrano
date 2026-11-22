{-# OPTIONS --safe #-}
------------------------------------------------------------------------
-- URL containment in host mode (owner, 2026-11-22): every proxied URL is
-- on its target origin's own host (OriginLabel.agda),
--
--     https://<label>.<domain>[:port]/cyrano/<scheme>[!marks]/<host>/<path>
--
-- or, for an origin without a label, on the proxy's own host. The path is
-- path mode's (Containment.agda) unchanged; only the authority differs.
-- So an origin's host *is* a path-mode Proxy — `atSite` — and every law
-- proved there for any Proxy holds here: page code reads back exactly the
-- URL that was proxified (`unwrap-site`), the mark is what the proxy
-- reads. The proxy's domain is an ordinary one: its hosts are one site to
-- the browser (one cookie jar, as in path mode; a domain session cookie),
-- and Origin-Agent-Cluster gives each origin's frames their own process.
--
-- On the proxy (`onProxy`): the scheme is the proxy's and the authority
-- is the apex (<domain>[:port]) or ends in "." <domain>[:port] — any
-- label, so a URL already proxified onto another site's host is kept
-- (the server redirects a request that arrives on the wrong host:
-- SiteHost.admits). Userinfo is a prefix of the authority and does not
-- change the answer.
------------------------------------------------------------------------

module SiteContainment where

open import Data.Bool.Base using (Bool; true; false; _∧_; _∨_; not; if_then_else_)
open import Data.Bool.Properties using (∨-zeroʳ)
open import Data.Char.Base using (Char; toℕ)
open import Data.List.Base using (List; []; _∷_; _++_)
open import Data.Maybe.Base using (Maybe; just; nothing)
open import Data.Product.Base using (_×_; _,_)
open import Relation.Binary.PropositionalEquality using (_≡_; refl; subst)

open import Scheme
open import Url
open import Containment
open import OriginLabel using (originLabel)
import Referrer as R

-- The proxy in host mode: its scheme and its own (apex) authority.
record SiteProxy : Set where
  constructor siteProxy
  field
    spScheme : Scheme
    spApex   : Str
open SiteProxy public

-- The port of a canonical authority as written ([] for none).
portOf : Abs → Str
portOf a = after (hostPort (auth a))
  where
  -- what follows the host's ':' ("[…]:port" past the bracket)
  after : Str → Str
  after []       = []
  after (c ∷ cs) = if is 91 c then afterBracket cs else colon (c ∷ cs)
    where
    colon : Str → Str
    colon []       = []
    colon (d ∷ ds) = if is 58 d then ds else colon ds
    afterBracket : Str → Str
    afterBracket []       = []
    afterBracket (d ∷ ds) = if is 93 d then colon ds else afterBracket ds

-- The authority serving an origin: its label's host, or the proxy's own.
hostFor : Str → Maybe Str → Str
hostFor apex (just l) = l ++ '.' ∷ apex
hostFor apex nothing  = apex

siteAuthFor : SiteProxy → Scheme → Str → Str → Str
siteAuthFor sp sc h port = hostFor (spApex sp) (originLabel sc h port)

-- A target's host, as a path-mode Proxy.
atSite : SiteProxy → Abs → Proxy
atSite sp a = proxy (spScheme sp) (siteAuthFor sp (scheme a) (R.hostOf a) (portOf a))

-- s ends in "." ++ d.
endsDot : Str → Str → Bool
endsDot d []       = false
endsDot d (c ∷ cs) = eqStr (c ∷ cs) ('.' ∷ d) ∨ endsDot d cs

onProxy : SiteProxy → Abs → Bool
onProxy sp a = sameScheme (spScheme sp) (scheme a) ∧ (eqStr (hostPort (auth a)) (hostPort (spApex sp)) ∨ endsDot (spApex sp) (auth a))

-- What a parsed URL becomes (marked m).
rewriteAbsSite : SiteProxy → Mark → Abs → Answer
rewriteAbsSite sp m a = decide (onProxy sp a) (target (path a))
  where
  decide : Bool → Maybe (Scheme × Str × List Str) → Answer
  decide true  _        = if underCyrano (path a) then keep alreadyProxified else emit proxyOrigin (href a)
  -- A script joined the virtual origin to a real proxy path: moved to the
  -- proxy — the host of the site the path names.
  -- (A host segment that is no authority: the apex; one outside the
  -- model, as everywhere: the spec does not decide.)
  decide false (just (sc , h , _)) = remapTo (authority sc (pctDecode h))
    where
    moved : Str → Answer
    moved au = emit remapped (href (mkAbs (spScheme sp) au (path a) (query a) (frag a)))
    remapTo : AuthResult → Answer
    remapTo (authOk h′ _) = moved (siteAuthFor sp sc (R.hostOf t′) (portOf t′))
      where t′ = mkAbs sc h′ [] nothing nothing
    remapTo authInvalid   = moved (spApex sp)
    remapTo authOutside   = silent
  decide false nothing  = rewriteAbsWith (atSite sp a) m a

-- REQUIREMENTS §1 in host mode, for a URL `raw` found on the page whose
-- original URL is `base`.
rewriteUrlSite : SiteProxy → Mark → Abs → Str → Answer
rewriteUrlSite sp m b []       = keep emptyRef
rewriteUrlSite sp m b (c ∷ cs) = classify (preprocess (c ∷ cs))
  where
  byParse : Parsed → Answer
  byParse (url a)     = rewriteAbsSite sp m a
  byParse otherScheme = keep notProxifiable
  byParse invalid     = keep unparseable
  byParse outside     = silent

  classify : Str → Answer
  classify []       = byParse (parse (just b) [])
  classify (d ∷ ds) = if isHash d then keep anchor else byParse (parse (just b) (d ∷ ds))

-- Reading back: from any of the proxy's hosts.
unwrapAbsSite : SiteProxy → Abs → Unwrapped
unwrapAbsSite sp a = unwrapIf (onProxy sp a) a

unwrapSite : SiteProxy → Str → Answer
unwrapSite sp s = byParse (parse nothing (preprocess s))
  where
  fromAbs : Abs → Unwrapped → Answer
  fromAbs a (original t) = emit unwrapped (href t)
  fromAbs a notOurs      = if onProxy sp a then keep plainProxyPath else keep foreignOrigin
  fromAbs a beyond       = silent

  byParse : Parsed → Answer
  byParse (url a)     = fromAbs a (unwrapAbsSite sp a)
  byParse otherScheme = keep notProxifiable
  byParse invalid     = keep unparseable
  byParse outside     = silent

------------------------------------------------------------------------
-- Laws

endsDot-suffix : ∀ d l → endsDot d (l ++ '.' ∷ d) ≡ true
endsDot-suffix d []       rewrite eqStr-refl ('.' ∷ d) = refl
endsDot-suffix d (x ∷ xs) rewrite endsDot-suffix d xs = ∨-zeroʳ _

-- On the proxy: its own host, and any label's under it.
onProxy-host : ∀ sp m a l → onProxy sp (proxifyWith (proxy (spScheme sp) (hostFor (spApex sp) l)) m a) ≡ true
onProxy-host sp m a (just l) rewrite sameScheme-refl (spScheme sp) | endsDot-suffix (spApex sp) l = ∨-zeroʳ _
onProxy-host sp m a nothing  rewrite sameScheme-refl (spScheme sp) | eqStr-refl (hostPort (spApex sp)) = refl

-- A URL proxified onto its origin's host is on the proxy.
onProxy-site : ∀ sp m a → onProxy sp (proxifyWith (atSite sp a) m a) ≡ true
onProxy-site sp m a = onProxy-host sp m a (originLabel (scheme a) (R.hostOf a) (portOf a))

-- The law in host mode: page code reads back exactly the URL that was
-- proxified, whichever site's host it is on.
unwrap-site : ∀ sp s m h hs x xs q f → canonical s (h ∷ hs) →
  unwrapAbsSite sp (proxifyWith (atSite sp (mkAbs s (h ∷ hs) (x ∷ xs) q f)) m (mkAbs s (h ∷ hs) (x ∷ xs) q f))
    ≡ original (mkAbs s (h ∷ hs) (x ∷ xs) q f)
unwrap-site sp s m h hs x xs q f c rewrite onProxy-site sp m (mkAbs s (h ∷ hs) (x ∷ xs) q f) =
  subst (λ b → unwrapIf b X ≡ original t) (sameOrigin-proxifyWith P m t) (unwrap-proxifyWith P s m h hs x xs q f c)
  where
  t = mkAbs s (h ∷ hs) (x ∷ xs) q f
  P = atSite sp t
  X = proxifyWith P m t

-- … and the mark is what the proxy reads, on any site's host.
mark-site : ∀ sp s m h hs x xs q f →
  targetMark (path (proxifyWith (atSite sp (mkAbs s (h ∷ hs) (x ∷ xs) q f)) m (mkAbs s (h ∷ hs) (x ∷ xs) q f))) ≡ m
mark-site sp s m h hs x xs q f = mark-proxifyWith (atSite sp (mkAbs s (h ∷ hs) (x ∷ xs) q f)) s m h hs x xs q f
