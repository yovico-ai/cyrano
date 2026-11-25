{-# OPTIONS --safe #-}
------------------------------------------------------------------------
-- CORS preflights (Fetch §3.2.2 CORS-safelisted request-headers, §4.8
-- CORS-preflight fetch; Chromium 147, measured: preflight-vs-chromium).
--
-- Under the proxy every request is same-origin to the browser, so it never
-- preflighted one: a cross-origin PUT, DELETE, a JSON POST, a request with
-- a header of the page's own went straight to the origin — one the origin
-- refuses at the preflight reached it and acted (a write the page could
-- not have made), and the origin saw no OPTIONS where a browser always
-- sends one (Cloudflare-fronted APIs refuse that). The proxy now does what
-- the browser would: for a cross-origin request in cors mode (Fetch.agda
-- namesContext: the runtime names its context) that needs one, it first
-- sends the preflight and fails the request — never sent — when it does
-- not pass.
--
--   * A request needs one when its method is not GET, HEAD or POST, when
--     one of the headers the page set (the runtime names them; a body's
--     Content-Type counts too, whoever set it) is not safelisted by its
--     value, or when an XHR has upload listeners (forced).
--   * Safelisted: accept (no CORS-unsafe byte), accept-language and
--     content-language (0-9 A-Z a-z space * , - . ; = only), content-type
--     (no unsafe byte; essence application/x-www-form-urlencoded,
--     multipart/form-data or text/plain), range ("bytes=" start "-" [end],
--     start ≤ end); any value of at most 128 bytes. (Fetch's 1024-byte
--     total cannot be reached by these five.)
--   * The preflight names the method and the unsafe header names
--     (lowercased, sorted, joined by ","); it passes on a 2xx status, the
--     CORS check (Fetch.corsCheck) by the request's credentials, the
--     method listed in Access-Control-Allow-Methods (exactly: case
--     matters) or safelisted or "*" without credentials, and every unsafe
--     name listed in Access-Control-Allow-Headers (case aside) or "*"
--     without credentials — authorization too (Chromium; Fetch excludes
--     it). A list that is not tokens fails it.
--   * Its result is kept Access-Control-Max-Age seconds: a number up to
--     7200 (Chromium's cap), a negative one 0, anything else 5.
------------------------------------------------------------------------

module Preflight where

open import Data.Bool.Base using (Bool; true; false; _∧_; _∨_; not; if_then_else_)
open import Data.Char.Base using (Char; toℕ)
open import Data.List.Base using (List; []; _∷_; _++_; map; length)
open import Data.Maybe.Base using (Maybe; just; nothing)
open import Data.Nat.Base using (ℕ; zero; suc; _+_; _*_; _<ᵇ_; _≡ᵇ_; _∸_)
open import Data.Product.Base using (_×_; _,_; proj₁; proj₂)
open import Data.String.Base using (toList)

open import Url using (Str; is; eqStr; isAlpha; isDigit; all; any; dropWhile; splitOn)
open import Fetch using (corsCheck; isOWS; trimWith; lowerAll; member; isTchar)

------------------------------------------------------------------------
-- Request headers.

unsafeByte : Char → Bool
unsafeByte c = ((toℕ c <ᵇ 32) ∧ not (is 9 c)) ∨ is 127 c ∨ any (λ u → eqStr (u ∷ []) (c ∷ [])) (toList "\"():<>?@[\\]{}")

langChar : Char → Bool
langChar c = isAlpha c ∨ isDigit c ∨ any (λ u → eqStr (u ∷ []) (c ∷ [])) (toList " *,-.;=")

-- A content-type's essence, as the safelist judges it: up to ";", OWS
-- trimmed, lowercased.
essence : Str → Str
essence v = lowerAll (trimWith isOWS (upTo v))
  where
  upTo : Str → Str
  upTo [] = []
  upTo (c ∷ cs) = if is 59 c then [] else c ∷ upTo cs

digitsValue : Str → ℕ
digitsValue = go 0
  where
  go : ℕ → Str → ℕ
  go n [] = n
  go n (c ∷ cs) = go (n * 10 + (toℕ c ∸ 48)) cs

-- "bytes=" start "-" [end], start ≤ end.
simpleRange : Str → Bool
simpleRange ('b' ∷ 'y' ∷ 't' ∷ 'e' ∷ 's' ∷ '=' ∷ rest) = split [] rest
  where
  split : Str → Str → Bool
  split acc ('-' ∷ end) = (not (eqStr acc [])) ∧ all isDigit (Data.List.Base.reverse acc) ∧ all isDigit end
                          ∧ (eqStr end [] ∨ not (digitsValue end <ᵇ digitsValue (Data.List.Base.reverse acc)))
  split acc (c ∷ cs) = split (c ∷ acc) cs
  split acc [] = false
simpleRange _ = false

safelistedHeader : Str → Str → Bool
safelistedHeader name v =
  not (128 <ᵇ length v) ∧ byName (lowerAll name)
  where
  byName : Str → Bool
  byName n =
    if eqStr n (toList "accept") then all (λ c → not (unsafeByte c)) v
    else if eqStr n (toList "accept-language") ∨ eqStr n (toList "content-language") then all langChar v
    else if eqStr n (toList "content-type") then all (λ c → not (unsafeByte c)) v ∧
      (eqStr (essence v) (toList "application/x-www-form-urlencoded") ∨ eqStr (essence v) (toList "multipart/form-data") ∨ eqStr (essence v) (toList "text/plain"))
    else if eqStr n (toList "range") then simpleRange v
    else false

-- Sorted (code point order), no repeats.
ltStr : Str → Str → Bool
ltStr [] [] = false
ltStr [] (_ ∷ _) = true
ltStr (_ ∷ _) [] = false
ltStr (a ∷ as) (b ∷ bs) = if toℕ a <ᵇ toℕ b then true else if toℕ b <ᵇ toℕ a then false else ltStr as bs

insert : Str → List Str → List Str
insert x [] = x ∷ []
insert x (y ∷ ys) = if eqStr x y then y ∷ ys else if ltStr x y then x ∷ y ∷ ys else y ∷ insert x ys

-- The CORS-unsafe request-header names: lowercased, sorted, no repeats.
unsafeNames : List (Str × Str) → List Str
unsafeNames [] = []
unsafeNames ((n , v) ∷ hs) = if safelistedHeader n v then unsafeNames hs else insert (lowerAll n) (unsafeNames hs)

safelistedMethod : Str → Bool
safelistedMethod m = eqStr m (toList "GET") ∨ eqStr m (toList "HEAD") ∨ eqStr m (toList "POST")

needsPreflight : Str → Bool → List (Str × Str) → Bool
needsPreflight method force hs = force ∨ not (safelistedMethod method) ∨ not (eqNil (unsafeNames hs))
  where
  eqNil : List Str → Bool
  eqNil [] = true
  eqNil _  = false

-- Access-Control-Request-Headers: the unsafe names joined by ",".
requestHeaders : List (Str × Str) → Str
requestHeaders hs = join (unsafeNames hs)
  where
  join : List Str → Str
  join [] = []
  join (n ∷ []) = n
  join (n ∷ ns) = n ++ (',' ∷ join ns)

------------------------------------------------------------------------
-- The response.

-- One field line's items (tokens), as written; nothing when one is not a token.
items : Str → Maybe (List Str)
items v = go (splitOn (is 44) v)
  where
  go : List Str → Maybe (List Str)
  go [] = just []
  go (i ∷ is′) with trimWith isOWS i | go is′
  ... | [] | rest = rest
  ... | t@(_ ∷ _) | just ns = if all isTchar t then just (t ∷ ns) else nothing
  ... | t@(_ ∷ _) | nothing = nothing

allItems : List Str → Maybe (List Str)
allItems [] = just []
allItems (l ∷ ls) with items l | allItems ls
... | just a | just b = just (a ++ b)
... | _ | _ = nothing

-- status; Access-Control-Allow-Origin, -Credentials (Fetch's "get");
-- the Allow-Methods and Allow-Headers field lines; the request's origin,
-- credentials, method and unsafe header names.
preflightOk : ℕ → Maybe Str → Maybe Str → List Str → List Str → Str → Bool → Str → List Str → Bool
preflightOk status ao ac am ah origin cred method unsafe =
  not (status <ᵇ 200) ∧ (status <ᵇ 300) ∧ corsCheck ao ac origin cred ∧ methodsOk (allItems am) ∧ headersOk (allItems ah)
  where
  methodsOk : Maybe (List Str) → Bool
  methodsOk nothing   = false
  methodsOk (just ms) = safelistedMethod method ∨ member method ms ∨ (not cred ∧ member (toList "*") ms)
  headersOk : Maybe (List Str) → Bool
  headersOk nothing   = false
  headersOk (just hs) = every unsafe
    where
    lowered : List Str
    lowered = map lowerAll hs
    every : List Str → Bool
    every [] = true
    every (n ∷ ns) = (member n lowered ∨ (not cred ∧ member (toList "*") lowered)) ∧ every ns

-- How long a passed preflight is kept (seconds).
maxAge : Maybe Str → ℕ
maxAge nothing = 5
maxAge (just v) = byText (trimWith isOWS v)
  where
  cap : ℕ → ℕ
  cap n = if 7200 <ᵇ n then 7200 else n
  byText : Str → ℕ
  byText [] = 5
  byText ('-' ∷ ds@(_ ∷ _)) = if all isDigit ds then 0 else 5
  byText ds = if all isDigit ds then cap (digitsValue ds) else 5
