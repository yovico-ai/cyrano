{-# OPTIONS --safe #-}
-- The schemes cyrano routes through the proxy. Every other scheme
-- (javascript:, data:, blob:, mailto:, tel:, about:, ftp:, …) is left
-- alone, because the proxy cannot fetch it on the user's behalf
-- (REQUIREMENTS §1).
module Scheme where

open import Data.Char.Base using (Char)
open import Data.List.Base using (List; []; _∷_)
open import Data.List.Membership.Propositional using (_∈_)
open import Data.List.Relation.Unary.Any using (here; there)
open import Data.Maybe.Base using (Maybe; just; nothing)
open import Data.Nat.Base using (ℕ)
open import Data.String.Base using (String; toList; fromList)
open import Relation.Binary.PropositionalEquality using (_≡_; refl)

data Scheme : Set where
  http  : Scheme
  https : Scheme
  ws    : Scheme
  wss   : Scheme

schemeText : Scheme → String
schemeText http  = "http"
schemeText https = "https"
schemeText ws    = "ws"
schemeText wss   = "wss"

schemeP : String → Maybe Scheme
schemeP "http"  = just http
schemeP "https" = just https
schemeP "ws"    = just ws
schemeP "wss"   = just wss
schemeP _       = nothing

-- The same, on the character lists the URL parser works with.
schemeChars : Scheme → List Char
schemeChars s = toList (schemeText s)

schemeOf : List Char → Maybe Scheme
schemeOf cs = schemeP (fromList cs)

-- WHATWG "default port": a URL that names it explicitly is the same URL
-- as one that does not, and the browser serializes it without one.
defaultPort : Scheme → ℕ
defaultPort http  = 80
defaultPort https = 443
defaultPort ws    = 80
defaultPort wss   = 443

allSchemes : List Scheme
allSchemes = http ∷ https ∷ ws ∷ wss ∷ []

allSchemes-complete : ∀ s → s ∈ allSchemes
allSchemes-complete http  = here refl
allSchemes-complete https = there (here refl)
allSchemes-complete ws    = there (there (here refl))
allSchemes-complete wss   = there (there (there (here refl)))

schemeP-schemeText : ∀ s → schemeP (schemeText s) ≡ just s
schemeP-schemeText http  = refl
schemeP-schemeText https = refl
schemeP-schemeText ws    = refl
schemeP-schemeText wss   = refl

schemeOf-schemeChars : ∀ s → schemeOf (schemeChars s) ≡ just s
schemeOf-schemeChars http  = refl
schemeOf-schemeChars https = refl
schemeOf-schemeChars ws    = refl
schemeOf-schemeChars wss   = refl
