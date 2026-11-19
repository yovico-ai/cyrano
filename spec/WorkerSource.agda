{-# OPTIONS --safe #-}
-- Whether a worker built from a blob: or data: URL runs (HTML "fetch a
-- classic worker script", "fetch a single module script"; TS:
-- patches/blob-worker-source.ts, which gives such a worker the runtime and
-- the rewritten source — only where the native would run it).
--
-- A classic worker's script is MIME-checked only when it comes over
-- http(s): from a blob: or data: URL it runs whatever its type (a Blob
-- without one, text/plain, image/png). A module worker's must be a
-- JavaScript MIME type — the essence of the blob's type or the data: URL's
-- MIME type (up to ";", HTTP whitespace trimmed, ASCII-lowercased) one of
-- MIME Sniffing's JavaScript essences — or the worker fails (an error
-- event). Checked against Chromium (worker-source-vs-chromium; Worker and
-- SharedWorker alike).
module WorkerSource where

open import Data.Bool.Base using (Bool; true; false; _∨_; not)

open import Url using (Str)
open import Disposition using (essence; isJsType)

-- module: {type: "module"}; mime: the blob's type, or the data: URL's.
runs : Bool → Str → Bool
runs isModule mime = not isModule ∨ isJsType (essence mime)
