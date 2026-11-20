{-# OPTIONS --safe #-}
-- HTML tokenization, as far as cyrano decides things by it (both runtimes:
-- the server rewrites a document over a token stream; the client finds
-- tags in markup a page writes before handing it to a <template>).
--
-- The tokenizer is HTML §13.2.5's, every state that decides where a token
-- starts and ends: data, tag open / end tag open / tag name, the attribute
-- states, self-closing, markup declarations (comments with their dash and
-- bang states, DOCTYPE, CDATA sections, bogus comments), RCDATA, RAWTEXT,
-- PLAINTEXT and script data with its escaped and double-escaped states.
-- Character references, NULs and parse errors change no boundary and are
-- left out; a CR counts as whitespace (input preprocessing makes CR LF one
-- LF). Names are ASCII-lowercased.
--
-- Which elements switch the tokenizer to raw text depends on the tree:
-- only an element in the HTML namespace does (<svg><style> is an SVG
-- element, its content markup), and a CDATA section is one only where
-- the next token is foreign content (not at an integration point). The namespace comes from a simplified tree
-- construction (the stack of open elements, §13.2.6.5 "in foreign
-- content"): svg and math open foreign content; SVG foreignObject, desc,
-- title and MathML annotation-xml (encoding text/html or
-- application/xhtml+xml) are HTML integration points, mi mo mn ms mtext
-- MathML text integration points; a breakout tag (b, div, p, … font with
-- color/face/size) in foreign content pops the foreign elements; end
-- tags pop as the tree builder's rules do (endT). Not modelled (the tree builder ignores the tag,
-- so it does not switch the tokenizer either): raw-text tags inside
-- <select> and after <frameset>.
--
-- Decisions made by it:
--
--   * bootstrapAt — where the runtime's bootstrap goes in a document:
--     right after the first <head> or <body> start tag, or right before
--     the first start tag of any other element (html aside), whichever
--     comes first; nowhere when the document has no start tag. Every
--     script element of the page comes after it, and so runs after it.
--     Server (htmlrewrite.Rewrite), srcdoc and a document written into an
--     empty frame (patches/html-rewriter.ts) alike.
--   * where the client edits markup a page writes (startSpans: each start
--     tag's attributes, their names' and values' spans).
--
-- Checked against Chromium (html-tok-vs-chromium): which start tags make
-- elements and in which namespace; that the bootstrap placed here runs
-- before every page script and leaves the document as direct.
module HtmlTok where

open import Data.Bool.Base using (Bool; true; false; _∨_; _∧_; not; if_then_else_)
open import Data.Char.Base using (Char)
open import Data.List.Base using (List; []; _∷_; _++_; map; reverse; concatMap)
open import Data.Maybe.Base using (Maybe; just; nothing)
open import Data.Nat.Base using (ℕ; zero; suc; _<ᵇ_)
open import Data.Product.Base using (_×_; _,_; proj₁; proj₂)
open import Data.String.Base using (String; toList)

open import Url using (Str; is; isAlpha; lowerAscii; eqStr)

------------------------------------------------------------------------
-- Tokens. Positions are offsets into the input (code points); a token
-- spans [from, to).

data Ns3 : Set where
  nsHtml nsSvg nsMath : Ns3

data Attr : Set where
  -- name (lowercase), the name's span, the value (as written, quotes off),
  -- the value's span as written (quotes on; empty, at the name's end, when
  -- there is none) — where an edit replaces it
  attr : Str → ℕ → ℕ → Str → ℕ → ℕ → Attr

data Kind : Set where
  kStart   : Str → List Attr → Bool → Ns3 → Kind   -- name, attributes, self-closing, namespace
  kEnd     : Str → Kind
  kComment kDoctype kCdata : Kind
  -- Markers at the end of the input, never in `tokens`: an unfinished
  -- tag, comment, doctype or CDATA section began at the token's start
  -- (kOpen); the input ended in a script or raw-text element (kOpenRaw).
  kOpen kOpenRaw : Kind

data Tok : Set where
  tok : Kind → ℕ → ℕ → Tok

IStr : Set
IStr = List (ℕ × Char)

index : Str → IStr
index = go 0
  where
  go : ℕ → Str → IStr
  go i []       = []
  go i (c ∷ cs) = (i , c) ∷ go (suc i) cs

len : Str → ℕ
len []       = 0
len (_ ∷ cs) = suc (len cs)

------------------------------------------------------------------------
-- The stack of open elements, as far as namespaces go.

data IP : Set where
  noIP htmlIP textIP : IP

data Entry : Set where
  ent  : Str → Ns3 → IP → Entry
  -- innerHTML's context element: never popped; the adjusted current node
  -- when nothing else is open
  root : Str → Ns3 → IP → Bool → Entry   -- Bool: CDATA sections may open

eTag : Entry → Str
eTag (ent t _ _)  = t
eTag (root t _ _ _) = t

eNs : Entry → Ns3
eNs (ent _ ns _)  = ns
eNs (root _ ns _ _) = ns

eIP : Entry → IP
eIP (ent _ _ ip)  = ip
eIP (root _ _ ip _) = ip

isRoot : Entry → Bool
isRoot (root _ _ _ _) = true
isRoot (ent _ _ _)  = false

Tracker : Set
Tracker = List Entry   -- the current node first

inS : Str → List String → Bool
inS x []       = false
inS x (y ∷ ys) = eqStr x (toList y) ∨ inS x ys

lowerS : Str → Str
lowerS = map lowerAscii

-- An attribute's value: the first of that name (the tokenizer drops later
-- duplicates).
attrValue : Str → List Attr → Maybe Str
attrValue n []                  = nothing
attrValue n (attr m _ _ v _ _ ∷ as) = if eqStr n m then just v else attrValue n as

hasAttr : Str → List Attr → Bool
hasAttr n as with attrValue n as
... | just _  = true
... | nothing = false

foreignNs : Ns3 → Bool
foreignNs nsHtml = false
foreignNs _      = true

isNoIP : IP → Bool
isNoIP noIP = true
isNoIP _    = false

