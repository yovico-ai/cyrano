{-# OPTIONS --safe #-}
------------------------------------------------------------------------
-- Clear-Site-Data (round K: one site's sign-out cleared every proxied
-- site — the browser applied it to the proxy origin, which holds them all,
-- and dropped the session cookie, so the whole server-side jar).
--
-- As Chromium reads it (clear_site_data_handler.cc): the value split on
-- ",", each item trimmed of spaces and tabs, a type only when it is one
-- of the known quoted strings exactly ("cookies", "storage", "cache",
-- "executionContexts", "clientHints", "*"…); anything else is ignored;
-- the header counts only on a response from a potentially trustworthy
-- URL.
--
-- Under the proxy the browser is never given it (the page reads the
-- origin's value, Crn-H). "cookies" (or "*") is applied by the proxy to
-- its jar: the cookies of the response's registrable domain go, and the
-- requesting page is told as of any other change (CookieJar's inbox).
-- Known gap: "storage" (the runtime's per-site partitions), "cache" and
-- "executionContexts" are not applied.
------------------------------------------------------------------------

module ClearSiteData where

open import Data.Bool.Base using (Bool; true; false; _∨_; _∧_; if_then_else_)
open import Data.List.Base using (List; []; _∷_; reverse)
open import Data.String.Base using (toList)

open import Url using (Str; is; eqStr; splitOn)

trimSpTab : Str → Str
trimSpTab s = reverse (drop (reverse (drop s)))
  where
  drop : Str → Str
  drop []       = []
  drop (c ∷ cs) = if is 32 c ∨ is 9 c then drop cs else c ∷ cs

-- The types the value names, each as written between its quotes.
types : Str → List Str
types v = go (splitOn (is 44) v)
  where
  quoted : Str → Bool
  quoted ('"' ∷ r) with reverse r
  ... | '"' ∷ _ = true
  ... | _       = false
  quoted _ = false
  inner : Str → Str
  inner (_ ∷ r) with reverse r
  ... | _ ∷ x = reverse x
  ... | []    = []
  inner [] = []
  go : List Str → List Str
  go []       = []
  go (i ∷ is′) = let t = trimSpTab i in if quoted t then inner t ∷ go is′ else go is′

clearsCookies : Bool → Str → Bool
clearsCookies trustworthy v = trustworthy ∧ any (types v)
  where
  any : List Str → Bool
  any []       = false
  any (t ∷ ts) = eqStr t (toList "cookies") ∨ eqStr t (toList "*") ∨ any ts
