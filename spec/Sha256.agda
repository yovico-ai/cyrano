{-# OPTIONS --safe #-}
------------------------------------------------------------------------
-- SHA-256 (FIPS 180-4) and base32 (RFC 4648 §6, lower case, no padding),
-- over natural numbers: what a proxied site's host label is made of
-- (spec/SiteHost.agda). Words are naturals below 2^32; the bitwise
-- operations take them apart bit by bit (32 steps), which the compiled
-- oracle does in Haskell integers — a site key is one or two blocks.
--
-- Checked through the oracle against the published vectors, Go's
-- crypto/sha256 and the browser's SubtleCrypto (sitehost conformance).
------------------------------------------------------------------------

module Sha256 where

open import Data.Bool.Base using (Bool; true; false; if_then_else_)
open import Data.List.Base using (List; []; _∷_; _++_; length; map; foldl; replicate; take; drop; reverse)
open import Data.Nat.Base using (ℕ; zero; suc; _+_; _*_; _∸_; _%_; _/_; _≡ᵇ_; _<ᵇ_)
open import Data.Char.Base using (Char)
open import Data.String.Base using (String; toList)
open import Data.Product.Base using (_×_; _,_)
open import Agda.Builtin.Nat using (div-helper; mod-helper)

------------------------------------------------------------------------
-- 32-bit words

two32 : ℕ
two32 = 4294967296

-- Bitwise, LSB first, over n bits.
bitwise : (Bool → Bool → Bool) → ℕ → ℕ → ℕ → ℕ
bitwise f zero    _ _ = 0
bitwise f (suc n) a b = bit (f (odd a) (odd b)) + 2 * bitwise f n (a / 2) (b / 2)
  where
  odd : ℕ → Bool
  odd x = (x % 2) ≡ᵇ 1
  bit : Bool → ℕ
  bit true  = 1
  bit false = 0

xorB andB : Bool → Bool → Bool
xorB true  b = if b then false else true
xorB false b = b
andB true  b = b
andB false _ = false

_⊕_ _&_ : ℕ → ℕ → ℕ
a ⊕ b = bitwise xorB 32 a b
a & b = bitwise andB 32 a b

complement : ℕ → ℕ
complement a = (two32 ∸ 1) ∸ a

pow2 : ℕ → ℕ
pow2 zero    = 1
pow2 (suc n) = 2 * pow2 n

-- Division and remainder by any divisor (by zero: 0 and n), as the
-- builtin helpers compute them.
divN modN : ℕ → ℕ → ℕ
divN n zero    = 0
divN n (suc d) = div-helper 0 d n d
modN n zero    = n
modN n (suc d) = mod-helper 0 d n d

-- Rotate right / shift right, by k < 32.
rotr : ℕ → ℕ → ℕ
rotr k x = divN x (pow2 k) + (modN x (pow2 k) * pow2 (32 ∸ k))

shr : ℕ → ℕ → ℕ
shr k x = divN x (pow2 k)

add : ℕ → ℕ → ℕ
add a b = (a + b) % two32

------------------------------------------------------------------------
-- Constants

K : List ℕ
K = 1116352408 ∷ 1899447441 ∷ 3049323471 ∷ 3921009573 ∷ 961987163 ∷ 1508970993 ∷ 2453635748 ∷ 2870763221 ∷
    3624381080 ∷ 310598401 ∷ 607225278 ∷ 1426881987 ∷ 1925078388 ∷ 2162078206 ∷ 2614888103 ∷ 3248222580 ∷
    3835390401 ∷ 4022224774 ∷ 264347078 ∷ 604807628 ∷ 770255983 ∷ 1249150122 ∷ 1555081692 ∷ 1996064986 ∷
    2554220882 ∷ 2821834349 ∷ 2952996808 ∷ 3210313671 ∷ 3336571891 ∷ 3584528711 ∷ 113926993 ∷ 338241895 ∷
    666307205 ∷ 773529912 ∷ 1294757372 ∷ 1396182291 ∷ 1695183700 ∷ 1986661051 ∷ 2177026350 ∷ 2456956037 ∷
    2730485921 ∷ 2820302411 ∷ 3259730800 ∷ 3345764771 ∷ 3516065817 ∷ 3600352804 ∷ 4094571909 ∷ 275423344 ∷
    430227734 ∷ 506948616 ∷ 659060556 ∷ 883997877 ∷ 958139571 ∷ 1322822218 ∷ 1537002063 ∷ 1747873779 ∷
    1955562222 ∷ 2024104815 ∷ 2227730452 ∷ 2361852424 ∷ 2428436474 ∷ 2756734187 ∷ 3204031479 ∷ 3329325298 ∷ []

H0 : List ℕ
H0 = 1779033703 ∷ 3144134277 ∷ 1013904242 ∷ 2773480762 ∷ 1359893119 ∷ 2600822924 ∷ 528734635 ∷ 1541459225 ∷ []

------------------------------------------------------------------------
-- Padding and blocks

-- n as `k` big-endian bytes.
bytesBE : ℕ → ℕ → List ℕ
bytesBE k n = go k n []
  where
  go : ℕ → ℕ → List ℕ → List ℕ
  go zero    _ acc = acc
  go (suc i) m acc = go i (m / 256) ((m % 256) ∷ acc)

-- The message, a 1 bit, zeros to 56 mod 64 bytes, its length in bits.
pad : List ℕ → List ℕ
pad msg = msg ++ (128 ∷ replicate zeros 0) ++ bytesBE 8 (8 * len)
  where
  len = length msg
  zeros = (119 ∸ (len % 64)) % 64

-- Big-endian words of four bytes.
words : List ℕ → List ℕ
words (a ∷ b ∷ c ∷ d ∷ rest) = (((a * 256 + b) * 256 + c) * 256 + d) ∷ words rest
words _ = []

blocks : ℕ → List ℕ → List (List ℕ)
blocks zero    _  = []
blocks (suc f) [] = []
blocks (suc f) ws = take 16 ws ∷ blocks f (drop 16 ws)

------------------------------------------------------------------------
-- Compression

at : List ℕ → ℕ → ℕ
at []       _       = 0
at (x ∷ _)  zero    = x
at (_ ∷ xs) (suc i) = at xs i

σ0 σ1 Σ0 Σ1 : ℕ → ℕ
σ0 x = (rotr 7 x ⊕ rotr 18 x) ⊕ shr 3 x
σ1 x = (rotr 17 x ⊕ rotr 19 x) ⊕ shr 10 x
Σ0 x = (rotr 2 x ⊕ rotr 13 x) ⊕ rotr 22 x
Σ1 x = (rotr 6 x ⊕ rotr 11 x) ⊕ rotr 25 x

-- The 64-word schedule, built forwards (newest last).
schedule : List ℕ → List ℕ
schedule w16 = go 48 w16
  where
  go : ℕ → List ℕ → List ℕ
  go zero    ws = ws
  go (suc n) ws = go n (ws ++ (next ∷ []))
    where
    t = length ws
    next = add (add (σ1 (at ws (t ∸ 2))) (at ws (t ∸ 7))) (add (σ0 (at ws (t ∸ 15))) (at ws (t ∸ 16)))

record State : Set where
  constructor st
  field a b c d e f g h : ℕ

round : State → ℕ × ℕ → State
round (st a b c d e f g h) (k , w) = st (add t1 t2) a b c (add d t1) e f g
  where
  ch  = (e & f) ⊕ (complement e & g)
  maj = ((a & b) ⊕ (a & c)) ⊕ (b & c)
  t1  = add (add (add h (Σ1 e)) (add ch k)) w
  t2  = add (Σ0 a) maj

zipKW : List ℕ → List ℕ → List (ℕ × ℕ)
zipKW (k ∷ ks) (w ∷ ws) = (k , w) ∷ zipKW ks ws
zipKW _ _ = []

-- Adds a block's final state into the running hash. (A function of its
-- own, not a `with`: abstracting the 64 rounds made the type checker
-- unfold them symbolically.)
addState : List ℕ → State → List ℕ
addState hs (st a b c d e f g h) =
  add (at hs 0) a ∷ add (at hs 1) b ∷ add (at hs 2) c ∷ add (at hs 3) d ∷
  add (at hs 4) e ∷ add (at hs 5) f ∷ add (at hs 6) g ∷ add (at hs 7) h ∷ []