breakout : Str → List Attr → Bool
breakout t as =
  inS t ("b" ∷ "big" ∷ "blockquote" ∷ "body" ∷ "br" ∷ "center" ∷ "code" ∷ "dd" ∷ "div" ∷ "dl"
        ∷ "dt" ∷ "em" ∷ "embed" ∷ "h1" ∷ "h2" ∷ "h3" ∷ "h4" ∷ "h5" ∷ "h6" ∷ "head" ∷ "hr" ∷ "i"
        ∷ "img" ∷ "li" ∷ "listing" ∷ "menu" ∷ "meta" ∷ "nobr" ∷ "ol" ∷ "p" ∷ "pre" ∷ "ruby" ∷ "s"
        ∷ "small" ∷ "span" ∷ "strong" ∷ "strike" ∷ "sub" ∷ "sup" ∷ "table" ∷ "tt" ∷ "u" ∷ "ul"
        ∷ "var" ∷ [])
  ∨ (eqStr t (toList "font") ∧ (hasAttr (toList "color") as ∨ hasAttr (toList "face") as ∨ hasAttr (toList "size") as))

-- Whether a start tag is processed by the rules for foreign content.
foreignFor : Tracker → Str → Bool
foreignFor []                 t = false
foreignFor (x ∷ _) t =
  foreignNs (eNs x) ∧ not (forThis (eIP x))
    ∧ not (eqStr (eTag x) (toList "annotation-xml") ∧ eqStr t (toList "svg"))
  where
  forThis : IP → Bool
  forThis htmlIP = true
  forThis textIP = not (inS t ("mglyph" ∷ "malignmark" ∷ []))
  forThis noIP   = false

popForeign : Tracker → Tracker
popForeign []                  = []
popForeign (x ∷ ts) =
  if not (isRoot x) ∧ foreignNs (eNs x) ∧ isNoIP (eIP x) then popForeign ts else x ∷ ts

htmlNsOf : Str → Ns3
htmlNsOf t =
  if eqStr t (toList "svg") then nsSvg
  else if eqStr t (toList "math") then nsMath
  else nsHtml

ipOf : Ns3 → Str → List Attr → IP
ipOf nsSvg  t as = if inS t ("foreignobject" ∷ "desc" ∷ "title" ∷ []) then htmlIP else noIP
ipOf nsMath t as =
  if inS t ("mi" ∷ "mo" ∷ "mn" ∷ "ms" ∷ "mtext" ∷ []) then textIP
  else if eqStr t (toList "annotation-xml") ∧ encodingHtml (attrValue (toList "encoding") as) then htmlIP
  else noIP
  where
  encodingHtml : Maybe Str → Bool
  encodingHtml (just v) = inS (lowerS v) ("text/html" ∷ "application/xhtml+xml" ∷ [])
  encodingHtml nothing  = false
ipOf nsHtml _ _ = noIP

voidEl : Str → Bool
voidEl t = inS t ("area" ∷ "base" ∷ "basefont" ∷ "bgsound" ∷ "br" ∷ "col" ∷ "embed" ∷ "frame" ∷ "hr"
                 ∷ "img" ∷ "input" ∷ "keygen" ∷ "link" ∷ "meta" ∷ "param" ∷ "source" ∷ "track" ∷ "wbr" ∷ [])

topNs : Tracker → Ns3
topNs []                = nsHtml
topNs (x ∷ _) = eNs x

-- End tags (§13.2.6.4.7 "in body", §13.2.6.5 foreign content), as far
-- as the stack goes. An HTML end tag pops to an open HTML element of its
-- name: one in scope for the block elements, list items, headings,
-- table parts (scope boundaries stop the search), the formatting elements
-- by a simplified adoption agency, any other through no special element
-- (§13.2.4.2 "special"); </p> pops a p in button scope; </body>, </html>
-- and </br> pop nothing. A foreign end tag pops to the nearest foreign
-- element of its name (names compared lowercase), or is an HTML end tag
-- once an HTML element is reached. The context root is never popped.

namedHtml : Str → Entry → Bool
namedHtml t x = not (isRoot x) ∧ not (foreignNs (eNs x)) ∧ eqStr (eTag x) t

ipNames : Ns3 → Str → Bool
ipNames nsSvg  t = inS t ("foreignobject" ∷ "desc" ∷ "title" ∷ [])
ipNames nsMath t = inS t ("mi" ∷ "mo" ∷ "mn" ∷ "ms" ∷ "mtext" ∷ "annotation-xml" ∷ [])
ipNames nsHtml _ = false

special : Entry → Bool
special x = isRoot x ∨ sp (eNs x) (eTag x)
  where
  sp : Ns3 → Str → Bool
  sp nsHtml t = inS t ("address" ∷ "applet" ∷ "area" ∷ "article" ∷ "aside" ∷ "base" ∷ "basefont" ∷ "bgsound"
    ∷ "blockquote" ∷ "body" ∷ "br" ∷ "button" ∷ "caption" ∷ "center" ∷ "col" ∷ "colgroup" ∷ "dd" ∷ "details"
    ∷ "dir" ∷ "div" ∷ "dl" ∷ "dt" ∷ "embed" ∷ "fieldset" ∷ "figcaption" ∷ "figure" ∷ "footer" ∷ "form"
    ∷ "frame" ∷ "frameset" ∷ "h1" ∷ "h2" ∷ "h3" ∷ "h4" ∷ "h5" ∷ "h6" ∷ "head" ∷ "header" ∷ "hgroup" ∷ "hr"
    ∷ "html" ∷ "iframe" ∷ "img" ∷ "input" ∷ "keygen" ∷ "li" ∷ "link" ∷ "listing" ∷ "main" ∷ "marquee"
    ∷ "menu" ∷ "meta" ∷ "nav" ∷ "noembed" ∷ "noframes" ∷ "noscript" ∷ "object" ∷ "ol" ∷ "p" ∷ "param"
    ∷ "plaintext" ∷ "pre" ∷ "script" ∷ "search" ∷ "section" ∷ "select" ∷ "source" ∷ "style" ∷ "summary"
    ∷ "table" ∷ "tbody" ∷ "td" ∷ "template" ∷ "textarea" ∷ "tfoot" ∷ "th" ∷ "thead" ∷ "title" ∷ "tr"
    ∷ "track" ∷ "ul" ∷ "wbr" ∷ "xmp" ∷ [])
  sp ns t = ipNames ns t

