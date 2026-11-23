{-# OPTIONS --safe #-}
------------------------------------------------------------------------
-- Mixed content, as Chromium treats it (Mixed Content Level 2; owner
-- 2026-11-22). Through the proxy every request is same-origin https to the
-- browser, so its own checks never fire: an https page's http script ran
-- (a-hospital.com's share.js), its http fetch() answered, its http frame
-- loaded. The proxy judges each request as the browser would have, from
-- the original URLs (Go: proxy.MixedContent):
--
--   * the context — the requesting document's original URL (the proxied
--     Referer); none known, or one not https: nothing is judged;
--   * the target — an a priori authenticated URL (https, wss, a loopback
--     host: Referrer.trustworthy) is never mixed content;
--   * a navigation of the top-level document (Sec-Fetch-Dest document) is
--     not mixed content;
--   * an image, audio or video is upgraded: requested over https instead
--     (Chromium's autoupgrade of optionally-blockable content) — but an
--     image a srcset offered (an img's or a picture source's: the proxified
--     URL's `set` mark, Containment destImageSet) is blocked (measured: an
--     img src, in a picture or not, is upgraded; a srcset candidate is not);
--   * anything else is blocked: a network error, nothing sent.
-- Checked against Chromium through the real server (mixed-content-vs-
-- chromium). Known gap: a ws: WebSocket from an https page is not judged.
------------------------------------------------------------------------

module MixedContent where

open import Data.Bool.Base using (Bool; true; false; _∨_; _∧_; not; if_then_else_)
open import Data.List.Base using (List; map)
open import Data.Maybe.Base using (Maybe; just; nothing)
open import Data.String.Base using (String; toList)

open import Scheme
open import Url
open import Referrer using (trustworthy)

data Verdict : Set where
  allowed upgraded blocked : Verdict

verdictName : Verdict → Str
verdictName allowed  = toList "allow"
verdictName upgraded = toList "upgrade"
verdictName blocked  = toList "block"

isHttps : Scheme → Bool
isHttps https = true
isHttps wss   = true
isHttps _     = false

-- context: the requesting document's original URL; dest: Sec-Fetch-Dest
-- (nothing: none sent); imageSet: the request's URL is marked as a
-- srcset's image.
mixed : Maybe Abs → Abs → Maybe Str → Bool → Verdict
mixed nothing _ _ _ = allowed
mixed (just ctx) target dest imageSet =
  if not (isHttps (scheme ctx)) ∨ trustworthy target then allowed
  else byDest dest
  where
  is′ : Str → String → Bool
  is′ d s = eqStr (map lowerAscii d) (toList s)
  byDest : Maybe Str → Verdict
  byDest nothing  = allowed      -- not a browser request the proxy can judge
  byDest (just d) =
    if is′ d "document" then allowed
    else if is′ d "image" ∧ imageSet then blocked
    else if is′ d "image" ∨ is′ d "audio" ∨ is′ d "video" then upgraded
    else blocked
