{-# OPTIONS --safe #-}
------------------------------------------------------------------------
-- An XML document the browser renders (owner 2026-11-22: "SVG is a
-- must"; pokemon-vortex.com embedded an SVG logo with <object>, and its
-- @font-face loaded from the origin): image/svg+xml, application/xhtml+xml,
-- text/xml, application/xml, */*+xml, loaded as a document (a navigation,
-- iframe, frame, object, embed: Disposition.agda asXml). Its elements in
-- the SVG and XHTML namespaces fetch and run as they do in HTML; it is
-- rewritten in place, every other character as the origin sent it (Go:
-- htmlrewrite/xml.go).
--
-- Reading (XML 1.0, as far as edits go): the prolog's XML declaration,
-- processing instructions, comments, a DOCTYPE (its internal subset's
-- brackets and quotes skipped); elements — start tags with attributes
-- (whitespace before each, "=", a value in " or ' holding no "<"), empty
-- tags "/>", end tags matching the open element; text; CDATA sections. A
-- document that does not read so — or whose prefixes are not bound, or
-- whose attribute values or style/script text use an entity other than
-- the predefined ones and character references — is given as sent (the
-- browser shows its XML error, or the spec does not decide).
--
-- Namespaces (Namespaces in XML): xmlns / xmlns:p bind in the element
-- and its descendants; an element's namespace is its prefix's (none: the
-- default); an attribute without a prefix has none.
--
-- Rewritten, for an element in the SVG or XHTML namespace, by its local
-- name ASCII-lowercased (a conservative superset: a mis-cased name is no
-- element Chromium fetches for):
--   * its attributes as in HTML (Attrs.attrKind), an attribute in the
--     XLink namespace named as the HTML parser names it, "xlink:href";
--     "style" as CSS declarations; values entity-decoded (attribute-value
--     normalization: a literal tab, CR or LF is a space), rewritten, and
--     written back with & < and the quote escaped, when they changed;
--   * the text and CDATA sections of a <style> (CSS) and a <script> (JS),
--     each run decoded, rewritten, written back (text: & < > escaped;
--     CDATA: as is, "]]>" split);
--   * an <?xml-stylesheet href="…"?> before the root: its href, a
--     stylesheet's URL.
--   * each element whose attributes changed gets their originals for
--     read-back, ` crn-o="{…}"` (JSON, jsonObject) before its start tag's
--     end, as the HTML rewriter's (the runtime takes it off);
-- The bootstrap (an SVG or XHTML <script> of the runtime) goes right
-- after the root's start tag when the root is in the SVG or XHTML
-- namespace and has content (bootstrapAt); a self-closing root runs
-- nothing.
------------------------------------------------------------------------

module XmlDoc where

open import Data.Bool.Base using (Bool; true; false; _∨_; _∧_; not; if_then_else_)
open import Data.Char.Base using (Char; toℕ; fromℕ)
open import Data.List.Base using (List; []; _∷_; _++_; reverse; map)
open import Data.Maybe.Base using (Maybe; just; nothing)
open import Data.Nat.Base using (ℕ; zero; suc; _+_; _*_; _∸_; _<ᵇ_; _≡ᵇ_)
open import Data.Product.Base using (_×_; _,_)
open import Data.String.Base using (String; toList)

open import Url using (Str; is; within; isDigit; isHex; hexVal; eqStr; lowerAscii)
open import Containment using (Dest)
import Attrs
open Attrs using (AttrKind; oneUrl; urlList; srcsetList; cssValue; reflected; handler; animUrls; none; htmlNs; svgNs)

------------------------------------------------------------------------
-- Characters

isWs : Char → Bool
isWs c = is 32 c ∨ is 9 c ∨ is 10 c ∨ is 13 c

nameChar : Char → Bool
nameChar c = not (isWs c ∨ is 47 c ∨ is 62 c ∨ is 61 c ∨ is 60 c ∨ is 34 c ∨ is 39 c ∨ is 63 c ∨ is 33 c ∨ is 38 c)

lowerS : Str → Str
lowerS = map lowerAscii

------------------------------------------------------------------------
-- Tokens. Positions are offsets into the input; a token spans [from, to).

data XAttr : Set where
  -- name as written, the value as written (quotes off), the quote, the
  -- value's span with its quotes
  xattr : Str → Str → Char → ℕ → ℕ → XAttr

data XKind : Set where
  xStart   : Str → List XAttr → Bool → XKind     -- name, attributes, empty tag
  xEnd     : Str → XKind
  xText xCdata xComment xDoctype : XKind
  xPi      : Str → Str → XKind                   -- target, data

data XTok : Set where
  xtok : XKind → ℕ → ℕ → XTok

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

-- Where the rest starts (the input's end when it is empty).
at : ℕ → IStr → ℕ
at e []            = e
at e ((i , _) ∷ _) = i

chars : IStr → Str
chars []             = []
chars ((_ , c) ∷ cs) = c ∷ chars cs

startsI : Str → IStr → Bool
startsI []       _              = true
startsI (p ∷ ps) []             = false
startsI (p ∷ ps) ((_ , c) ∷ cs) = (toℕ p ≡ᵇ toℕ c) ∧ startsI ps cs

dropI : ℕ → IStr → IStr
dropI zero    s        = s
dropI (suc n) []       = []
dropI (suc n) (_ ∷ cs) = dropI n cs

-- The rest after the first occurrence of `p`, and what precedes it.
after : Str → IStr → Maybe (IStr × IStr)
after p []       = nothing
after p (c ∷ cs) = if startsI p (c ∷ cs) then just ([] , dropI (len p) (c ∷ cs)) else more (after p cs)
  where
  more : Maybe (IStr × IStr) → Maybe (IStr × IStr)
  more nothing          = nothing
  more (just (b , r))   = just (c ∷ b , r)

spanWhile : (Char → Bool) → IStr → IStr × IStr
spanWhile f []             = [] , []
spanWhile f ((i , c) ∷ cs) with f c
... | false = [] , ((i , c) ∷ cs)
... | true  with spanWhile f cs
...   | (a , r) = ((i , c) ∷ a) , r

dropWs : IStr → IStr
dropWs s with spanWhile isWs s
... | (_ , r) = r

-- A DOCTYPE's end: the ">" outside quotes and the internal subset.
doctypeEnd : ℕ → Maybe Char → IStr → Maybe IStr
doctypeEnd depth q []             = nothing
doctypeEnd depth (just q) ((_ , c) ∷ cs) =
  if toℕ c ≡ᵇ toℕ q then doctypeEnd depth nothing cs else doctypeEnd depth (just q) cs
doctypeEnd depth nothing ((_ , c) ∷ cs) =
  if is 34 c ∨ is 39 c then doctypeEnd depth (just c) cs
  else if is 91 c then doctypeEnd (suc depth) nothing cs
  else if is 93 c then doctypeEnd (depth ∸ 1) nothing cs
  else if is 62 c ∧ (depth ≡ᵇ 0) then just cs
  else doctypeEnd depth nothing cs

-- An attribute value after its opening quote: the value and the rest
-- after the closing quote ("<" in it: not well-formed).
quoted : Char → IStr → Maybe (Str × IStr)
quoted q []             = nothing
quoted q ((_ , c) ∷ cs) =
  if toℕ c ≡ᵇ toℕ q then just ([] , cs)
  else if is 60 c then nothing
  else more (quoted q cs)
  where
  more : Maybe (Str × IStr) → Maybe (Str × IStr)
  more nothing         = nothing
  more (just (v , r))  = just (c ∷ v , r)

-- A start tag's attributes and end: the attributes, whether it is empty,
-- the rest after ">". Each attribute follows whitespace.
attrs : ℕ → ℕ → IStr → Maybe (List XAttr × Bool × IStr)
attrs zero    e s = nothing
attrs (suc f) e s with spanWhile isWs s
... | (ws , r) = next r
  where
  nonEmpty : IStr → Bool
  nonEmpty [] = false
  nonEmpty _  = true
  hadWs : Bool
  hadWs = nonEmpty ws
  value : Str → IStr → Maybe (List XAttr × Bool × IStr)
  value n r₁ with dropWs r₁
  ... | ((_ , eq) ∷ r₂) = if is 61 eq then val (dropWs r₂) else nothing
    where
    val : IStr → Maybe (List XAttr × Bool × IStr)
    val ((i , q) ∷ r₃) = if is 34 q ∨ is 39 q then rest (quoted q r₃) else nothing
      where
      rest : Maybe (Str × IStr) → Maybe (List XAttr × Bool × IStr)
      rest nothing        = nothing
      rest (just (v , r₄)) = cons (attrs f e r₄)
        where
        cons : Maybe (List XAttr × Bool × IStr) → Maybe (List XAttr × Bool × IStr)
        cons nothing                 = nothing
        cons (just (as , em , r₅))   = just (xattr n v q i (at e r₄) ∷ as , em , r₅)
    val [] = nothing
  ... | [] = nothing
  next : IStr → Maybe (List XAttr × Bool × IStr)
  next ((_ , c) ∷ r₁) =
    if is 62 c then just ([] , false , r₁)
    else if is 47 c then (if startsI ('>' ∷ []) r₁ then just ([] , true , dropI 1 r₁) else nothing)
    else if hadWs ∧ nameChar c then named (spanWhile nameChar ((0 , c) ∷ r₁))
    else nothing
    where
    named : IStr × IStr → Maybe (List XAttr × Bool × IStr)
    named (n , r₂) = value (chars n) r₂
  next [] = nothing

tokens : ℕ → ℕ → IStr → Maybe (List XTok)
tokens zero    e s = nothing
tokens (suc f) e [] = just []
tokens (suc f) e ((i , c) ∷ cs) =
  if is 60 c then markup else text (spanWhile (λ x → not (is 60 x)) ((i , c) ∷ cs))
  where
  cons : XTok → Maybe (List XTok) → Maybe (List XTok)
  cons t nothing   = nothing
  cons t (just ts) = just (t ∷ ts)
  text : IStr × IStr → Maybe (List XTok)
  text (_ , r) = cons (xtok xText i (at e r)) (tokens f e r)
  closeWith : XKind → Str → IStr → Maybe (List XTok)
  closeWith k p r with after p r
  ... | nothing      = nothing
  ... | just (_ , r′) = cons (xtok k i (at e r′)) (tokens f e r′)
  pi : IStr → Maybe (List XTok)
  pi r with spanWhile nameChar r
  ... | ([] , _)  = nothing
  ... | (t , r₁) with after ('?' ∷ '>' ∷ []) r₁
  ...   | nothing          = nothing
  ...   | just (d , r₂)    = cons (xtok (xPi (chars t) (chars d)) i (at e r₂)) (tokens f e r₂)
  endTag : IStr → Maybe (List XTok)
  endTag r with spanWhile nameChar r
  ... | ([] , _) = nothing
  ... | (n , r₁) with dropWs r₁
  ...   | ((_ , g) ∷ r₂) = if is 62 g then cons (xtok (xEnd (chars n)) i (at e r₂)) (tokens f e r₂) else nothing
  ...   | []             = nothing
  startTag : IStr → Maybe (List XTok)
  startTag r with spanWhile nameChar r
  ... | ([] , _) = nothing
  ... | (n , r₁) with attrs (suc (len (chars r₁))) e r₁
  ...   | nothing                = nothing
  ...   | just (as , em , r₂)    = cons (xtok (xStart (chars n) as em) i (at e r₂)) (tokens f e r₂)
  markup : Maybe (List XTok)
  markup =
    if startsI (toList "!--") cs then closeWith xComment (toList "-->") (dropI 3 cs)
    else if startsI (toList "![CDATA[") cs then closeWith xCdata (toList "]]>") (dropI 8 cs)
    else if startsI (toList "!DOCTYPE") cs then doctype (doctypeEnd 0 nothing (dropI 8 cs))
    else if startsI ('?' ∷ []) cs then pi (dropI 1 cs)
    else if startsI ('/' ∷ []) cs then endTag (dropI 1 cs)
    else startTag cs
    where
    doctype : Maybe IStr → Maybe (List XTok)
    doctype nothing  = nothing
    doctype (just r) = cons (xtok xDoctype i (at e r)) (tokens f e r)

tokenize : Str → Maybe (List XTok)
tokenize s = tokens (suc (len s)) (len s) (index s)

------------------------------------------------------------------------
-- Entities: the predefined ones and character references.

private
  digitsN : ℕ → Str → Maybe ℕ
  digitsN acc []       = just acc
  digitsN acc (c ∷ cs) = if isDigit c then digitsN (acc * 10 + (toℕ c ∸ 48)) cs else nothing
  hexN : ℕ → Str → Maybe ℕ
  hexN acc []       = just acc
  hexN acc (c ∷ cs) = if isHex c then hexN (acc * 16 + hexVal c) cs else nothing

-- A reference's text (between & and ;) as a character.
entity : Str → Maybe Char
entity n =
  if eqStr n (toList "lt") then just '<' else if eqStr n (toList "gt") then just '>'
  else if eqStr n (toList "amp") then just '&' else if eqStr n (toList "quot") then just '"'
  else if eqStr n (toList "apos") then just '\'' else num n
  where
  ok : Maybe ℕ → Maybe Char
  ok nothing  = nothing
  ok (just k) = if (0 <ᵇ k) ∧ (k <ᵇ 1114112) then just (fromℕ k) else nothing
  num : Str → Maybe Char
  num ('#' ∷ 'x' ∷ h ∷ hs) = ok (hexN 0 (h ∷ hs))
  num ('#' ∷ d ∷ ds)       = ok (digitsN 0 (d ∷ ds))
  num _                    = nothing

-- Decoded text; `a`: attribute-value normalization (a literal tab, CR
-- or LF is a space). (Fuel: the text's length is enough.)
decodeF : ℕ → Bool → Str → Maybe Str
decodeF zero    a _        = nothing
decodeF (suc f) a []       = just []
decodeF (suc f) a (c ∷ cs) = if is 38 c then ref (upTo cs) else more (if a ∧ (is 9 c ∨ is 10 c ∨ is 13 c) then ' ' else c) (decodeF f a cs)
  where
  more : Char → Maybe Str → Maybe Str
  more x nothing  = nothing
  more x (just r) = just (x ∷ r)
  upTo : Str → Maybe (Str × Str)
  upTo []       = nothing
  upTo (d ∷ ds) = if is 59 d then just ([] , ds) else ext (upTo ds)
    where
    ext : Maybe (Str × Str) → Maybe (Str × Str)
    ext nothing         = nothing
    ext (just (n , r))  = just (d ∷ n , r)
  ref : Maybe (Str × Str) → Maybe Str
  ref nothing         = nothing
  ref (just (n , r))  = char (entity n)
    where
    char : Maybe Char → Maybe Str
    char nothing  = nothing
    char (just x) = more x (decodeF f a r)

decode : Bool → Str → Maybe Str
decode a s = decodeF (suc (len s)) a s

encodeAttr : Char → Str → Str
encodeAttr q []       = []
encodeAttr q (c ∷ cs) =
  (if is 38 c then toList "&amp;" else if is 60 c then toList "&lt;"
   else if toℕ c ≡ᵇ toℕ q then (if is 34 c then toList "&quot;" else toList "&apos;")
   else c ∷ []) ++ encodeAttr q cs

encodeText : Str → Str
encodeText []       = []
encodeText (c ∷ cs) =
  (if is 38 c then toList "&amp;" else if is 60 c then toList "&lt;" else if is 62 c then toList "&gt;" else c ∷ []) ++ encodeText cs

-- CDATA content holding no "]]>": each one split across two sections.
cdataSafe : Str → Str
cdataSafe (']' ∷ ']' ∷ '>' ∷ r) = toList "]]]]><![CDATA[>" ++ cdataSafe r
cdataSafe (c ∷ r)               = c ∷ cdataSafe r
cdataSafe []                    = []

------------------------------------------------------------------------
-- Namespaces

svgUri xhtmlUri xlinkUri xmlUri : Str
svgUri   = toList "http://www.w3.org/2000/svg"
xhtmlUri = toList "http://www.w3.org/1999/xhtml"
xlinkUri = toList "http://www.w3.org/1999/xlink"
xmlUri   = toList "http://www.w3.org/XML/1998/namespace"

-- A qualified name's prefix and local part.
qname : Str → Maybe Str × Str
qname n = go [] n
  where
  go : Str → Str → Maybe Str × Str
  go acc []       = nothing , reverse acc
  go acc (c ∷ cs) = if is 58 c then just (reverse acc) , cs else go (c ∷ acc) cs

Scope : Set
Scope = List (Maybe Str × Str)   -- prefix (nothing: the default) ↦ URI

lookupP : Maybe Str → Scope → Maybe Str
lookupP p []              = nothing
lookupP p ((q , u) ∷ s)   = if same p q then just u else lookupP p s
  where
  same : Maybe Str → Maybe Str → Bool
  same nothing  nothing  = true
  same (just a) (just b) = eqStr a b
  same _        _        = false

-- The bindings a start tag makes (its xmlns attributes), decoded.
bindings : List XAttr → Maybe Scope
bindings []                          = just []
bindings (xattr n v _ _ _ ∷ as) with qname n | decode true v | bindings as
... | (nothing , l) | just u | just s = if eqStr l (toList "xmlns") then just ((nothing , u) ∷ s) else just s
... | (just p , l)  | just u | just s = if eqStr p (toList "xmlns") then just ((just l , u) ∷ s) else just s
... | _ | _ | _ = nothing

-- An element's namespace, or nothing when its prefix is unbound.
resolve : Scope → Str → Maybe (Maybe Str)
resolve s n with qname n
... | (nothing , _) = just (lookupP nothing s)
... | (just p , _)  = if eqStr p (toList "xml") then just (just xmlUri) else bound (lookupP (just p) s)
  where
  bound : Maybe Str → Maybe (Maybe Str)
  bound nothing  = nothing
  bound (just u) = just (just u)

data XNs : Set where
  xSvg xXhtml xOther : XNs

nsOf : Maybe Str → XNs
nsOf (just u) = if eqStr u svgUri then xSvg else if eqStr u xhtmlUri then xXhtml else xOther
nsOf nothing  = xOther

------------------------------------------------------------------------
-- The rewrite

-- What rewrites URLs, CSS and JS (the runtimes' rewriters; the oracle's
-- stand-ins in conformance).
record Rws : Set where
  field
    url     : Maybe Dest → Str → Str       -- one URL, as an attribute of that destination
    urls    : Str → Str                    -- a URL list (ping)
    srcset  : Str → Str
    cssVal  : Str → Str                    -- a property's value (SVG presentation attributes)
    cssDecl : Str → Str                    -- declarations (a style attribute)
    css     : Str → Str                    -- a style sheet
    js      : Str → Str                    -- a script's text, a handler's body
    sheet   : Str → Str                    -- a stylesheet's URL (xml-stylesheet)
open Rws

-- An edit: replace [from, to) with the text.
Edit : Set
Edit = ℕ × ℕ × Str

-- An attribute's new text (with its quotes), or nothing to leave it.
attrEdit : Rws → Attrs.Ns → Str → List XAttr → Scope → XAttr → Maybe (Maybe (Edit × Str × Str))
attrEdit rw ns tag as sc (xattr n v q from to) with qname n
... | (p , l) with decode true v
...   | nothing = nothing                                -- an entity outside the model
...   | just d  = just (change (key p l))
  where
  key : Maybe Str → Str → Str
  key nothing  l = l
  key (just p) l = if same (lookupP (just p) sc) then toList "xlink:href" ++ [] else p ++ ':' ∷ l
    where
    same : Maybe Str → Bool
    same (just u) = eqStr u xlinkUri ∧ eqStr l (toList "href")
    same nothing  = false
  relOf : List XAttr → Maybe Str
  relOf [] = nothing
  relOf (xattr m w _ _ _ ∷ r) = if eqStr m (toList "rel") then decode true w else relOf r
  -- (an enumerated attribute: ASCII case aside)
  asOf : List XAttr → Maybe Str
  asOf [] = nothing
  asOf (xattr m w _ _ _ ∷ r) = if eqStr m (toList "as") then lowered (decode true w) else asOf r
    where
    lowered : Maybe Str → Maybe Str
    lowered nothing  = nothing
    lowered (just x) = just (lowerS x)
  words : Maybe Str → List Str
  words nothing  = []
  words (just s) = Url.splitOn isWs (lowerS s)
  -- (an SVG animation's attributeName: the attribute it animates)
  animOf : List XAttr → Maybe Str
  animOf [] = nothing
  animOf (xattr m w _ _ _ ∷ r) = if eqStr m (toList "attributeName") then decode true w else animOf r
  now : Str → Str
  now k with Attrs.attrKindIn ns tag k (animOf as)
  ... | oneUrl     = url rw (Attrs.urlDest ns tag k (words (relOf as)) (asOf as)) d
  ... | animUrls   = Attrs.rewriteAnimUrls (λ u → just (url rw nothing u)) d
  ... | urlList    = urls rw d
  ... | srcsetList = srcset rw d
  ... | cssValue   = cssVal rw d
  ... | handler    = js rw d
  ... | reflected  = d
  ... | none       = if eqStr k (toList "style") then cssDecl rw d else d
  -- the edit, and the attribute's name and value as the page wrote them
  change : Str → Maybe (Edit × Str × Str)
  change k = if eqStr (now k) d then nothing else just ((from , to , q ∷ encodeAttr q (now k) ++ q ∷ []) , n , d)

-- JSON for the originals: strings with '"', '\\' and controls escaped
-- (\u00xx, lower-case hex), nothing else.
jsonStr : Str → Str
jsonStr s = '"' ∷ esc s
  where
  hexD : ℕ → Char
  hexD k = if k <ᵇ 10 then fromℕ (48 + k) else fromℕ (87 + k)
  esc : Str → Str
  esc []       = '"' ∷ []
  esc (c ∷ cs) =
    (if is 34 c then '\\' ∷ '"' ∷ [] else if is 92 c then '\\' ∷ '\\' ∷ []
     else if toℕ c <ᵇ 32 then '\\' ∷ 'u' ∷ '0' ∷ '0' ∷ hexD (toℕ c Data.Nat.Base./ 16) ∷ hexD (toℕ c Data.Nat.Base.% 16) ∷ []
     else c ∷ []) ++ esc cs
    where import Data.Nat.Base

jsonObject : List (Edit × Str × Str) → Str
jsonObject cs = '{' ∷ members cs
  where
  members : List (Edit × Str × Str) → Str
  members []                      = '}' ∷ []
  members ((_ , n , v) ∷ [])      = jsonStr n ++ ':' ∷ jsonStr v ++ '}' ∷ []
  members ((_ , n , v) ∷ r)       = jsonStr n ++ ':' ∷ jsonStr v ++ ',' ∷ members r

-- The xml-stylesheet instruction's href, rewritten (its pseudo-attribute
-- value as written, quoted).
piEdit : Rws → ℕ → Str → Str → Maybe Edit
piEdit rw from target d =
  if eqStr target (toList "xml-stylesheet") then find d 0 else nothing
  where
  -- The offset of the instruction's data: "<?" target, then its data.
  base : ℕ
  base = from + 2 + len target
  find : Str → ℕ → Maybe Edit
  find [] _ = nothing
  find ('h' ∷ 'r' ∷ 'e' ∷ 'f' ∷ '=' ∷ q ∷ r) k =
    if is 34 q ∨ is 39 q then val (split q r) else find r (k + 6)
    where
    split : Char → Str → Maybe (Str × ℕ)
    split q []       = nothing
    split q (c ∷ cs) = if toℕ c ≡ᵇ toℕ q then just ([] , 0) else ext (split q cs)
      where
      ext : Maybe (Str × ℕ) → Maybe (Str × ℕ)
      ext nothing        = nothing
      ext (just (v , n)) = just (c ∷ v , suc n)
    val : Maybe (Str × ℕ) → Maybe Edit
    val nothing        = nothing
    val (just (v , n)) with decode true v
    ... | nothing = nothing
    ... | just u  = if eqStr (sheet rw u) u then nothing
                    else just (base + k + 5 , base + k + 6 + n + 1 , q ∷ encodeAttr q (sheet rw u) ++ q ∷ [])
  find (c ∷ r) k = find r (suc k)

-- The open elements: name as written, namespace, scope, whether its text
-- is CSS (just false) or JS (just true).
Open : Set
Open = Str × XNs × Scope × Maybe Bool

-- Edits, and where the bootstrap goes (with the root's namespace), or
-- nothing: the document is given as sent.
record Plan : Set where
  constructor plan
  field
    edits : List Edit
    boot  : Maybe (ℕ × XNs)
open Plan

walk : Rws → Str → List Open → Bool → Maybe (ℕ × XNs) → List XTok → Maybe Plan
walk rw src stack rooted boot [] = if empty stack then just (plan [] boot) else nothing
  where
  empty : List Open → Bool
  empty [] = true
  empty _  = false
walk rw src stack rooted boot (xtok k from to ∷ ts) = step k
  where
  scOf : List Open → Scope
  scOf [] = []
  scOf ((_ , _ , s , _) ∷ _) = s
  rawOf′ : List Open → Maybe Bool
  rawOf′ [] = nothing
  rawOf′ ((_ , _ , _ , r) ∷ _) = r
  sc : Scope
  sc = scOf stack
  raw : Maybe Bool
  raw = rawOf′ stack
  slice : ℕ → ℕ → Str
  slice a b = go 0 src
    where
    go : ℕ → Str → Str
    go i []       = []
    go i (c ∷ cs) = if (i <ᵇ a) then go (suc i) cs else if (i <ᵇ b) then c ∷ go (suc i) cs else []
  with′ : Maybe Edit → Maybe Plan → Maybe Plan
  with′ _        nothing             = nothing
  with′ nothing  (just p)            = just p
  with′ (just e) (just (plan es b))  = just (plan (e ∷ es) b)
  withAll : List Edit → Maybe Plan → Maybe Plan
  withAll es nothing            = nothing
  withAll es (just (plan fs b)) = just (plan (es ++ fs) b)
  content : Bool → Str → Str
  content true  s = js rw s
  content false s = css rw s
  step : XKind → Maybe Plan
  step xText with raw
  ... | nothing = walk rw src stack rooted boot ts
  ... | just j with decode false (slice from to)
  ...   | nothing = nothing
  ...   | just d  = with′ (if eqStr (content j d) d then nothing else just (from , to , encodeText (content j d)))
                          (walk rw src stack rooted boot ts)
  step xCdata with raw
  ... | nothing = walk rw src stack rooted boot ts
  ... | just j  = with′ (if eqStr (content j d) d then nothing else just (from + 9 , to ∸ 3 , cdataSafe (content j d)))
                        (walk rw src stack rooted boot ts)
    where
    d : Str
    d = slice (from + 9) (to ∸ 3)
  step xComment = walk rw src stack rooted boot ts
  step xDoctype = walk rw src stack rooted boot ts
  step (xPi t d) = with′ (if rooted then nothing else piEdit rw from t d) (walk rw src stack rooted boot ts)
  step (xEnd n) = close stack
    where
    close : List Open → Maybe Plan
    close [] = nothing
    close ((m , _) ∷ rest) = if eqStr m n then walk rw src rest rooted boot ts else nothing
  step (xStart n as em) with bindings as
  ... | nothing = nothing
  ... | just b with resolve (b ++ sc) n
  ...   | nothing = nothing
  ...   | just u  = byNs (nsOf u)
    where
    sc′ : Scope
    sc′ = b ++ sc
    local : Str
    local with qname n
    ... | (_ , l) = lowerS l
    rawOf : XNs → Maybe Bool
    rawOf xOther = nothing
    rawOf _      = if eqStr local (toList "style") then just false else if eqStr local (toList "script") then just true else nothing
    bootAt : Bool → XNs → Bool → Maybe (ℕ × XNs)
    bootAt false xSvg   false = just (to , xSvg)
    bootAt false xXhtml false = just (to , xXhtml)
    bootAt _     _      _     = boot
    boot′ : XNs → Maybe (ℕ × XNs)
    boot′ x = bootAt rooted x em
    push : XNs → List Open
    push x = if em then stack else (n , x , sc′ , rawOf x) ∷ stack
    attrEdits : Attrs.Ns → List XAttr → Maybe (List (Edit × Str × Str))
    attrEdits ns []       = just []
    attrEdits ns (a ∷ r) with attrEdit rw ns local as sc′ a | attrEdits ns r
    ... | just (just e) | just es = just (e ∷ es)
    ... | just nothing  | just es = just es
    ... | _             | _       = nothing
    -- The changed attributes' originals, for read-back: ` crn-o="{…}"`
    -- before the start tag's end (the runtime takes it off before page
    -- scripts read it; as the HTML rewriter's).
    originals : List (Edit × Str × Str) → List Edit
    originals [] = []
    originals cs = (at′ , at′ , toList " crn-o=\"" ++ encodeAttr '"' (jsonObject cs) ++ '"' ∷ []) ∷ []
      where
      at′ : ℕ
      at′ = if em then to ∸ 2 else to ∸ 1
    edits′ : List (Edit × Str × Str) → List Edit
    edits′ []                 = []
    edits′ ((e , _ , _) ∷ r)  = e ∷ edits′ r
    go : XNs → Maybe (List (Edit × Str × Str)) → Maybe Plan
    go x nothing   = nothing
    go x (just cs) = withAll (edits′ cs ++ originals cs) (walk rw src (push x) true (boot′ x) ts)
    byNs : XNs → Maybe Plan
    byNs xSvg   = go xSvg (attrEdits svgNs as)
    byNs xXhtml = go xXhtml (attrEdits htmlNs as)
    byNs xOther = go xOther (just [])

-- The document's plan: its edits in order and where the bootstrap goes;
-- nothing: given as sent.
planOf : Rws → Str → Maybe Plan
planOf rw s with tokenize s
... | nothing = nothing
... | just ts = walk rw s [] false nothing ts

-- The rewritten document, the bootstrap (by the root's namespace) placed;
-- the document as sent when it does not read.
rewriteXml : Rws → (XNs → Str) → Str → Str
rewriteXml rw bootFor s with planOf rw s
... | nothing = s
... | just (plan es b) = apply 0 s (merge es b)
  where
  -- The bootstrap as an insertion at its place, among the edits.
  merge : List Edit → Maybe (ℕ × XNs) → List Edit
  merge es nothing = es
  merge [] (just (p , x)) = (p , p , bootFor x) ∷ []
  merge ((a , z , t) ∷ es) (just (p , x)) =
    if p <ᵇ (a + 1) then (p , p , bootFor x) ∷ (a , z , t) ∷ es else (a , z , t) ∷ merge es (just (p , x))
  apply : ℕ → Str → List Edit → Str
  apply i cs [] = cs
  apply i [] ((a , z , t) ∷ es) = t ++ apply i [] es
  apply i (c ∷ cs) ((a , z , t) ∷ es) =
    if i <ᵇ a then c ∷ apply (suc i) cs ((a , z , t) ∷ es)
    else t ++ apply z (skip (z ∸ i) (c ∷ cs)) es
    where
    skip : ℕ → Str → Str
    skip zero    r        = r
    skip (suc k) []       = []
    skip (suc k) (_ ∷ r)  = skip k r

------------------------------------------------------------------------
-- Worked cases (checked by the type checker), with stand-in rewriters.

private
  open import Relation.Binary.PropositionalEquality using (_≡_; refl)
  wrap : String → Str → Str
  wrap t s = toList t ++ '(' ∷ s ++ ')' ∷ []
  stand : Rws
  stand = record { url = λ _ s → 'P' ∷ s ; urls = wrap "L" ; srcset = wrap "S" ; cssVal = wrap "V"
                 ; cssDecl = wrap "D" ; css = wrap "C" ; js = wrap "J" ; sheet = λ s → 'P' ∷ s }
  bootFor : XNs → Str
  bootFor xSvg   = toList "<B/>"
  bootFor xXhtml = toList "<H/>"
  bootFor xOther = []
  rw : String → Str
  rw s = rewriteXml stand bootFor (toList s)

  -- The bootstrap after the root; a prefixed xlink:href, a plain href;
  -- an entity decoded and written back; style text and attribute.
  ex1 : rw "<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:x=\"http://www.w3.org/1999/xlink\"><style>a</style><image x:href='i.png'/><a href=\"h&amp;1\" style=\"s\"/></svg>"
      ≡ toList "<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:x=\"http://www.w3.org/1999/xlink\"><B/><style>C(a)</style><image x:href='Pi.png' crn-o=\"{&quot;x:href&quot;:&quot;i.png&quot;}\"/><a href=\"Ph&amp;1\" style=\"D(s)\" crn-o=\"{&quot;href&quot;:&quot;h&amp;1&quot;,&quot;style&quot;:&quot;s&quot;}\"/></svg>"
  ex1 = refl
  -- A CDATA script; an XHTML img inside; a handler.
  ex2 : rw "<svg xmlns=\"http://www.w3.org/2000/svg\" onload=\"f()\"><script><![CDATA[x<y]]></script><foreignObject><img xmlns=\"http://www.w3.org/1999/xhtml\" src=\"a\"/></foreignObject></svg>"
      ≡ toList "<svg xmlns=\"http://www.w3.org/2000/svg\" onload=\"J(f())\" crn-o=\"{&quot;onload&quot;:&quot;f()&quot;}\"><B/><script><![CDATA[J(x<y)]]></script><foreignObject><img xmlns=\"http://www.w3.org/1999/xhtml\" src=\"Pa\" crn-o=\"{&quot;src&quot;:&quot;a&quot;}\"/></foreignObject></svg>"
  ex2 = refl
  -- Another namespace: nothing; the xml-stylesheet instruction's href.
  ex3 : rw "<?xml-stylesheet type=\"text/css\" href=\"s.css\"?><r><img src=\"a\"/></r>"
      ≡ toList "<?xml-stylesheet type=\"text/css\" href=\"Ps.css\"?><r><img src=\"a\"/></r>"
  ex3 = refl
  -- Not well-formed (a mismatched end tag, an unbound prefix, an unknown
  -- entity): as sent.
  ex4 : rw "<svg xmlns=\"http://www.w3.org/2000/svg\"><g></svg>" ≡ toList "<svg xmlns=\"http://www.w3.org/2000/svg\"><g></svg>"
  ex4 = refl
  ex5 : rw "<p:svg><a/></p:svg>" ≡ toList "<p:svg><a/></p:svg>"
  ex5 = refl
  ex6 : rw "<svg xmlns=\"http://www.w3.org/2000/svg\"><a href=\"&nbsp;\"/></svg>" ≡ toList "<svg xmlns=\"http://www.w3.org/2000/svg\"><a href=\"&nbsp;\"/></svg>"
  ex6 = refl
  -- A self-closing root runs nothing: no bootstrap.
  ex7 : rw "<svg xmlns=\"http://www.w3.org/2000/svg\" style=\"x\"/>" ≡ toList "<svg xmlns=\"http://www.w3.org/2000/svg\" style=\"D(x)\" crn-o=\"{&quot;style&quot;:&quot;x&quot;}\"/>"
  ex7 = refl