-- "Has an element in scope": the default scope's boundaries, and more.
scopeB : Entry → Bool
scopeB x = isRoot x ∨ b (eNs x) (eTag x)
  where
  b : Ns3 → Str → Bool
  b nsHtml t = inS t ("applet" ∷ "caption" ∷ "html" ∷ "table" ∷ "td" ∷ "th" ∷ "marquee" ∷ "object" ∷ "template" ∷ [])
  b ns t = ipNames ns t

listB buttonB tableB : Entry → Bool
listB x   = scopeB x ∨ namedHtml (toList "ol") x ∨ namedHtml (toList "ul") x
buttonB x = scopeB x ∨ namedHtml (toList "button") x
tableB x  = isRoot x ∨ namedHtml (toList "html") x ∨ namedHtml (toList "table") x ∨ namedHtml (toList "template") x

anyE : (Entry → Bool) → Tracker → Bool
anyE p []       = false
anyE p (x ∷ xs) = p x ∨ anyE p xs

filterE : (Entry → Bool) → Tracker → Tracker
filterE p []       = []
filterE p (x ∷ xs) = if p x then x ∷ filterE p xs else filterE p xs

-- Pop through the first entry m picks, unless a boundary b comes first
-- (unchanged then, and when there is none).
popUntil : (Entry → Bool) → (Entry → Bool) → Tracker → Tracker
popUntil m b ts = go ts
  where
  go : Tracker → Tracker
  go []         = ts
  go (x ∷ rest) = if isRoot x then ts else if m x then rest else if b x then ts else go rest

-- A start tag: its namespace, and the stack after it.
startT : Tracker → Str → List Attr → Bool → Ns3 × Tracker
startT ts t as self = place (decide (foreignFor ts t))
  where
  decide : Bool → Ns3 × Tracker
  decide true  = if breakout t as then (nsHtml , popForeign ts) else (topNs ts , ts)
  decide false = (htmlNsOf t , ts)

  -- In HTML, an <image> is an <img> (the tree builder renames it).
  el : Ns3 → Str
  el nsHtml = if eqStr t (toList "image") then toList "img" else t
  el _      = t

  pushed : Ns3 → Bool
  pushed nsHtml = not (voidEl (el nsHtml))
  pushed _      = not self

  -- §13.2.6.4.7 "in body": these start tags first close a p in button
  -- scope (table too, in no-quirks mode only: not modelled).
  closesP : Bool
  closesP = inS t ("address" ∷ "article" ∷ "aside" ∷ "blockquote" ∷ "center" ∷ "details" ∷ "dialog" ∷ "dir"
    ∷ "div" ∷ "dl" ∷ "fieldset" ∷ "figcaption" ∷ "figure" ∷ "footer" ∷ "header" ∷ "hgroup" ∷ "main" ∷ "menu"
    ∷ "nav" ∷ "ol" ∷ "p" ∷ "search" ∷ "section" ∷ "summary" ∷ "ul" ∷ "h1" ∷ "h2" ∷ "h3" ∷ "h4" ∷ "h5" ∷ "h6"
    ∷ "pre" ∷ "listing" ∷ "form" ∷ "plaintext" ∷ "hr" ∷ "xmp" ∷ [])

  before : Ns3 → Tracker → Tracker
  before nsHtml us = if closesP then popUntil (namedHtml (toList "p")) buttonB us else us
  before _      us = us

  place : Ns3 × Tracker → Ns3 × Tracker
  place (ns , us) = ns , (if pushed ns then ent (el ns) ns (ipOf ns t as) ∷ before ns us else before ns us)

data Split : Set where
  found : Tracker → Entry → Tracker → Split
  none  : Split

-- The entries before the first that p picks (the current node first), it, and the rest.
splitAt : (Entry → Bool) → Tracker → Split
splitAt p []       = none
splitAt p (x ∷ xs) = if isRoot x then none else if p x then found [] x xs else cons (splitAt p xs)
  where
  cons : Split → Split
  cons (found a y b) = found (x ∷ a) y b
  cons none          = none

formatting : Str → Bool
formatting t = inS t ("a" ∷ "b" ∷ "big" ∷ "code" ∷ "em" ∷ "font" ∷ "i" ∷ "nobr" ∷ "s" ∷ "small" ∷ "strike"
                      ∷ "strong" ∷ "tt" ∷ "u" ∷ [])

anyOtherEnd : Str → Tracker → Tracker
anyOtherEnd t ts = popUntil (namedHtml t) special ts

-- The adoption agency, as far as the stack goes (at most 8 rounds): the
-- formatting element F (the latest open one of the name, in scope); with
-- no special element above it, pop through it; else, with FB the special
-- element nearest above it, the elements between lose all but the
-- formatting ones, F leaves, and its clone goes right above FB — again.
adoption : ℕ → Str → Tracker → Tracker
adoption zero    t ts = ts
adoption (suc k) t ts = round (splitAt (namedHtml t) ts)
  where
  fmt : Entry → Bool
  fmt x = not (foreignNs (eNs x)) ∧ formatting (eTag x)
  round : Split → Tracker
  round none          = anyOtherEnd t ts
  round (found A F B) = if anyE scopeB A then ts else furthest (splitAt special (reverse A))
    where
    furthest : Split → Tracker
    furthest none              = B
    furthest (found r2 fb r1) = adoption k t (reverse r1 ++ (F ∷ fb ∷ filterE fmt (reverse r2) ++ B))

headings : List String
headings = "h1" ∷ "h2" ∷ "h3" ∷ "h4" ∷ "h5" ∷ "h6" ∷ []

