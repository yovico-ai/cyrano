{-# OPTIONS --safe #-}
-- Every eval the source shows, rewritten; nothing else touched (owner,
-- 2026-11-21: "we need to be safe wrapping all eval calls … if the real
-- method is not eval, do a passthrough"; and: "wrapping each and every
-- function is hardly feasible").
--
-- A call's outcome depends on what its callee is (some realm's intrinsic
-- %eval%, or anything else) and how the call is written. `eval(…)` — a
-- reference named eval — is a direct eval when the reference holds the
-- intrinsic (ECMA-262 PerformEval): the code sees the caller's scope.
-- Every other shape is indirect: the code runs in the global scope. A
-- first argument that is no string (nor a TrustedScript, whose text
-- Chromium's eval takes) is returned as it is.
--
-- The shapes, as the rewriter tells them:
--   * named   — eval(…);
--   * seen    — a call the source shows to be of eval: X.eval(…),
--               X["eval"](…), eval.call / eval.apply (and X.eval's),
--               (0, eval)(…);
--   * renamed — anything else: the intrinsic stored and called under
--               another name or property (`const e = window.eval; e(s)`),
--               Reflect.apply.
-- Guarding every call to catch the last is not done (it would put a check
-- on each call of each script): its source is evaluated as written —
-- what it does through the DOM and the network still goes through the
-- runtime's patched APIs and the navigation net.
--
-- Proxied, the outcome is the native one with every evaluated source of a
-- named or seen call rewritten:
--   * reading eval, by any route (a name, a member, reflection), gives the
--     intrinsic itself — a stand-in made `var eval = window.eval; eval(s)`
--     indirect (Salesforce's Locker evaluates every component that way,
--     inside `with (sandbox)`, and its components ran outside it);
--   * direct stays direct and indirect stays indirect;
--   * a call whose callee is not the intrinsic gets its arguments
--     unchanged (passthrough), whatever its shape.
--
-- Checked in Chromium (eval-calls-vs-chromium): for each callee, shape and
-- argument the proxied page observes what `proxied` gives — the scope the
-- code sees, whether it was rewritten (it reads the page's original URL),
-- and, for any other callee, the very argument it was given.
module Eval where

open import Data.Bool.Base using (Bool; true; false)
open import Data.List.Base using (List; _∷_; []; _++_)
open import Data.String.Base using (toList)
open import Relation.Binary.PropositionalEquality using (_≡_; refl)

open import Url using (Str)

data Callee : Set where
  intrinsic : Callee        -- some realm's %eval%
  notEval   : Callee        -- anything else

data Shape : Set where
  named   : Shape           -- eval(…): a reference named eval
  seen    : Shape           -- a call the source shows to be of eval
  renamed : Shape           -- the intrinsic called under another name

data Arg : Set where
  text   : Str → Arg        -- a string
  script : Str → Arg        -- a TrustedScript
  other  : Arg              -- anything else

data Outcome : Set where
  direct   : Str → Outcome  -- evaluated in the caller's scope
  indirect : Str → Outcome  -- evaluated in the global scope
  returned : Outcome        -- eval of no string: the argument returned
  passed   : Arg → Outcome  -- not eval: the callee called with this argument

-- What the call does natively.
native : Callee → Shape → Arg → Outcome
native notEval   _       a          = passed a
native intrinsic _       other      = returned
native intrinsic named   (text s)   = direct s
native intrinsic named   (script s) = direct s
native intrinsic _       (text s)   = indirect s
native intrinsic _       (script s) = indirect s

-- What it does proxied, given the JS rewriter.
proxied : (Str → Str) → Callee → Shape → Arg → Outcome
proxied rw c renamed a = native c renamed a
proxied rw c sh a = over (native c sh a)
  where
  over : Outcome → Outcome
  over (direct s)   = direct (rw s)
  over (indirect s) = indirect (rw s)
  over o            = o

-- Not eval: the argument goes through as it is, whatever the shape.
passthrough : ∀ rw sh a → proxied rw notEval sh a ≡ passed a
passthrough rw named   a = refl
passthrough rw seen    a = refl
passthrough rw renamed a = refl

-- A named call of the intrinsic on text stays direct (its source rewritten).
stays-direct : ∀ rw s → proxied rw intrinsic named (text s) ≡ direct (rw s)
stays-direct rw s = refl

-- A seen call stays indirect (its source rewritten).
stays-indirect : ∀ rw s → proxied rw intrinsic seen (text s) ≡ indirect (rw s)
stays-indirect rw s = refl

-- The stated limit: a renamed call is native, source as written.
renamed-native : ∀ rw c a → proxied rw c renamed a ≡ native c renamed a
renamed-native rw c a = refl

-- Eval of no string returns it, as natively.
returns-other : ∀ rw sh → proxied rw intrinsic sh other ≡ returned
returns-other rw named   = refl
returns-other rw seen    = refl
returns-other rw renamed = refl

-- The outcome as the oracle writes it, the rewrite marked R(…).
show : Outcome → Str
show (direct s)          = toList "direct " ++ s
show (indirect s)        = toList "indirect " ++ s
show returned            = toList "returned"
show (passed (text s))   = toList "passed text " ++ s
show (passed (script s)) = toList "passed script " ++ s
show (passed other)      = toList "passed other"

marked : Str → Str
marked s = toList "R(" ++ s ++ toList ")"
