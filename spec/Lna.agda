{-# OPTIONS --safe #-}
------------------------------------------------------------------------
-- Local Network Access (WICG; Chromium's IPAddressSpace). Through the
-- proxy every request is same-origin to the browser, so Chromium never
-- judged one: a public site's page reached loopback and private
-- addresses — the proxy host's own services, routers, cloud metadata —
-- where Chromium refuses them without the user's permission (round K).
-- The proxy judges it by the original documents and the addresses it
-- connects to, and refuses (it cannot ask the user for the permission).
--
--   * An address's space: loopback (127/8, ::1), local (10/8,
--     172.16/12, 192.168/16, 169.254/16, fc00::/7, fe80::/10), else
--     public. A document's space is its own response's address's.
--   * A request is refused when its target's space is less public than
--     its document's: public → local or loopback, local → loopback. A
--     navigation (Sec-Fetch-Mode navigate) is not judged.
------------------------------------------------------------------------

module Lna where

open import Data.Bool.Base using (Bool; true; false; _∧_; _∨_; not; if_then_else_)
open import Data.List.Base using (List; []; _∷_)
open import Data.Nat.Base using (ℕ; _<ᵇ_; _≡ᵇ_; _≤ᵇ_)

data Space : Set where
  spLoopback spLocal spPublic : Space

rank : Space → ℕ
rank spLoopback = 0
rank spLocal    = 1
rank spPublic   = 2

within : ℕ → ℕ → ℕ → Bool
within lo hi n = (lo ≤ᵇ n) ∧ (n ≤ᵇ hi)

-- An IPv4 address by its four octets.
space4 : ℕ → ℕ → ℕ → ℕ → Space
space4 a b c d =
  if (a ≡ᵇ 127) then spLoopback
  else if (a ≡ᵇ 10) ∨ ((a ≡ᵇ 172) ∧ within 16 31 b) ∨ ((a ≡ᵇ 192) ∧ (b ≡ᵇ 168)) ∨ ((a ≡ᵇ 169) ∧ (b ≡ᵇ 254)) then spLocal
  else spPublic

-- An IPv6 address by its eight 16-bit groups.
space6 : List ℕ → Space
space6 (0 ∷ 0 ∷ 0 ∷ 0 ∷ 0 ∷ 0 ∷ 0 ∷ 1 ∷ []) = spLoopback
space6 (g ∷ _) =
  if within 64512 65023 g then spLocal          -- fc00::/7
  else if within 65152 65215 g then spLocal     -- fe80::/10
  else spPublic
space6 [] = spPublic

-- Is the request refused: its document's space, the target's, whether it
-- is a navigation.
refused : Space → Space → Bool → Bool
refused doc target navigation = not navigation ∧ (rank target <ᵇ rank doc)