htmlEnd : Str → Tracker → Tracker
htmlEnd t ts =
  if inS t ("body" ∷ "html" ∷ "br" ∷ []) then ts
  else if eqStr t (toList "p") then popUntil (namedHtml t) buttonB ts
  else if eqStr t (toList "li") then popUntil (namedHtml t) listB ts
  else if inS t headings then popUntil (λ x → not (isRoot x) ∧ not (foreignNs (eNs x)) ∧ inS (eTag x) headings) scopeB ts
  else if inS t ("address" ∷ "article" ∷ "aside" ∷ "blockquote" ∷ "button" ∷ "center" ∷ "details" ∷ "dialog"
                 ∷ "dir" ∷ "div" ∷ "dl" ∷ "fieldset" ∷ "figcaption" ∷ "figure" ∷ "footer" ∷ "header" ∷ "hgroup"
                 ∷ "listing" ∷ "main" ∷ "menu" ∷ "nav" ∷ "ol" ∷ "pre" ∷ "search" ∷ "section" ∷ "summary" ∷ "ul"
                 ∷ "applet" ∷ "marquee" ∷ "object" ∷ "dd" ∷ "dt" ∷ "form" ∷ [])
       then popUntil (namedHtml t) scopeB ts
  else if inS t ("table" ∷ "tbody" ∷ "thead" ∷ "tfoot" ∷ "tr" ∷ "td" ∷ "th" ∷ "caption" ∷ "colgroup" ∷ "template" ∷ "select" ∷ [])
       then popUntil (namedHtml t) tableB ts
  else if formatting t then adoption 8 t ts
  else anyOtherEnd t ts

-- Foreign content: to the nearest foreign element of the name, until an
-- HTML element (or the context root) is reached.
foreignEnd : Str → Tracker → Tracker
foreignEnd t ts = go ts
  where
  go : Tracker → Tracker
  go []         = htmlEnd t ts
  go (x ∷ rest) =
    if isRoot x ∨ not (foreignNs (eNs x)) then htmlEnd t ts
    else if eqStr (eTag x) t then rest
    else go rest

endT : Tracker → Str → Tracker
endT [] t = htmlEnd t []
endT (x ∷ xs) t =
  if foreignNs (eNs x) then
    (if inS t ("p" ∷ "br" ∷ []) then htmlEnd t (popForeign (x ∷ xs)) else foreignEnd t (x ∷ xs))
  else htmlEnd t (x ∷ xs)

cdataAllowed : Tracker → Bool
cdataAllowed []                = false
-- (Chromium: the adjusted current node is foreign and no integration
-- point — the next token is processed as foreign content.)
cdataAllowed (root _ ns ip opened ∷ _) = opened ∧ foreignNs ns ∧ isNoIP ip
cdataAllowed (ent _ ns ip ∷ _)        = foreignNs ns ∧ isNoIP ip

