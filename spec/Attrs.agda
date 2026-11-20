{-# OPTIONS --safe #-}
-- Which attributes of which elements hold URLs, and how cyrano treats
-- each (both runtimes: the server for markup, the client for setAttribute,
-- IDL setters and getters, innerHTML).
--
--   oneUrl     the value is a URL the browser fetches or navigates to:
--              proxified.
--   urlList    a set of space-separated URLs, each fetched (a/area ping,
--              attributionsrc): each token proxified, the whitespace as
--              written (rewriteUrlList).
--   srcsetList a srcset (spec/Srcset.agda).
--   cssValue   an SVG presentation attribute that takes a <url> (clip-path,
--              cursor, fill, filter, marker-start/-mid/-end, mask, stroke),
--              on any SVG element: its value is CSS, rewritten as a style
--              attribute is (spec/Css.agda rewriteCss). Google Charts
--              writes clip-path="url(<page URL>#id)": directly a reference
--              into the document itself; proxied an external document,
--              fetched outside the proxy and never applied
--              (definitions.net, 2026-11-20). (The style attribute itself
--              is rewritten the same way, outside this table.)
--   reflected  never fetched, but its IDL getter resolves it as a URL
--              (q.cite, img.longDesc, img.lowsrc, object.codeBase): kept as
--              written; the runtime's getter resolves it as the page's
--              base would (the native one resolves against the proxy's).
--   none       not a URL.
--
-- Elements by namespace and local name (lowercase; an SVG element's
-- feImage is "feimage"). In HTML, "image" is "img" (the parser renames it).
--
-- Besides the URLs (both runtimes, markup and setAttribute alike):
--   integrity    dropped (rewritten content cannot match a hash); the page
--                reads back what it wrote.
--   crossorigin  on an HTML element, use-credentials — a resource and its
--                preload keep one credentials mode (crossoriginValue) —
--                except a font preload or prefetch, kept as written to
--                match @font-face's anonymous fetch, and a fetch one, kept
--                to match the page's own fetch(), whose credentials mode
--                the runtime leaves (Spotify's locale JSON was fetched
--                twice).
--   sandbox      kept as written: a sandboxed frame is opaque through the
--                proxy as directly (allow-same-origin, once added, let the
--                parent read the frame's document, its messages come from
--                a real origin, its cookies work).
--
-- Checked against Chromium (attrs-vs-chromium): every pair Chromium
-- fetches from is oneUrl, urlList or srcsetList; every pair it does not is
-- none or reflected; every IDL property resolving a URL is on a pair that
-- is not none.
module Attrs where

open import Data.Bool.Base using (Bool; true; false; _∨_; if_then_else_)
open import Data.List.Base using (List; []; _∷_; _++_; map; reverse)
open import Data.Maybe.Base using (Maybe; just; nothing)
open import Data.String.Base using (String; toList)
open import Data.Char.Base using (Char)

open import Url

data Ns : Set where
  htmlNs svgNs : Ns

data AttrKind : Set where
  oneUrl urlList srcsetList cssValue reflected none : AttrKind

kindName : AttrKind → Str
kindName oneUrl     = toList "url"
kindName urlList    = toList "urllist"
kindName srcsetList = toList "srcset"
kindName cssValue   = toList "css"
kindName reflected  = toList "reflected"
kindName none       = toList "none"

inS : Str → List Str → Bool
inS x []       = false
inS x (y ∷ ys) = eqStr x y ∨ inS x ys

strs : List String → List Str
strs = map toList

htmlKind : Str → Str → AttrKind
htmlKind t a =
  if inS a (strs ("src" ∷ [])) ∧′ inS t (strs ("audio" ∷ "embed" ∷ "frame" ∷ "iframe" ∷ "img" ∷ "input" ∷ "script" ∷ "source" ∷ "track" ∷ "video" ∷ []))
  then oneUrl
  else if eqStr a (toList "href") ∧′ inS t (strs ("a" ∷ "area" ∷ "base" ∷ "link" ∷ []))
  then oneUrl
  else if eqStr a (toList "action") ∧′ eqStr t (toList "form") then oneUrl
  else if eqStr a (toList "formaction") ∧′ inS t (strs ("button" ∷ "input" ∷ [])) then oneUrl
  else if eqStr a (toList "data") ∧′ eqStr t (toList "object") then oneUrl
  else if eqStr a (toList "poster") ∧′ eqStr t (toList "video") then oneUrl
  else if eqStr a (toList "background") ∧′ inS t (strs ("body" ∷ "table" ∷ "tbody" ∷ "td" ∷ "tfoot" ∷ "th" ∷ "thead" ∷ "tr" ∷ []))
  then oneUrl
  else if eqStr a (toList "ping") ∧′ inS t (strs ("a" ∷ "area" ∷ [])) then urlList
  else if eqStr a (toList "attributionsrc") ∧′ inS t (strs ("a" ∷ "area" ∷ "img" ∷ "script" ∷ [])) then urlList
  else if eqStr a (toList "srcset") ∧′ inS t (strs ("img" ∷ "source" ∷ [])) then srcsetList
  else if eqStr a (toList "imagesrcset") ∧′ eqStr t (toList "link") then srcsetList
  else if eqStr a (toList "cite") ∧′ inS t (strs ("blockquote" ∷ "del" ∷ "ins" ∷ "q" ∷ [])) then reflected
  else if eqStr a (toList "longdesc") ∧′ inS t (strs ("frame" ∷ "iframe" ∷ "img" ∷ [])) then reflected
  else if eqStr a (toList "lowsrc") ∧′ eqStr t (toList "img") then reflected
  else if eqStr a (toList "codebase") ∧′ eqStr t (toList "object") then reflected
  else none
  where
  _∧′_ : Bool → Bool → Bool
  true  ∧′ b = b
  false ∧′ _ = false

svgKind : Str → Str → AttrKind
svgKind t a =
  if (eqStr a (toList "href") ∨ eqStr a (toList "xlink:href")) ∧′ inS t (strs ("a" ∷ "feimage" ∷ "image" ∷ "script" ∷ "use" ∷ []))
  then oneUrl
  else if inS a (strs ("clip-path" ∷ "cursor" ∷ "fill" ∷ "filter" ∷ "marker-start" ∷ "marker-mid" ∷ "marker-end" ∷ "mask" ∷ "stroke" ∷ []))
  then cssValue
  else none
  where
  _∧′_ : Bool → Bool → Bool
  true  ∧′ b = b
  false ∧′ _ = false

attrKind : Ns → Str → Str → AttrKind
attrKind htmlNs t a = htmlKind (if eqStr t (toList "image") then toList "img" else t) a
attrKind svgNs  t a = svgKind t a

------------------------------------------------------------------------
-- A URL list: tokens separated by ASCII whitespace (HTML "split a string
-- on ASCII whitespace"); each token rewritten, the separators kept.

isHtmlWS : Char → Bool
isHtmlWS c = is 9 c ∨ is 10 c ∨ is 12 c ∨ is 13 c ∨ is 32 c

rewriteUrlList : (Str → Maybe Str) → Str → Str
rewriteUrlList rw s = go s []
  where
  flush : Str → Str
  flush [] = []
  flush tok with rw tok
  ... | just u  = u
  ... | nothing = tok

  -- acc: the current token, reversed
  go : Str → Str → Str
  go [] acc = flush (reverse acc)
  go (c ∷ cs) acc =
    if isHtmlWS c then flush (reverse acc) ++ c ∷ go cs [] else go cs (c ∷ acc)

------------------------------------------------------------------------
-- What an attribute's URL is requested for, when it is a script or a
-- stylesheet (spec/Containment.agda Dest): the proxified URL is marked
-- so, and the proxy rewrites the response as such whatever its
-- Content-Type (spec/Disposition.agda).
--
--   <script src>, an SVG script's href / xlink:href          → script
--   <link href> whose rel has stylesheet                     → style
--   <link href> whose rel has modulepreload                  → script
--   <link href> whose rel has preload or prefetch, as=script → script
--                                                  as=style  → style
-- rel: the link types (ASCII-lowercased, as split); as: its as
-- (ASCII-lowercased; nothing: absent).

open import Containment using (Dest; destScript; destStyle)

hasRel : String → List Str → Bool
hasRel r []       = false
hasRel r (x ∷ xs) = eqStr x (toList r) ∨ hasRel r xs

urlDest : Ns → Str → Str → List Str → Maybe Str → Maybe Dest
urlDest svgNs t a _ _ =
  if eqStr t (toList "script") ∧′ (eqStr a (toList "href") ∨ eqStr a (toList "xlink:href")) then just destScript else nothing
  where
  _∧′_ : Bool → Bool → Bool
  true  ∧′ b = b
  false ∧′ _ = false
urlDest htmlNs t a rel as =
  if eqStr t (toList "script") ∧′ eqStr a (toList "src") then just destScript
  else if eqStr t (toList "link") ∧′ eqStr a (toList "href") then linkDest
  else nothing
  where
  _∧′_ : Bool → Bool → Bool
  true  ∧′ b = b
  false ∧′ _ = false
  asIs′ : Maybe Str → String → Bool
  asIs′ (just x) v = eqStr x (toList v)
  asIs′ nothing  v = false
  asIs : String → Bool
  asIs v = asIs′ as v
  linkDest : Maybe Dest
  linkDest =
    if hasRel "stylesheet" rel then just destStyle
    else if hasRel "modulepreload" rel then just destScript
    else if hasRel "preload" rel ∨ hasRel "prefetch" rel then
      (if asIs "script" then just destScript else if asIs "style" then just destStyle else nothing)
    else nothing

------------------------------------------------------------------------
-- crossorigin, as written by the runtimes (nothing: left as written).
-- html: an HTML element; rel, as: its attributes (ASCII case aside).

crossoriginValue : Bool → Str → Str → Str → Maybe Str
crossoriginValue html tag rel as =
  if not html then nothing
  else if eqStr tag (toList "link") ∧ (eqStr r (toList "preload") ∨ eqStr r (toList "prefetch")) ∧ (eqStr a (toList "font") ∨ eqStr a (toList "fetch")) then nothing
  else just (toList "use-credentials")
  where
  open import Data.Bool.Base using (not; _∧_)
  r a : Str
  r = map lowerAscii rel
  a = map lowerAscii as