compress : List ℕ → List ℕ → List ℕ
compress hs blk = addState hs (foldl round (st (at hs 0) (at hs 1) (at hs 2) (at hs 3) (at hs 4) (at hs 5) (at hs 6) (at hs 7)) (zipKW K (schedule blk)))

concatMapW : List ℕ → List ℕ
concatMapW []       = []
concatMapW (w ∷ ws) = bytesBE 4 w ++ concatMapW ws

-- The digest of a byte string: 32 bytes.
sha256 : List ℕ → List ℕ
sha256 msg = concatMapW (foldl compress H0 (blocks (length p) (words p)))
  where p = pad msg

------------------------------------------------------------------------
-- base32, RFC 4648 §6, lower case, no padding

alphabet : List Char
alphabet = toList "abcdefghijklmnopqrstuvwxyz234567"

charAt : ℕ → Char
charAt i = pick alphabet i
  where
  pick : List Char → ℕ → Char
  pick []       _       = 'a'
  pick (c ∷ _)  zero    = c
  pick (_ ∷ cs) (suc j) = pick cs j

-- Five bits at a time from the front; the last group zero-filled.
base32 : List ℕ → List Char
base32 bs = go (length bs * 8) 0 0 bs
  where
  -- fuel, bits held (count), their value, bytes left
  go : ℕ → ℕ → ℕ → List ℕ → List Char
  go zero      _ _ _ = []
  go (suc fuel) n acc rest =
    if n <ᵇ 5 then more rest
    else charAt (divN acc (pow2 (n ∸ 5))) ∷ go fuel (n ∸ 5) (modN acc (pow2 (n ∸ 5))) rest
    where
    more : List ℕ → List Char
    more (b ∷ bs′) = go fuel (n + 8) (acc * 256 + b) bs′
    more []        = if n ≡ᵇ 0 then [] else charAt (acc * pow2 (5 ∸ n)) ∷ []

------------------------------------------------------------------------
-- Hex, for the oracle (`sha256` op) and its checks: the published vectors
-- (FIPS 180-4 examples, RFC 4648 §10) are asked of the compiled oracle by
-- the conformance tests — evaluating SHA-256 in the type checker takes
-- minutes per vector.

hex : List ℕ → List Char
hex []       = []
hex (b ∷ bs) = digit (b / 16) ∷ digit (b % 16) ∷ hex bs
  where
  digit : ℕ → Char
  digit n = pick (toList "0123456789abcdef") n
    where
    pick : List Char → ℕ → Char
    pick []       _       = '0'
    pick (c ∷ _)  zero    = c
    pick (_ ∷ cs) (suc j) = pick cs j