-- A token was processed (a character, a tag, a comment…): from now on the
-- context element makes <![CDATA[ a CDATA section (Chromium updates that
-- after each token; none before the first).
settle : Tracker → Tracker
settle []                    = []
settle (root t ns ip _ ∷ ts) = root t ns ip true ∷ ts
settle (x ∷ ts)              = x ∷ settle ts

------------------------------------------------------------------------
-- The tokenizer. `sc`: the scripting flag (noscript is raw text when
-- it is set); `n`: the input's length (where EOF is).

W : Char → Bool
W c = is 9 c ∨ is 10 c ∨ is 12 c ∨ is 13 c ∨ is 32 c

lt gt sl bang dash eqc dq sq rb : Char → Bool
lt   = is 60
gt   = is 62
sl   = is 47
bang = is 33
dash = is 45
eqc  = is 61
dq   = is 34
sq   = is 39
rb   = is 93

-- The latest attribute's value and its span [vf, vt).
setV : Str → ℕ → ℕ → List Attr → List Attr
setV v vf vt (attr m f t _ _ _ ∷ as) = attr m f t v vf vt ∷ as
setV v vf vt []                      = []

eqLit : Str → String → Bool
eqLit s l = eqStr s (toList l)

rawName : Bool → Str → Bool
rawName sc t = inS t ("title" ∷ "textarea" ∷ "style" ∷ "xmp" ∷ "iframe" ∷ "noembed" ∷ "noframes" ∷ [])
             ∨ (sc ∧ eqLit t "noscript")

ci7 : List (ℕ × Char) → String → Bool
ci7 cs l = eqStr (lowerS (map proj₂ cs)) (toList l)

ex7 : List (ℕ × Char) → String → Bool
ex7 cs l = eqStr (map proj₂ cs) (toList l)

module Run (sc : Bool) (n : ℕ) where
  mutual
    dataS : Tracker → IStr → List Tok
    dataS ts []            = []
    dataS ts ((i , c) ∷ I) = if lt c then tagOpen ts i I else dataS (settle ts) I

    tagOpen : Tracker → ℕ → IStr → List Tok
    tagOpen ts p []            = tok kOpen p n ∷ []
    tagOpen ts p ((i , c) ∷ I) =
      if bang c then markup ts p I
      else if sl c then endOpen ts p I
      else if isAlpha c then tagName ts p false (lowerAscii c ∷ []) I
      else if is 63 c then bogus ts p I
      else dataS (settle ts) ((i , c) ∷ I)

    endOpen : Tracker → ℕ → IStr → List Tok
    endOpen ts p []            = tok kOpen p n ∷ []
    endOpen ts p ((i , c) ∷ I) =
      if isAlpha c then tagName ts p true (lowerAscii c ∷ []) I
      else if gt c then dataS (settle ts) I
      else bogus ts p ((i , c) ∷ I)

    -- k: an end tag; nm: the name so far, reversed
    tagName : Tracker → ℕ → Bool → Str → IStr → List Tok
    tagName ts p k nm []            = tok kOpen p n ∷ []
    tagName ts p k nm ((i , c) ∷ I) =
      if W c then beforeAttr ts p k (reverse nm) [] I
      else if sl c then selfClose ts p k (reverse nm) [] I
      else if gt c then emit ts p (suc i) k (reverse nm) [] false I
      else tagName ts p k (lowerAscii c ∷ nm) I

    -- as: the attributes so far, the latest first
    beforeAttr : Tracker → ℕ → Bool → Str → List Attr → IStr → List Tok
    beforeAttr ts p k nm as []            = tok kOpen p n ∷ []
    beforeAttr ts p k nm as ((i , c) ∷ I) =
      if W c then beforeAttr ts p k nm as I
      else if sl c ∨ gt c then afterAttr ts p k nm as ((i , c) ∷ I)
      else attrName ts p k nm as i (lowerAscii c ∷ []) I

    attrName : Tracker → ℕ → Bool → Str → List Attr → ℕ → Str → IStr → List Tok
    attrName ts p k nm as f an []            = tok kOpen p n ∷ []
    attrName ts p k nm as f an ((i , c) ∷ I) =
      if W c ∨ sl c ∨ gt c then afterAttr ts p k nm (attr (reverse an) f i [] i i ∷ as) ((i , c) ∷ I)
      else if eqc c then beforeValue ts p k nm (attr (reverse an) f i [] i i ∷ as) I
      else attrName ts p k nm as f (lowerAscii c ∷ an) I

    afterAttr : Tracker → ℕ → Bool → Str → List Attr → IStr → List Tok
    afterAttr ts p k nm as []            = tok kOpen p n ∷ []
    afterAttr ts p k nm as ((i , c) ∷ I) =
      if W c then afterAttr ts p k nm as I
      else if sl c then selfClose ts p k nm as I
      else if eqc c then beforeValue ts p k nm as I
      else if gt c then emit ts p (suc i) k nm as false I
      else attrName ts p k nm as i (lowerAscii c ∷ []) I

    beforeValue : Tracker → ℕ → Bool → Str → List Attr → IStr → List Tok
    beforeValue ts p k nm as []            = tok kOpen p n ∷ []
    beforeValue ts p k nm as ((i , c) ∷ I) =
      if W c then beforeValue ts p k nm as I
      else if dq c then valueQ ts p k nm as 34 i [] I
      else if sq c then valueQ ts p k nm as 39 i [] I
      else if gt c then emit ts p (suc i) k nm as false I
      else valueU ts p k nm as i (c ∷ []) I

    -- q: the quote; vf: where the value began (its opening quote)
    valueQ : Tracker → ℕ → Bool → Str → List Attr → ℕ → ℕ → Str → IStr → List Tok
    valueQ ts p k nm as q vf v []            = tok kOpen p n ∷ []
    valueQ ts p k nm as q vf v ((i , c) ∷ I) =
      if is q c then afterValueQ ts p k nm (setV (reverse v) vf (suc i) as) I
      else valueQ ts p k nm as q vf (c ∷ v) I

    valueU : Tracker → ℕ → Bool → Str → List Attr → ℕ → Str → IStr → List Tok
    valueU ts p k nm as vf v []            = tok kOpen p n ∷ []
    valueU ts p k nm as vf v ((i , c) ∷ I) =
      if W c then beforeAttr ts p k nm (setV (reverse v) vf i as) I
      else if gt c then emit ts p (suc i) k nm (setV (reverse v) vf i as) false I
      else valueU ts p k nm as vf (c ∷ v) I

    afterValueQ : Tracker → ℕ → Bool → Str → List Attr → IStr → List Tok
    afterValueQ ts p k nm as []            = tok kOpen p n ∷ []
    afterValueQ ts p k nm as ((i , c) ∷ I) =
      if W c then beforeAttr ts p k nm as I
      else if sl c then selfClose ts p k nm as I
      else if gt c then emit ts p (suc i) k nm as false I
      else beforeAttr ts p k nm as ((i , c) ∷ I)

    selfClose : Tracker → ℕ → Bool → Str → List Attr → IStr → List Tok
    selfClose ts p k nm as []            = tok kOpen p n ∷ []
    selfClose ts p k nm as ((i , c) ∷ I) =
      if gt c then emit ts p (suc i) k nm as true I
      else beforeAttr ts p k nm as ((i , c) ∷ I)

    emit : Tracker → ℕ → ℕ → Bool → Str → List Attr → Bool → IStr → List Tok
    emit ts p q true  nm as self I = tok (kEnd nm) p q ∷ dataS (settle (endT ts nm)) I
    emit ts p q false nm as self I = emitS p q nm (reverse as) self (startT (settle ts) nm (reverse as) self) I

    emitS : ℕ → ℕ → Str → List Attr → Bool → Ns3 × Tracker → IStr → List Tok
    emitS p q nm as self (ns , ts) I = tok (kStart nm as self ns) p q ∷ after ns nm ts I

    -- What follows a start tag: raw text for some HTML elements.
    after : Ns3 → Str → Tracker → IStr → List Tok
    after nsHtml nm ts I =
      if eqLit nm "script" then scr ts I
      else if eqLit nm "plaintext" then []
      else if rawName sc nm then raw ts nm I
      else dataS ts I
    after _ nm ts I = dataS ts I

    -- Markup declarations.
    markup : Tracker → ℕ → IStr → List Tok
    markup ts p (x ∷ y ∷ I) =
      if dash (proj₂ x) ∧ dash (proj₂ y) then cStart ts p I else markup7 ts p (x ∷ y ∷ I)
    markup ts p I = bogus ts p I

    markup7 : Tracker → ℕ → IStr → List Tok
    markup7 ts p (a ∷ b ∷ c ∷ d ∷ e ∷ f ∷ g ∷ I) =
      if ci7 (a ∷ b ∷ c ∷ d ∷ e ∷ f ∷ g ∷ []) "doctype" then doctype ts p I
      else if cdataAllowed ts ∧ ex7 (a ∷ b ∷ c ∷ d ∷ e ∷ f ∷ g ∷ []) "[CDATA[" then cdata ts p I
      else bogus ts p (a ∷ b ∷ c ∷ d ∷ e ∷ f ∷ g ∷ I)
    markup7 ts p I = bogus ts p I

    doctype : Tracker → ℕ → IStr → List Tok
    doctype ts p []            = tok kDoctype p n ∷ tok kOpen p n ∷ []
    doctype ts p ((i , c) ∷ I) = if gt c then tok kDoctype p (suc i) ∷ dataS (settle ts) I else doctype ts p I

    bogus : Tracker → ℕ → IStr → List Tok
    bogus ts p []            = tok kComment p n ∷ tok kOpen p n ∷ []
    bogus ts p ((i , c) ∷ I) = if gt c then tok kComment p (suc i) ∷ dataS (settle ts) I else bogus ts p I

    cStart : Tracker → ℕ → IStr → List Tok
    cStart ts p []            = tok kComment p n ∷ tok kOpen p n ∷ []
    cStart ts p ((i , c) ∷ I) =
      if dash c then cStartDash ts p I
      else if gt c then tok kComment p (suc i) ∷ dataS (settle ts) I
      else cBody ts p ((i , c) ∷ I)

    cStartDash : Tracker → ℕ → IStr → List Tok
    cStartDash ts p []            = tok kComment p n ∷ tok kOpen p n ∷ []
    cStartDash ts p ((i , c) ∷ I) =
      if dash c then cEnd ts p I
      else if gt c then tok kComment p (suc i) ∷ dataS (settle ts) I
      else cBody ts p ((i , c) ∷ I)

    cBody : Tracker → ℕ → IStr → List Tok
    cBody ts p []            = tok kComment p n ∷ tok kOpen p n ∷ []
    cBody ts p ((i , c) ∷ I) = if dash c then cEndDash ts p I else cBody ts p I

    cEndDash : Tracker → ℕ → IStr → List Tok
    cEndDash ts p []            = tok kComment p n ∷ tok kOpen p n ∷ []
    cEndDash ts p ((i , c) ∷ I) = if dash c then cEnd ts p I else cBody ts p ((i , c) ∷ I)

    cEnd : Tracker → ℕ → IStr → List Tok
    cEnd ts p []            = tok kComment p n ∷ tok kOpen p n ∷ []
    cEnd ts p ((i , c) ∷ I) =
      if gt c then tok kComment p (suc i) ∷ dataS (settle ts) I
      else if bang c then cEndBang ts p I
      else if dash c then cEnd ts p I
      else cBody ts p ((i , c) ∷ I)

    cEndBang : Tracker → ℕ → IStr → List Tok
    cEndBang ts p []            = tok kComment p n ∷ tok kOpen p n ∷ []
    cEndBang ts p ((i , c) ∷ I) =
      if dash c then cEndDash ts p I
      else if gt c then tok kComment p (suc i) ∷ dataS (settle ts) I
      else cBody ts p ((i , c) ∷ I)

    cdata : Tracker → ℕ → IStr → List Tok
    cdata ts p []            = tok kCdata p n ∷ tok kOpen p n ∷ []
    cdata ts p ((i , c) ∷ I) = if rb c then cdataB ts p I else cdata ts p I

    cdataB : Tracker → ℕ → IStr → List Tok
    cdataB ts p []            = tok kCdata p n ∷ tok kOpen p n ∷ []
    cdataB ts p ((i , c) ∷ I) = if rb c then cdataBB ts p I else cdata ts p ((i , c) ∷ I)

    cdataBB : Tracker → ℕ → IStr → List Tok
    cdataBB ts p []            = tok kCdata p n ∷ tok kOpen p n ∷ []
    cdataBB ts p ((i , c) ∷ I) =
      if rb c then cdataBB ts p I
      else if gt c then tok kCdata p (suc i) ∷ dataS (settle ts) I
      else cdata ts p ((i , c) ∷ I)

    -- RCDATA / RAWTEXT, ended by an appropriate end tag (nm).
    raw : Tracker → Str → IStr → List Tok
    raw ts nm []            = tok kOpenRaw n n ∷ []
    raw ts nm ((i , c) ∷ I) = if lt c then rawLt ts nm i I else raw ts nm I

    rawLt : Tracker → Str → ℕ → IStr → List Tok
    rawLt ts nm p []            = tok kOpenRaw n n ∷ []
    rawLt ts nm p ((i , c) ∷ I) = if sl c then rawEndOpen ts nm p I else raw ts nm ((i , c) ∷ I)

    rawEndOpen : Tracker → Str → ℕ → IStr → List Tok
    rawEndOpen ts nm p []            = tok kOpenRaw n n ∷ []
    rawEndOpen ts nm p ((i , c) ∷ I) =
      if isAlpha c then rawEndName ts nm p (lowerAscii c ∷ []) I else raw ts nm ((i , c) ∷ I)

    rawEndName : Tracker → Str → ℕ → Str → IStr → List Tok
    rawEndName ts nm p buf []            = tok kOpenRaw n n ∷ []
    rawEndName ts nm p buf ((i , c) ∷ I) =
      if isAlpha c then rawEndName ts nm p (lowerAscii c ∷ buf) I
      else if eqStr (reverse buf) nm ∧ W c then beforeAttr ts p true nm [] I
      else if eqStr (reverse buf) nm ∧ sl c then selfClose ts p true nm [] I
      else if eqStr (reverse buf) nm ∧ gt c then emit ts p (suc i) true nm [] false I
      else raw ts nm ((i , c) ∷ I)

    -- Script data, and its escaped and double-escaped states.
    scr : Tracker → IStr → List Tok
    scr ts []            = tok kOpenRaw n n ∷ []
    scr ts ((i , c) ∷ I) = if lt c then scrLt ts i I else scr ts I

    scrLt : Tracker → ℕ → IStr → List Tok
    scrLt ts p []            = tok kOpenRaw n n ∷ []
    scrLt ts p ((i , c) ∷ I) =
      if sl c then scrEndOpen ts p I
      else if bang c then escStart ts I
      else scr ts ((i , c) ∷ I)

    scrEndOpen : Tracker → ℕ → IStr → List Tok
    scrEndOpen ts p []            = tok kOpenRaw n n ∷ []
    scrEndOpen ts p ((i , c) ∷ I) =
      if isAlpha c then scrEndName ts p (lowerAscii c ∷ []) I else scr ts ((i , c) ∷ I)

    scrEndName : Tracker → ℕ → Str → IStr → List Tok
    scrEndName ts p buf []            = tok kOpenRaw n n ∷ []
    scrEndName ts p buf ((i , c) ∷ I) =
      if isAlpha c then scrEndName ts p (lowerAscii c ∷ buf) I
      else if eqLit (reverse buf) "script" ∧ W c then beforeAttr ts p true (toList "script") [] I
      else if eqLit (reverse buf) "script" ∧ sl c then selfClose ts p true (toList "script") [] I
      else if eqLit (reverse buf) "script" ∧ gt c then emit ts p (suc i) true (toList "script") [] false I
      else scr ts ((i , c) ∷ I)

    escStart : Tracker → IStr → List Tok
    escStart ts []            = tok kOpenRaw n n ∷ []
    escStart ts ((i , c) ∷ I) = if dash c then escStartDash ts I else scr ts ((i , c) ∷ I)

    escStartDash : Tracker → IStr → List Tok
    escStartDash ts []            = tok kOpenRaw n n ∷ []
    escStartDash ts ((i , c) ∷ I) = if dash c then escDD ts I else scr ts ((i , c) ∷ I)

    esc : Tracker → IStr → List Tok
    esc ts []            = tok kOpenRaw n n ∷ []
    esc ts ((i , c) ∷ I) =
      if dash c then escD ts I else if lt c then escLt ts i I else esc ts I

    escD : Tracker → IStr → List Tok
    escD ts []            = tok kOpenRaw n n ∷ []
    escD ts ((i , c) ∷ I) =
      if dash c then escDD ts I else if lt c then escLt ts i I else esc ts I

    escDD : Tracker → IStr → List Tok
    escDD ts []            = tok kOpenRaw n n ∷ []
    escDD ts ((i , c) ∷ I) =
      if dash c then escDD ts I
      else if lt c then escLt ts i I
      else if gt c then scr ts I
      else esc ts I

    escLt : Tracker → ℕ → IStr → List Tok
    escLt ts p []            = tok kOpenRaw n n ∷ []
    escLt ts p ((i , c) ∷ I) =
      if sl c then escEndOpen ts p I
      else if isAlpha c then dblStart ts [] ((i , c) ∷ I)
      else esc ts ((i , c) ∷ I)

    escEndOpen : Tracker → ℕ → IStr → List Tok
    escEndOpen ts p []            = tok kOpenRaw n n ∷ []
    escEndOpen ts p ((i , c) ∷ I) =
      if isAlpha c then escEndName ts p (lowerAscii c ∷ []) I else esc ts ((i , c) ∷ I)

    escEndName : Tracker → ℕ → Str → IStr → List Tok
    escEndName ts p buf []            = tok kOpenRaw n n ∷ []
    escEndName ts p buf ((i , c) ∷ I) =
      if isAlpha c then escEndName ts p (lowerAscii c ∷ buf) I
      else if eqLit (reverse buf) "script" ∧ W c then beforeAttr ts p true (toList "script") [] I
      else if eqLit (reverse buf) "script" ∧ sl c then selfClose ts p true (toList "script") [] I
      else if eqLit (reverse buf) "script" ∧ gt c then emit ts p (suc i) true (toList "script") [] false I
      else esc ts ((i , c) ∷ I)

    dblStart : Tracker → Str → IStr → List Tok
    dblStart ts buf []            = tok kOpenRaw n n ∷ []
    dblStart ts buf ((i , c) ∷ I) =
      if W c ∨ sl c ∨ gt c then (if eqLit (reverse buf) "script" then dbl ts I else esc ts I)
      else if isAlpha c then dblStart ts (lowerAscii c ∷ buf) I
      else esc ts ((i , c) ∷ I)

    dbl : Tracker → IStr → List Tok
    dbl ts []            = tok kOpenRaw n n ∷ []
    dbl ts ((i , c) ∷ I) =
      if dash c then dblD ts I else if lt c then dblLt ts I else dbl ts I

    dblD : Tracker → IStr → List Tok
    dblD ts []            = tok kOpenRaw n n ∷ []
    dblD ts ((i , c) ∷ I) =
      if dash c then dblDD ts I else if lt c then dblLt ts I else dbl ts I

    dblDD : Tracker → IStr → List Tok
    dblDD ts []            = tok kOpenRaw n n ∷ []
    dblDD ts ((i , c) ∷ I) =
      if dash c then dblDD ts I
      else if lt c then dblLt ts I
      else if gt c then scr ts I
      else dbl ts I

    dblLt : Tracker → IStr → List Tok
    dblLt ts []            = tok kOpenRaw n n ∷ []
    dblLt ts ((i , c) ∷ I) = if sl c then dblEnd ts [] I else dbl ts ((i , c) ∷ I)

    dblEnd : Tracker → Str → IStr → List Tok
    dblEnd ts buf []            = tok kOpenRaw n n ∷ []
    dblEnd ts buf ((i , c) ∷ I) =
      if W c ∨ sl c ∨ gt c then (if eqLit (reverse buf) "script" then esc ts I else dbl ts I)
      else if isAlpha c then dblEnd ts (lowerAscii c ∷ buf) I
      else dbl ts ((i , c) ∷ I)

-- The tokens of a document (or of markup parsed in a <template>: no
-- element open, the tokenizer in its data state).
marker : Tok → Bool
marker (tok kOpen _ _)    = true
marker (tok kOpenRaw _ _) = true
marker _                  = false

unmarked : List Tok → List Tok
unmarked []       = []
unmarked (t ∷ ts) = if marker t then unmarked ts else t ∷ unmarked ts

tokens : Bool → Str → List Tok
tokens sc s = unmarked (Run.dataS sc (len s) [] (index s))

-- Where an unfinished construct at the end of the markup begins: a tag,
-- comment, doctype or CDATA section; or the start tag of the script or
-- raw-text element the markup ends in (an end tag of its begun counts
-- as inside it); nothing when it ends in text (plaintext included). A
-- document.write that ends so keeps that tail for the next write (TS:
-- wrappers/document-write.ts, html-tokens.ts tokenize's tail): the
-- browser's parser could not act on it before more input either.
tail : Bool → Str → Maybe ℕ
tail sc s = go nothing (Run.dataS sc (len s) [] (index s))
  where
  rawStart : Maybe Tok → Bool
  rawStart (just (tok (kStart nm _ _ nsHtml) _ _)) = eqLit nm "script" ∨ rawName sc nm
  rawStart _ = false
  fromOf : Maybe Tok → Maybe ℕ
  fromOf (just (tok _ f _)) = just f
  fromOf nothing = nothing
  go : Maybe Tok → List Tok → Maybe ℕ
  go prev [] = nothing
  go prev (tok kOpen p _ ∷ _) = if rawStart prev then fromOf prev else just p
  go prev (tok kOpenRaw _ _ ∷ _) = fromOf prev
  go prev (t ∷ ts) = go (just t) ts

-- Markup parsed in an element (innerHTML's context; HTML "parsing HTML
-- fragments"), checked against Chromium (html-tok-vs-chromium):
--   * an HTML element whose content is raw text (script, style, title,
--     textarea, …, noscript with scripting on, plaintext): the tokenizer
--     starts there, and no end tag is appropriate (no start tag was
--     emitted) — the markup is all text, no token;
--   * otherwise the context element is the root of the stack: never
--     popped, the adjusted current node when nothing else is open. It
--     was made by no token, so annotation-xml is no HTML integration
--     point whatever its encoding (enc is not consulted), and it does not
--     make <![CDATA[ a CDATA section (Chromium: a bogus comment until a
--     foreign element of the markup's own is open).
tokensIn : Bool → Ns3 → Str → Maybe Str → Str → List Tok
tokensIn sc ns nm enc s = start ns
  where
  ts : Tracker
  ts = root nm ns (ipOf ns nm []) false ∷ []
  I : IStr
  I = index s
  start : Ns3 → List Tok
  start nsHtml =
    if eqLit nm "script" ∨ eqLit nm "plaintext" ∨ rawName sc nm then []
    else unmarked (Run.dataS sc (len s) ts I)
  start _ = unmarked (Run.dataS sc (len s) ts I)

------------------------------------------------------------------------
-- Editing the text at token positions: (from, to, replacement), in order
-- and not overlapping.

Edit : Set
Edit = ℕ × ℕ × Str

splice : List Edit → IStr → Str
splice [] I = map proj₂ I
splice ((a , b , r) ∷ es) [] = r ++ splice es []
splice ((a , b , r) ∷ es) ((i , c) ∷ I) =
  if i <ᵇ a then c ∷ splice ((a , b , r) ∷ es) I
  else r ++ splice es (skipTo b ((i , c) ∷ I))
  where
  skipTo : ℕ → IStr → IStr
  skipTo b [] = []
  skipTo b ((j , d) ∷ J) = if j <ᵇ b then skipTo b J else (j , d) ∷ J

------------------------------------------------------------------------
-- Where the bootstrap goes.

bootstrapAt : List Tok → Maybe ℕ
bootstrapAt [] = nothing
bootstrapAt (tok (kStart nm _ _ _) f t ∷ ts) =
  if inS nm ("head" ∷ "body" ∷ []) then just t
  else if eqLit nm "html" then bootstrapAt ts
  else just f
bootstrapAt (_ ∷ ts) = bootstrapAt ts

-- The document with the bootstrap in place (scripting on: a document).
withBootstrap : Str → Str → Str
withBootstrap boot s with bootstrapAt (tokens true s)
... | just k  = splice ((k , k , boot) ∷ []) (index s)
... | nothing = s

------------------------------------------------------------------------
-- The client edits markup a page writes where it stands, at these
-- tokens' spans (attribute values: Attr's value span; inline script and
-- style text: between the start tag and its end tag), as the server does
-- a document — nothing is parsed and serialized again, so the parser that
-- gets it builds the page's own tree (a noscript's content, text with
-- scripting on, stays as written).

showN : ℕ → Str
showN = Url.showN

------------------------------------------------------------------------
-- For the checks: each start tag as "name ns id" (id: its data-i
-- attribute, or "-").

nsName : Ns3 → Str
nsName nsHtml = toList "html"
nsName nsSvg  = toList "svg"
nsName nsMath = toList "math"

startTagsOf : List Tok → List Str
startTagsOf ts₀ = go ts₀
  where
  idOf : List Attr → Str
  idOf as with attrValue (toList "data-i") as
  ... | just v  = v
  ... | nothing = toList "-"
  go : List Tok → List Str
  go [] = []
  go (tok (kStart nm as _ ns) _ _ ∷ ts) = (nm ++ toList " " ++ nsName ns ++ toList " " ++ idOf as) ∷ go ts
  go (_ ∷ ts) = go ts

startTags : Bool → Str → List Str
startTags sc s = startTagsOf (tokens sc s)

-- Each start tag's spans, "name from to" and per attribute
-- " name nameFrom nameTo valueFrom valueTo".
startSpans : Str → List Str
startSpans s = go (tokens true s)
  where
  sp : Str
  sp = toList " "
  attrsOf : List Attr → Str
  attrsOf [] = []
  attrsOf (attr m f t _ vf vt ∷ as) =
    sp ++ m ++ sp ++ showN f ++ sp ++ showN t ++ sp ++ showN vf ++ sp ++ showN vt ++ attrsOf as
  go : List Tok → List Str
  go [] = []
  go (tok (kStart nm as _ _) f t ∷ ts) = (nm ++ sp ++ showN f ++ sp ++ showN t ++ attrsOf as) ∷ go ts
  go (_ ∷ ts) = go ts
