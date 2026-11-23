{-# OPTIONS --safe #-}
-- HTML decisions cyrano makes about markup, as the browser makes them.
--
--   * scriptKind — what a <script> is (HTML "prepare the script element",
--     the type string; MIME Sniffing "JavaScript MIME type essence match"):
--     classic, module, an import map, speculation rules, or a data block
--     that never runs. Cyrano JS-rewrites classic and module scripts,
--     rewrites an import map as one, and leaves the rest as written.
--   * documentBase — the document base URL: the first <base> with an href,
--     parsed against the document's URL; the document's URL when there is
--     none, or it does not parse, or it is a data: or javascript: URL.
--
-- Checked against Chromium: html-vs-chromium.
-- Implemented by go/src/internal/htmlrewrite and ts/client/src/patches
-- (dynamic-html.ts rawText, html-rewriter.ts).
module Html where

open import Data.Bool.Base using (Bool; true; false; _∨_; not; if_then_else_)
open import Data.List.Base using (List; []; _∷_; _++_; map; reverse)
open import Data.Maybe.Base using (Maybe; just; nothing)
open import Data.String.Base using (toList)

open import Url

------------------------------------------------------------------------
-- What a script is.

data ScriptKind : Set where
  scriptClassic scriptModule scriptImportMap scriptSpeculation scriptData : ScriptKind

lowerAll : Str → Str
lowerAll []       = []
lowerAll (c ∷ cs) = lowerAscii c ∷ lowerAll cs

isAsciiWS : Str → Bool
isAsciiWS (c ∷ []) = is 9 c ∨ is 10 c ∨ is 12 c ∨ is 13 c ∨ is 32 c
isAsciiWS _ = false

stripWS : Str → Str
stripWS s = reverse (dropWhile ws (reverse (dropWhile ws s)))
  where
  ws : _ → Bool
  ws c = is 9 c ∨ is 10 c ∨ is 12 c ∨ is 13 c ∨ is 32 c

memberS : Str → List Str → Bool
memberS x []       = false
memberS x (y ∷ ys) = eqStr x y ∨ memberS x ys

-- MIME Sniffing §4.6: the JavaScript MIME type essence strings.
jsEssences : List Str
jsEssences = map toList
  ( "application/ecmascript" ∷ "application/javascript" ∷ "application/x-ecmascript"
  ∷ "application/x-javascript" ∷ "text/ecmascript" ∷ "text/javascript" ∷ "text/javascript1.0"
  ∷ "text/javascript1.1" ∷ "text/javascript1.2" ∷ "text/javascript1.3" ∷ "text/javascript1.4"
  ∷ "text/javascript1.5" ∷ "text/jscript" ∷ "text/livescript" ∷ "text/x-ecmascript"
  ∷ "text/x-javascript" ∷ [])

-- The script's kind from its type and language attributes (nothing:
-- absent). The JavaScript MIME type match is made on the type string with
-- ASCII whitespace stripped; module, importmap and speculationrules on the
-- string as written (case aside) — Chromium (html-vs-chromium): " module"
-- does not run.
--
-- When: the browser judges a script by its attributes as they are when it
-- is prepared — on insertion (or its text or src arriving while it is
-- connected) — and a script that was no JavaScript then is not "already
-- started": inserted again after its type changed, it runs. So a runtime
-- judges a script's text by this kind at insertion, not when the text was
-- set (consent managers write text under text/plain and flip the type;
-- ts patches/dynamic-iframe.ts fixScript, script-type-flip-vs-chromium).
scriptKind : Maybe Str → Maybe Str → ScriptKind
scriptKind (just []) _          = scriptClassic
scriptKind nothing   (just [])  = scriptClassic
scriptKind nothing   nothing    = scriptClassic
scriptKind (just t)  _          = byType t
  where
  byType : Str → ScriptKind
  byType s = if memberS (lowerAll (stripWS s)) jsEssences then scriptClassic
             else if eqStr (lowerAll s) (toList "module") then scriptModule
             else if eqStr (lowerAll s) (toList "importmap") then scriptImportMap
             else if eqStr (lowerAll s) (toList "speculationrules") then scriptSpeculation
             else scriptData
scriptKind nothing   (just l)   = byType (toList "text/" ++ l)
  where
  byType : Str → ScriptKind
  byType s = if memberS (lowerAll (stripWS s)) jsEssences then scriptClassic
             else scriptData

------------------------------------------------------------------------
-- The document base URL.

data BaseURL : Set where
  baseOf′    : Abs → BaseURL   -- a URL in the model
  aboutBlank : BaseURL         -- the first href does not parse (Chromium)
  beyond     : BaseURL         -- a URL of a scheme outside the model (ftp:, data:, …)

-- The <base href> values, in tree order; the document's URL. The first
-- href decides, parsed against the document's URL (Chromium: one that
-- does not parse makes the base about:blank — html-vs-chromium).
documentBase : Abs → List Str → BaseURL
documentBase doc []           = baseOf′ doc
documentBase doc (href ∷ _) with parse (just doc) (preprocess href)
... | url a       = baseOf′ a
... | invalid     = aboutBlank
... | otherScheme = beyond
... | outside     = beyond
