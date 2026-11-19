{-# OPTIONS --safe #-}
-- HTTPS-Upgrades as Chrome does them, re-enacted by the proxy (Go:
-- proxy/https_upgrades.go). A direct Chrome tries a main-frame http
-- navigation over https first and falls back to http when that fails; the
-- proxy sends the browser from /cyrano/http/… to /cyrano/https/… (a 307)
-- and back on failure, then remembers the host as http-only for the
-- session.
--
--   * Which navigations: GET, Sec-Fetch-Mode navigate, Sec-Fetch-Dest
--     document, to a host Chrome upgrades — a name (not an IP literal),
--     not localhost or *.localhost, on the default port, that is unique
--     (Chromium IsHostnameNonUnique): it has more than one label and its
--     last is a top-level domain of the public-suffix list's ICANN
--     section — a.example, x.test are not upgraded; co.uk, a.ck (itself a
--     public suffix) are, com is not. The list is outside the model, as in
--     Cookies.agda: the caller says whether the TLD is known. Checked
--     against Chrome (upgrades-vs-chrome; Playwright's Chromium has the
--     feature off).
--   * The scheme is swapped in the proxified URL's scheme segment, its
--     marks kept (an <a referrerpolicy> navigation is /cyrano/http!origin/…:
--     matching "/cyrano/http/" alone left it never upgraded).
--   * Per session and host (port 80/443 aside): an upgrade sent is pending
--     for 30 s. An http navigation while it is pending is the https page
--     sending the browser back: a fallback, the host http-only for a week.
--     An https page that loads (not a redirect) ends it; an https load
--     that fails while it is pending falls back (a 307 to http).
module Upgrades where

open import Data.Bool.Base using (Bool; true; false; _∨_; _∧_; not; if_then_else_)
open import Data.Char.Base using (Char)
open import Data.List.Base using (List; []; _∷_; _++_; map; reverse)
open import Data.Maybe.Base using (Maybe; just; nothing)
open import Data.Nat.Base using (ℕ; _+_; _<ᵇ_)
open import Data.Product.Base using (_×_; _,_)
open import Data.String.Base using (toList)

open import Url using (Str; is; isDigit; lowerAscii; eqStr; splitOn; splitLast; ipv4; any; break)

------------------------------------------------------------------------
-- Which hosts.

-- host[:port] → (host, port); a bracketed IPv6 literal kept whole.
hostPort : Str → Str × Str
hostPort s with splitLast (is 58) s
... | nothing = s , []
... | just (h , p) = if all isDigit p ∧ not (any (is 93) p) then (if inBrackets h then h , p else h , p) else s , []
  where
  all : (Char → Bool) → Str → Bool
  all f []       = true
  all f (c ∷ cs) = f c ∧ all f cs
  inBrackets : Str → Bool
  inBrackets ('[' ∷ _) = true
  inBrackets _         = false

dropTrailingDot : Str → Str
dropTrailingDot s with reverse s
... | '.' ∷ r = reverse r
... | _       = s

endsWith : Str → Str → Bool
endsWith suffix s = eqStr (take (len suffix) (reverse s)) (reverse suffix)
  where
  len : Str → ℕ
  len []       = 0
  len (_ ∷ cs) = Data.Nat.Base.suc (len cs)
  take : ℕ → Str → Str
  take 0 _ = []
  take (Data.Nat.Base.suc n) [] = []
  take (Data.Nat.Base.suc n) (c ∷ cs) = c ∷ take n cs
    where import Data.Nat.Base

-- knownTld: the name's last label is an ICANN top-level domain.
upgradable : Bool → Str → Bool
upgradable knownTld hp with hostPort hp
... | (h₀ , p) =
  knownTld
  ∧ (eqStr p [] ∨ eqStr p (toList "80"))
  ∧ not (eqStr h [])
  ∧ not (bracketed h ∨ isIPv4 h)
  ∧ any (is 46) h
  ∧ not (eqStr h (toList "localhost") ∨ endsWith (toList ".localhost") h)
  where
  h : Str
  h = dropTrailingDot (map lowerAscii h₀)
  bracketed : Str → Bool
  bracketed ('[' ∷ _) = true
  bracketed _         = false
  isIPv4 : Str → Bool
  isIPv4 s with ipv4 s
  ... | just _  = all4 s
    where
    -- only a host the URL parser left as four decimal numbers is one here
    all4 : Str → Bool
    all4 t = Data.List.Base.length (splitOn (is 46) t) Data.Nat.Base.≡ᵇ 4
      where import Data.List.Base; import Data.Nat.Base
  ... | nothing = false

------------------------------------------------------------------------
-- The scheme swap, on a request's target (its path and query): the scheme
-- segment's scheme replaced, its marks kept; nothing when the target is
-- not /cyrano/<from>[!…]/….

swapScheme : Str → Str → Str → Maybe Str
swapScheme from to t with t
... | '/' ∷ rest with break (is 47) rest
...   | (c , '/' ∷ rest₁) with break (is 47) rest₁
...     | (seg , '/' ∷ rest₂) with break (is 33) seg
...       | (sc , marks) =
  if eqStr c (toList "cyrano") ∧ eqStr sc from
  then just ('/' ∷ c ++ '/' ∷ to ++ marks ++ '/' ∷ rest₂)
  else nothing
swapScheme from to t | '/' ∷ rest | (c , '/' ∷ rest₁) | (seg , _) = nothing
swapScheme from to t | '/' ∷ rest | (c , _) = nothing
swapScheme from to t | _ = nothing

------------------------------------------------------------------------
-- The session state for one host, and the events.

-- When the upgrade was sent; when the host was found http-only.
record HostState : Set where
  constructor hostState
  field
    pending  : Maybe ℕ
    fallback : Maybe ℕ
open HostState public

pendingFor fallbackFor : ℕ
pendingFor  = 30
fallbackFor = 604800

freshAt : ℕ → ℕ → Maybe ℕ → Bool
freshAt now ttl (just t) = now <ᵇ (t + ttl)
freshAt now ttl nothing  = false

data Decision : Set where
  sendUpgrade passThrough : Decision

-- A main-frame http navigation to an upgradable host, at time now.
onHttpNavigation : ℕ → HostState → Decision × HostState
onHttpNavigation now s =
  if freshAt now fallbackFor (fallback s) then passThrough , s
  else if freshAt now pendingFor (pending s) then passThrough , hostState nothing (just now)
  else sendUpgrade , hostState (just now) (fallback s)

-- An upgraded https navigation's page loaded (not a redirect).
onLoaded : HostState → HostState
onLoaded s = hostState nothing (fallback s)

-- An https navigation's load failed: back to http while pending.
onFailed : ℕ → HostState → Bool × HostState
onFailed now s =
  if freshAt now pendingFor (pending s) then true , hostState nothing (just now)
  else false , s
