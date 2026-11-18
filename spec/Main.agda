-- Executable IO boundary only: no parsing, no rules. Both live in
-- Oracle.agda so they type-check under --safe; this file cannot, because
-- of the one FFI postulate below. Protocol: read a line, answer a line,
-- forever. The test harness kills this process when it is done rather
-- than closing stdin, so the loop never needs to detect end-of-input.
{-# OPTIONS --guardedness #-}
module Main where

open import Data.Unit.Polymorphic.Base using (⊤)
import Data.Unit.Base as Unit0 using (⊤)
open import IO using (IO; Main; run; forever; lift′; _>>_; _>>=_)
import IO.Primitive.Core as Prim using (IO)
open import IO.Finite using (getLine; putStrLn)
open import Level using (0ℓ)
open import Oracle using (evaluate)

-- GHC block-buffers stdout whenever it is not a terminal — which a pipe
-- from a test harness never is — so a one-line reply sits in a buffer
-- instead of reaching the caller, and the protocol hangs on the very
-- first query. IO.Finite exposes no buffering control; this reaches past
-- it to the one Haskell call that fixes it. Keep it.
postulate
  primSetLineBuffering : Prim.IO Unit0.⊤

{-# FOREIGN GHC import System.IO #-}
{-# COMPILE GHC primSetLineBuffering = System.IO.hSetBuffering System.IO.stdout System.IO.LineBuffering #-}

setLineBuffering : IO {0ℓ} ⊤
setLineBuffering = lift′ primSetLineBuffering

respondOnce : IO {0ℓ} ⊤
respondOnce = getLine >>= λ line → putStrLn (evaluate line)

main : Main
main = run (setLineBuffering >> forever respondOnce)
