{-# OPTIONS --safe #-}
------------------------------------------------------------------------
-- javascript: URLs (HTML "evaluate a javascript: URL"; URL Standard).
--
-- A javascript: URL's code runs as a classic script of the target's global;
-- when its completion value is a string, that string becomes the browsing
-- context's new document, parsed as HTML. The rewriters left such URLs as
-- written, so the document a page made that way (`iframe.src =
-- "javascript:'<img src=…>'"`) loaded straight from the origin, its scripts
-- without the runtime. Now, wherever a URL attribute holds one (Attrs.agda
-- URL kinds; the client's setters, location and window.open too), its code
-- goes through the JS rules as global code with the jsUrl rule (cases.json:
-- the last top-level expression statement's value is handed to the runtime,
-- which makes a string a rewritten document with the bootstrap), and is
-- written back as a javascript: URL the browser reads as that code.
--
-- The code is what the URL parser leaves after "javascript:" (leading and
-- trailing C0 controls and spaces gone, every tab and newline removed),
-- serialized — characters outside ASCII UTF-8 percent-encoded — then
-- percent-decoded and read as UTF-8. Writing it back percent-encodes '%',
-- the C0 controls, space and DEL (which the parser would strip or trim),
-- nothing else; so the browser reads the rewritten code exactly.
------------------------------------------------------------------------

module JsUrl where

open import Data.Bool.Base using (Bool; true; false; _∨_; not; if_then_else_)
open import Data.Char.Base using (Char; toℕ)
open import Data.List.Base using (List; []; _∷_; _++_; filter; concatMap)
open import Data.Maybe.Base using (Maybe; just; nothing)
open import Data.Nat.Base using (ℕ; _<ᵇ_)
open import Data.String.Base using (toList)

open import Url using (Str; is; eqLower; eqStr; encodeWith; c0Set; isTabOrNewline; pctByte)
open import DataUrl using (trimC0; pctBytes)
open import Query using (utf8Decode)

-- What the URL parser reads: trimmed, tabs and newlines removed.
prep : Str → Str
prep s = removeTN (trimC0 s)
  where
  removeTN : Str → Str
  removeTN [] = []
  removeTN (c ∷ cs) = if isTabOrNewline c then removeTN cs else c ∷ removeTN cs

-- The code of a javascript: URL, or nothing for any other URL.
code : Str → Maybe Str
code s = after (prep s)
  where
  after : Str → Maybe Str
  after (a ∷ b ∷ c ∷ d ∷ e ∷ f ∷ g ∷ h ∷ i ∷ j ∷ k ∷ rest) =
    if eqLower (a ∷ b ∷ c ∷ d ∷ e ∷ f ∷ g ∷ h ∷ i ∷ j ∷ k ∷ []) (toList "javascript:")
    then just (utf8Decode (pctBytes (encodeWith c0Set rest))) else nothing
  after _ = nothing

-- The code written back: '%', C0 controls, space and DEL percent-encoded.
encode : Str → Str
encode = concatMap one
  where
  one : Char → Str
  one c = if is 37 c ∨ (toℕ c <ᵇ 33) ∨ is 127 c then pctByte (toℕ c) else c ∷ []

-- A javascript: URL whose code the rules (rw) change, written back; any
-- other URL, or code left as it is, as written.
rewriteUrl : (Str → Str) → Str → Str
rewriteUrl rw s with code s
... | nothing = s
... | just c  = if eqStr (rw c) c then s else toList "javascript:" ++ encode (rw c)
