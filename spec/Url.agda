{-# OPTIONS --safe #-}
-- How a URL string is read: the WHATWG URL Standard's basic URL parser,
-- for the URLs cyrano rewrites.
--
-- Decided by the owner (2026-11-17): target URLs are normalized the way
-- the browser does it ("Browser/WHATWG"). The browser is the reference
-- because the client runtime rewrites URLs that the browser has already
-- parsed, and the server's static rewrite must produce the same bytes.
-- Where browsers differ from the written standard, the reference is
-- Chromium (checked by ts/client/tests/spec/spec-vs-chromium.test.ts):
-- the path percent-encode set below includes ^ and |, which the standard
-- and Node 22 leave as they are.
--
-- The model covers http, https, ws and wss URLs with ASCII domain or
-- dotted-quad hosts. It does not decide (answers `outside`): IPv6 hosts,
-- non-ASCII hosts (IDNA), percent-encoded hosts, and IPv4 hosts written
-- any other way than four decimal numbers.
module Url where

open import Data.Bool.Base using (Bool; true; false; _∧_; _∨_; not; if_then_else_)
open import Data.Char.Base using (Char; toℕ; fromℕ)
open import Data.List.Base using (List; []; _∷_; _++_; reverse; concatMap; foldr)
open import Data.Maybe.Base using (Maybe; just; nothing)
open import Data.Nat.Base using (ℕ; zero; suc; _+_; _∸_; _*_; _^_; _≡ᵇ_; _<ᵇ_; _≤ᵇ_; _/_; _%_)
open import Data.Nat.Show using () renaming (show to showℕ)
open import Data.Product.Base using (_×_; _,_; proj₁; proj₂)
open import Data.String.Base using (toList)

open import Scheme

Str : Set
Str = List Char

------------------------------------------------------------------------
-- Characters, by code point.

is : ℕ → Char → Bool
is n c = toℕ c ≡ᵇ n

within : ℕ → ℕ → Char → Bool
within lo hi c = (lo ≤ᵇ toℕ c) ∧ (toℕ c ≤ᵇ hi)

isAlpha : Char → Bool
isAlpha c = within 65 90 c ∨ within 97 122 c

isDigit : Char → Bool
isDigit = within 48 57

isHex : Char → Bool
isHex c = isDigit c ∨ within 65 70 c ∨ within 97 102 c

lowerAscii : Char → Char
lowerAscii c = if within 65 90 c then fromℕ (toℕ c + 32) else c

-- '/' and '\': a special URL (every scheme cyrano proxifies is special)
-- treats a backslash as a slash.
isSlash : Char → Bool
isSlash c = is 47 c ∨ is 92 c

isQuery isHash : Char → Bool
isQuery = is 63
isHash  = is 35

------------------------------------------------------------------------
-- List helpers (kept local so the rules do not depend on library names).

dropWhile : (Char → Bool) → Str → Str
dropWhile p []       = []
dropWhile p (c ∷ cs) = if p c then dropWhile p cs else c ∷ cs

filter : (Char → Bool) → Str → Str
filter p []       = []
filter p (c ∷ cs) = if p c then c ∷ filter p cs else filter p cs

any : (Char → Bool) → Str → Bool
any p []       = false
any p (c ∷ cs) = p c ∨ any p cs

all : (Char → Bool) → Str → Bool
all p []       = true
all p (c ∷ cs) = p c ∧ all p cs

break : (Char → Bool) → Str → Str × Str
break p [] = [] , []
break p (c ∷ cs) with p c
... | true  = [] , c ∷ cs
... | false with break p cs
...   | a , b = c ∷ a , b

-- Split at the last character satisfying p (dropping it):
-- just (before, after), or nothing when there is none.
splitLast : (Char → Bool) → Str → Maybe (Str × Str)
splitLast p s with break p (reverse s)
... | _     , []     = nothing
... | after , _ ∷ before = just (reverse before , reverse after)

splitOn : (Char → Bool) → Str → List Str
splitOn p = go []
  where
  go : Str → Str → List Str
  go buf []       = reverse buf ∷ []
  go buf (c ∷ cs) = if p c then reverse buf ∷ go [] cs else go (c ∷ buf) cs

isEmpty : Str → Bool
isEmpty []      = true
isEmpty (_ ∷ _) = false

eqStr : Str → Str → Bool
eqStr []       []       = true
eqStr []       (_ ∷ _)  = false
eqStr (_ ∷ _)  []       = false
eqStr (a ∷ as) (b ∷ bs) = (toℕ a ≡ᵇ toℕ b) ∧ eqStr as bs

-- ASCII case-insensitive equality against a lowercase literal.
eqLower : Str → Str → Bool
eqLower s lit = eqStr (lowerAll s) lit
  where
  lowerAll : Str → Str
  lowerAll []       = []
  lowerAll (c ∷ cs) = lowerAscii c ∷ lowerAll cs

------------------------------------------------------------------------
-- Pre-processing: the browser drops leading and trailing C0 controls and
-- spaces, then every tab, LF and CR anywhere in the string.

isC0OrSpace : Char → Bool
isC0OrSpace c = toℕ c ≤ᵇ 32

isTabOrNewline : Char → Bool
isTabOrNewline c = is 9 c ∨ is 10 c ∨ is 13 c

preprocess : Str → Str
preprocess s =
  filter (λ c → not (isTabOrNewline c))
         (reverse (dropWhile isC0OrSpace (reverse (dropWhile isC0OrSpace s))))

------------------------------------------------------------------------
-- Percent-encoding (UTF-8, uppercase hex). '%' itself is never encoded:
-- an existing escape is kept as written.

utf8 : ℕ → List ℕ
utf8 n =
  if n <ᵇ 128 then n ∷ []
  else if n <ᵇ 2048 then (192 + n / 64) ∷ (128 + n % 64) ∷ []
  else if n <ᵇ 65536 then (224 + n / 4096) ∷ (128 + (n / 64) % 64) ∷ (128 + n % 64) ∷ []
  else (240 + n / 262144) ∷ (128 + (n / 4096) % 64) ∷ (128 + (n / 64) % 64) ∷ (128 + n % 64) ∷ []

hexDigit : ℕ → Char
hexDigit d = if d <ᵇ 10 then fromℕ (48 + d) else fromℕ (55 + d)

pctByte : ℕ → Str
pctByte b = fromℕ 37 ∷ hexDigit (b / 16) ∷ hexDigit (b % 16) ∷ []

encodeWith : (Char → Bool) → Str → Str
encodeWith inSet []       = []
encodeWith inSet (c ∷ cs) =
  (if inSet c then concatMap pctByte (utf8 (toℕ c)) else c ∷ []) ++ encodeWith inSet cs

-- C0 controls and everything above '~'.
c0Set : Char → Bool
c0Set c = (toℕ c <ᵇ 32) ∨ (126 <ᵇ toℕ c)

fragmentSet : Char → Bool
fragmentSet c = c0Set c ∨ is 32 c ∨ is 34 c ∨ is 60 c ∨ is 62 c ∨ is 96 c

-- The special-query set ('\'' included, as for every special URL).
querySet : Char → Bool
querySet c = c0Set c ∨ is 32 c ∨ is 34 c ∨ is 35 c ∨ is 60 c ∨ is 62 c ∨ is 39 c

-- The path set: the query set without '\'', plus ? ` { }, and — as
-- Chromium encodes them, unlike the written standard and Node — ^ and |.
pathSet : Char → Bool
pathSet c = c0Set c ∨ is 32 c ∨ is 34 c ∨ is 35 c ∨ is 60 c ∨ is 62 c
          ∨ is 63 c ∨ is 96 c ∨ is 123 c ∨ is 125 c ∨ is 94 c ∨ is 124 c

-- The userinfo set: the path set plus / : ; = @ [ \ ] ^ |.
userinfoSet : Char → Bool
userinfoSet c = pathSet c ∨ is 47 c ∨ is 58 c ∨ is 59 c ∨ is 61 c ∨ is 64 c
              ∨ within 91 94 c ∨ is 124 c

------------------------------------------------------------------------
-- A parsed absolute URL. The authority is kept as its canonical text,
-- host[:port], with the host lowercased and a default port dropped; the
-- path as its segments, already percent-encoded and with dot segments
-- resolved. The authority carries the userinfo too, as the browser
-- writes it ("user:pass@", "user@", ":pass@", or nothing): page code
-- reads it back in a.href, so it is kept (the page cannot tell,
-- REQUIREMENTS.md; supersedes the 2026-11-17 "drop userinfo" ruling).

record Abs : Set where
  constructor mkAbs
  field
    scheme : Scheme
    auth   : Str
    path   : List Str
    query  : Maybe Str
    frag   : Maybe Str
open Abs public

-- What reading a string gives.
data Parsed : Set where
  url         : Abs → Parsed
  otherScheme : Parsed   -- a scheme cyrano does not proxify
  invalid     : Parsed   -- the browser's parser rejects it
  outside     : Parsed   -- outside the model: the spec does not decide

------------------------------------------------------------------------
-- Host and port.

-- WHATWG forbidden domain code points (ASCII; applied after
-- percent-decoding, so % [ ] can reach it) — except the space, which
-- Chromium escapes instead (see chromiumHost).
forbiddenDomain : Char → Bool
forbiddenDomain c = (toℕ c <ᵇ 32) ∨ is 127 c ∨ is 35 c ∨ is 37 c ∨ is 47 c ∨ is 58 c ∨ is 60 c
                  ∨ is 62 c ∨ is 63 c ∨ is 64 c ∨ is 91 c ∨ is 92 c ∨ is 93 c ∨ is 94 c ∨ is 124 c

hexVal : Char → ℕ
hexVal c = if isDigit c then toℕ c ∸ 48
           else if within 65 70 c then toℕ c ∸ 55
           else toℕ c ∸ 87

-- WHATWG percent-decode: %XX becomes that byte (here a code point below
-- 256); a '%' not followed by two hex digits stays.
pctDecode : Str → Str
pctAfter  : Str → Str   -- what follows a '%'

pctDecode []       = []
pctDecode (c ∷ cs) = if is 37 c then pctAfter cs else c ∷ pctDecode cs

pctAfter (a ∷ b ∷ rest) =
  if isHex a ∧ isHex b then fromℕ (hexVal a * 16 + hexVal b) ∷ pctDecode rest
  else fromℕ 37 ∷ pctDecode (a ∷ b ∷ rest)
pctAfter cs = fromℕ 37 ∷ pctDecode cs

-- An IDNA ("xn--") label: its validity is Punycode's, outside the model.
xnLabel : Str → Bool
xnLabel l = eqStr (take4 l) (toList "xn--")
  where
  take4 : Str → Str
  take4 (a ∷ b ∷ c ∷ d ∷ _) = a ∷ b ∷ c ∷ d ∷ []
  take4 _                   = []

digitsValue : Str → ℕ
digitsValue = go 0
  where
  go : ℕ → Str → ℕ
  go acc []       = acc
  go acc (c ∷ cs) = go (acc * 10 + (toℕ c ∸ 48)) cs

-- A decimal label 0..255 written without leading zeros (IPv4 inside
-- IPv6 is written only this way).
octet : Str → Bool
octet []           = false
octet (c ∷ [])     = isDigit c
octet (c ∷ d ∷ ds) = isDigit c ∧ not (is 48 c) ∧ all isDigit (d ∷ ds)
                   ∧ (digitsValue (c ∷ d ∷ ds) ≤ᵇ 255)

-- "Ends in a number": the last label (ignoring one trailing dot) is all
-- digits, or 0x-hex. Such a host is an IPv4 address to the browser.
lastLabel : List Str → Str
lastLabel ls with reverse ls
... | []    = []
... | l ∷ _ = l

numericLabel : Str → Bool
numericLabel []           = false
numericLabel (c ∷ cs)     =
  all isDigit (c ∷ cs) ∨ (is 48 c ∧ hexTail cs)
  where
  hexTail : Str → Bool
  hexTail []       = false
  hexTail (x ∷ xs) = (is 120 x ∨ is 88 x) ∧ all isHex xs

dropTrailingEmpty : List Str → List Str
dropTrailingEmpty ls with reverse ls
... | [] ∷ rest = reverse rest
... | _         = ls

endsInNumber : Str → Bool
endsInNumber h = numericLabel (lastLabel (dropTrailingEmpty (splitOn (is 46) h)))

lengthL : {A : Set} → List A → ℕ
lengthL []       = 0
lengthL (_ ∷ xs) = suc (lengthL xs)

------------------------------------------------------------------------
-- IPv4 (WHATWG "IPv4 parser"): one to four parts, each decimal, octal
-- (leading 0) or hex (0x); the last part fills the remaining bytes.

-- The digits of `s` in radix r (8, 10 or 16), or nothing.
inRadix : ℕ → Str → Maybe ℕ
inRadix r s = if all ok s then just (go 0 s) else nothing
  where
  ok : Char → Bool
  ok c = if r ≡ᵇ 16 then isHex c else if r ≡ᵇ 8 then within 48 55 c else isDigit c

  go : ℕ → Str → ℕ
  go acc []       = acc
  go acc (c ∷ cs) = go (acc * r + hexVal c) cs

ipv4Number : Str → Maybe ℕ
ipv4Number []           = nothing
ipv4Number (c ∷ [])     = inRadix 10 (c ∷ [])
ipv4Number (c ∷ x ∷ xs) =
  if is 48 c ∧ (is 120 x ∨ is 88 x) then inRadix 16 xs
  else if is 48 c then inRadix 8 (x ∷ xs)
  else inRadix 10 (c ∷ x ∷ xs)

numbers : List Str → Maybe (List ℕ)
numbers []       = just []
numbers (p ∷ ps) with ipv4Number p | numbers ps
... | just n | just ns = just (n ∷ ns)
... | _      | _       = nothing

-- The 32-bit address, or nothing (failure).
ipv4 : Str → Maybe ℕ
ipv4 h = byParts (dropTrailingEmpty (splitOn (is 46) h))
  where
  combine : ℕ → List ℕ → Maybe ℕ
  combine k []       = nothing
  combine k (n ∷ []) = if (256 ^ (4 ∸ k)) ≤ᵇ n then nothing else just n
  combine k (n ∷ m ∷ ms) with combine (suc k) (m ∷ ms)
  ... | nothing = nothing
  ... | just v  = if 255 <ᵇ n then nothing else just (n * 256 ^ (3 ∸ k) + v)

  byParts : List Str → Maybe ℕ
  byParts ps with numbers ps
  ... | nothing = nothing
  ... | just ns = if 4 <ᵇ lengthL ns then nothing else combine 0 ns

showN : ℕ → Str
showN n = toList (showℕ n)

ipv4Text : ℕ → Str
ipv4Text n = showN (n / 16777216 % 256) ++ dot ∷ showN (n / 65536 % 256) ++ dot ∷
             showN (n / 256 % 256) ++ dot ∷ showN (n % 256)
  where
  dot : Char
  dot = fromℕ 46

------------------------------------------------------------------------
-- IPv6 (WHATWG "IPv6 parser" and serializer), for the text between the
-- brackets.

-- Up to the first "::", and what follows it.
breakDouble : Str → Str × Maybe Str
breakDouble []           = [] , nothing
breakDouble (c ∷ [])     = c ∷ [] , nothing
breakDouble (c ∷ d ∷ cs) =
  if is 58 c ∧ is 58 d then [] , just cs
  else consL (breakDouble (d ∷ cs))
  where
  consL : Str × Maybe Str → Str × Maybe Str
  consL (l , r) = c ∷ l , r

-- A piece: one to four hex digits.
piece : Str → Maybe ℕ
piece g = if isEmpty g ∨ (4 <ᵇ lengthL g) then nothing else inRadix 16 g

-- IPv4 inside IPv6: four octets, as two pieces.
v4Pieces : Str → Maybe (List ℕ)
v4Pieces g with splitOn (is 46) g
... | a ∷ b ∷ c ∷ d ∷ [] =
  if octet a ∧ octet b ∧ octet c ∧ octet d
  then just ((digitsValue a * 256 + digitsValue b) ∷ (digitsValue c * 256 + digitsValue d) ∷ [])
  else nothing
... | _ = nothing

-- Colon-separated groups; only the last of the address (`tail`) may be
-- an IPv4 address.
groups : Bool → Str → Maybe (List ℕ)
groups tail [] = just []
groups tail s  = go (splitOn (is 58) s)
  where
  go : List Str → Maybe (List ℕ)
  go []       = just []
  go (g ∷ []) = if tail ∧ any (is 46) g then v4Pieces g else one (piece g)
    where
    one : Maybe ℕ → Maybe (List ℕ)
    one (just n) = just (n ∷ [])
    one nothing  = nothing
  go (g ∷ gs) with piece g | go gs
  ... | just n | just ns = just (n ∷ ns)
  ... | _      | _       = nothing

zeros : ℕ → List ℕ
zeros zero    = []
zeros (suc n) = 0 ∷ zeros n

ipv6 : Str → Maybe (List ℕ)
ipv6 s with breakDouble s
... | l , nothing = eight (groups true l)
  where
  eight : Maybe (List ℕ) → Maybe (List ℕ)
  eight (just ps) = if lengthL ps ≡ᵇ 8 then just ps else nothing
  eight nothing   = nothing
... | l , just r with breakDouble r
...   | _ , just _  = nothing          -- a second "::"
...   | _ , nothing with groups false l | groups true r
...     | just ls | just rs =
  if 7 <ᵇ (lengthL ls + lengthL rs) then nothing
  else just (ls ++ zeros (8 ∸ (lengthL ls + lengthL rs)) ++ rs)
...     | _ | _ = nothing

lowerHex : ℕ → Str
lowerHex n = go n 4 []
  where
  digit : ℕ → Char
  digit d = if d <ᵇ 10 then fromℕ (48 + d) else fromℕ (87 + d)

  go : ℕ → ℕ → Str → Str
  go n zero    acc = acc
  go n (suc k) acc = if (n ≡ᵇ 0) ∧ not (isEmpty acc) then acc else go (n / 16) k (digit (n % 16) ∷ acc)

-- The first longest run of zero pieces (length ≥ 2), as (start, length).
longestZeros : List ℕ → Maybe (ℕ × ℕ)
longestZeros ps = go 0 ps nothing
  where
  run : List ℕ → ℕ
  run []       = 0
  run (p ∷ qs) = if p ≡ᵇ 0 then suc (run qs) else 0

  better : ℕ → ℕ → Maybe (ℕ × ℕ) → Maybe (ℕ × ℕ)
  better i n nothing          = if 1 <ᵇ n then just (i , n) else nothing
  better i n (just (j , m))   = if m <ᵇ n then just (i , n) else just (j , m)

  go : ℕ → List ℕ → Maybe (ℕ × ℕ) → Maybe (ℕ × ℕ)
  go i []       best = best
  go i (p ∷ qs) best = go (suc i) qs (better i (run (p ∷ qs)) best)

ipv6Text : List ℕ → Str
ipv6Text ps = fromℕ 91 ∷ body (longestZeros ps) ++ fromℕ 93 ∷ []
  where
  colon : Char
  colon = fromℕ 58

  plain : List ℕ → Str
  plain []           = []
  plain (p ∷ [])     = lowerHex p
  plain (p ∷ q ∷ qs) = lowerHex p ++ colon ∷ plain (q ∷ qs)

  dropN : ℕ → List ℕ → List ℕ
  dropN zero    xs       = xs
  dropN (suc n) []       = []
  dropN (suc n) (_ ∷ xs) = dropN n xs

  takeN : ℕ → List ℕ → List ℕ
  takeN zero    xs       = []
  takeN (suc n) []       = []
  takeN (suc n) (x ∷ xs) = x ∷ takeN n xs

  body : Maybe (ℕ × ℕ) → Str
  body nothing        = plain ps
  body (just (i , n)) = plain (takeN i ps) ++ colon ∷ colon ∷ plain (dropN (i + n) ps)

------------------------------------------------------------------------

-- Where Chromium departs from the standard for a domain: a space and '*'
-- are kept, percent-encoded (%20, %2A), where the standard rejects the
-- space and keeps '*' as it is. (Probed over every ASCII character.)
chromiumHost : Str → Str
chromiumHost []       = []
chromiumHost (c ∷ cs) =
  if is 32 c then fromℕ 37 ∷ '2' ∷ '0' ∷ chromiumHost cs
  else if is 42 c then fromℕ 37 ∷ '2' ∷ 'A' ∷ chromiumHost cs
  else c ∷ chromiumHost cs

data HostResult : Set where
  hostOk      : Str → HostResult
  hostInvalid : HostResult
  hostOutside : HostResult

-- The WHATWG host parser. "[…]" is IPv6. Otherwise: non-ASCII is IDNA,
-- outside the model; then percent-decode — a byte above 0x7F would be
-- UTF-8 for IDNA, outside again — check what the decoded host may
-- contain, and read a host that ends in a number as IPv4.
host : Str → HostResult
host [] = hostInvalid
host (c ∷ cs) =
  if is 91 c then bracketed (reverse cs)
  else if any (λ c → 127 <ᵇ toℕ c) (c ∷ cs) then hostOutside
  else if any (λ c → 127 <ᵇ toℕ c) d then hostOutside
  else if any forbiddenDomain d then hostInvalid
  else if anyXn (splitOn (is 46) lower) then hostOutside
  else if endsInNumber lower then v4 (ipv4 lower)
  else hostOk (chromiumHost lower)
  where
  d : Str
  d = pctDecode (c ∷ cs)

  anyXn : List Str → Bool
  anyXn []       = false
  anyXn (l ∷ ls) = xnLabel l ∨ anyXn ls

  lower : Str
  lower = foldr (λ c cs → lowerAscii c ∷ cs) [] d

  v4 : Maybe ℕ → HostResult
  v4 nothing  = hostInvalid
  v4 (just n) = hostOk (ipv4Text n)

  v6 : Maybe (List ℕ) → HostResult
  v6 nothing   = hostInvalid
  v6 (just ps) = hostOk (ipv6Text ps)

  -- cs reversed: must end in ']'.
  bracketed : Str → HostResult
  bracketed []        = hostInvalid
  bracketed (e ∷ rin) = if is 93 e then v6 (ipv6 (reverse rin)) else hostInvalid

-- The port, canonical: nothing for no port or the scheme's default.
data PortResult : Set where
  portNone    : PortResult
  portSome    : ℕ → PortResult
  portInvalid : PortResult

port : Scheme → Str → PortResult
port s [] = portNone
port s p  =
  if not (all isDigit p) then portInvalid
  else if 65535 <ᵇ digitsValue p then portInvalid
  else if digitsValue p ≡ᵇ defaultPort s then portNone
  else portSome (digitsValue p)

------------------------------------------------------------------------
-- The authority: everything up to the first / \ ? # . Userinfo is
-- everything up to its last '@'; the host ends at the first ':'.

-- Userinfo as the browser serializes it: the username and password
-- (split at the first ':') percent-encoded, written only when one of
-- them is non-empty.
userinfoText : Str → Str
userinfoText ui with break (is 58) ui
... | u , rest = written (encodeWith userinfoSet u) (encodeWith userinfoSet (password rest))
  where
  password : Str → Str
  password []      = []
  password (_ ∷ p) = p

  written : Str → Str → Str
  written [] []       = []
  written u  []       = u ++ fromℕ 64 ∷ []
  written u  (c ∷ cs) = u ++ fromℕ 58 ∷ c ∷ cs ++ fromℕ 64 ∷ []

-- The host[:port] of a canonical authority: what follows the userinfo.
-- (Canonical userinfo has no raw '@'; an '@' in it is written %40.)
hostPort : Str → Str
hostPort a with splitLast (is 64) a
... | nothing          = a
... | just (_ , after) = after

isAuthorityEnd : Char → Bool
isAuthorityEnd c = isSlash c ∨ isQuery c ∨ isHash c

data AuthResult : Set where
  authOk      : Str → Str → AuthResult   -- canonical host[:port], what follows
  authInvalid : AuthResult
  authOutside : AuthResult

authority : Scheme → Str → AuthResult
authority s inp with break isAuthorityEnd inp
... | auth , rest = split (splitLast (is 64) auth)
  where
  build : Str → Str → PortResult → AuthResult
  build u h portNone     = authOk (u ++ h) rest
  build u h (portSome n) = authOk (u ++ h ++ fromℕ 58 ∷ toList (showℕ n)) rest
  build u h portInvalid  = authInvalid

  -- Host and optional port text. Inside "[…]" a ':' is part of the host.
  hostAndPort : Str → Str × Maybe Str
  hostAndPort [] = [] , nothing
  hostAndPort (c ∷ cs) = if is 91 c then bracket (break (is 93) cs) else plain (break (is 58) (c ∷ cs))
    where
    plain : Str × Str → Str × Maybe Str
    plain (h , [])    = h , nothing
    plain (h , _ ∷ p) = h , just p

    bracket : Str × Str → Str × Maybe Str
    bracket (inner , _ ∷ [])     = c ∷ inner ++ fromℕ 93 ∷ [] , nothing
    bracket (inner , _ ∷ d ∷ p)  = if is 58 d then c ∷ inner ++ fromℕ 93 ∷ [] , just p else c ∷ cs , nothing
    bracket (inner , [])         = c ∷ cs , nothing

  fromHostPort : Str → Str → AuthResult
  fromHostPort u hp with hostAndPort hp
  ... | h , mp with host h
  ...   | hostInvalid = authInvalid
  ...   | hostOutside = authOutside
  ...   | hostOk h′ with mp
  ...     | nothing = build u h′ portNone
  ...     | just p  = build u h′ (port s p)

  split : Maybe (Str × Str) → AuthResult
  split nothing             = fromHostPort [] auth
  split (just (ui′ , hp))   = fromHostPort (userinfoText ui′) hp

------------------------------------------------------------------------
-- The path, query and fragment.

isSingleDot : Str → Bool
isSingleDot b = eqStr b (toList ".") ∨ eqLower b (toList "%2e")

isDoubleDot : Str → Bool
isDoubleDot b = eqStr b (toList "..") ∨ eqLower b (toList ".%2e")
              ∨ eqLower b (toList "%2e.") ∨ eqLower b (toList "%2e%2e")

shorten : List Str → List Str        -- on the path reversed (last first)
shorten []       = []
shorten (_ ∷ ps) = ps

-- WHATWG path state, at the end of one segment. `slash`: the segment
-- ended at a slash (not at ?, # or the end).
endSegment : Bool → Str → List Str → List Str
endSegment slash b acc =
  if isDoubleDot b then (if slash then shorten acc else [] ∷ shorten acc)
  else if isSingleDot b then (if slash then acc else [] ∷ acc)
  else encodeWith pathSet b ∷ acc

-- acc: the path so far, reversed. buf: the current segment, reversed.
pathLoop : List Str → Str → Str → List Str × Str
pathLoop acc buf [] = reverse (endSegment false (reverse buf) acc) , []
pathLoop acc buf (c ∷ cs) =
  if isSlash c then pathLoop (endSegment true (reverse buf) acc) [] cs
  else if isQuery c ∨ isHash c then (reverse (endSegment false (reverse buf) acc) , c ∷ cs)
  else pathLoop acc (c ∷ buf) cs

fragmentOf : Str → Maybe Str
fragmentOf []       = nothing
fragmentOf (_ ∷ f)  = just (encodeWith fragmentSet f)

-- What follows the path: an optional ?query, then an optional #fragment.
queryAndFragment : Str → Maybe Str × Maybe Str
queryAndFragment [] = nothing , nothing
queryAndFragment (c ∷ cs) with isQuery c
... | false = nothing , fragmentOf (c ∷ cs)
... | true with break isHash cs
...   | q , r = just (encodeWith querySet q) , fragmentOf r

fromPath : Scheme → Str → List Str × Str → Abs
fromPath s a (p , r) = mkAbs s a p (proj₁ (queryAndFragment r)) (proj₂ (queryAndFragment r))

-- Path start after an authority: one leading slash belongs to the path.
afterAuthority : Scheme → Str → Str → Abs
afterAuthority s a []       = fromPath s a (pathLoop [] [] [])
afterAuthority s a (c ∷ cs) = fromPath s a (pathLoop [] [] (if isSlash c then cs else c ∷ cs))

withAuthority : Scheme → Str → Parsed
withAuthority s inp with authority s (dropWhile isSlash inp)
... | authOk a rest = url (afterAuthority s a rest)
... | authInvalid   = invalid
... | authOutside   = outside

------------------------------------------------------------------------
-- Scheme: ALPHA *( ALPHA / DIGIT / + / - / . ) ":" , lowercased.

isSchemeChar : Char → Bool
isSchemeChar c = isAlpha c ∨ isDigit c ∨ is 43 c ∨ is 45 c ∨ is 46 c

schemeSplit : Str → Maybe (Str × Str)
schemeSplit []       = nothing
schemeSplit (c ∷ cs) = if isAlpha c then go (lowerAscii c ∷ []) cs else nothing
  where
  go : Str → Str → Maybe (Str × Str)
  go acc []       = nothing
  go acc (d ∷ ds) =
    if is 58 d then just (reverse acc , ds)
    else if isSchemeChar d then go (lowerAscii d ∷ acc) ds
    else nothing

------------------------------------------------------------------------
-- Resolving a reference against a base (WHATWG "relative state").

init : List Str → List Str
init ps = reverse (shorten (reverse ps))

relative : Abs → Str → Parsed
relative b [] = url (mkAbs (scheme b) (auth b) (path b) (query b) nothing)
relative b (c ∷ cs) =
  if isSlash c then slashed cs
  else if isQuery c then url (withQF (path b) (c ∷ cs))
  else if isHash c then url (mkAbs (scheme b) (auth b) (path b) (query b) (fragmentOf (c ∷ cs)))
  else url (pathFrom (reverse (init (path b))) (c ∷ cs))
  where
  withQF : List Str → Str → Abs
  withQF p r = mkAbs (scheme b) (auth b) p (proj₁ (queryAndFragment r)) (proj₂ (queryAndFragment r))

  pathFrom : List Str → Str → Abs
  pathFrom acc s with pathLoop acc [] s
  ... | p , r = withQF p r

  -- After one slash: a second one starts an authority (any further
  -- slashes are skipped); otherwise the path is absolute on the base host.
  slashed : Str → Parsed
  slashed []       = url (pathFrom [] [])
  slashed (d ∷ ds) =
    if isSlash d then withAuthority (scheme b) ds
    else url (pathFrom [] (d ∷ ds))

sameScheme : Scheme → Scheme → Bool
sameScheme a b = eqStr (schemeChars a) (schemeChars b)

-- Read `s` against an optional base. Without a base, only an absolute
-- URL is understood.
parse : Maybe Abs → Str → Parsed
parse base s = bySplit (schemeSplit s)
  where
  noScheme : Maybe Abs → Parsed
  noScheme nothing  = invalid
  noScheme (just b) = relative b s

  -- "https:foo" on an https page is relative to the page; on any other
  -- page (or with no page) the slashes are optional and it names host foo.
  withScheme : Maybe Abs → Scheme → Str → Parsed
  withScheme nothing  sc rest = withAuthority sc rest
  withScheme (just b) sc rest =
    if sameScheme sc (scheme b) then relative b rest else withAuthority sc rest

  byName : Maybe Scheme → Str → Parsed
  byName nothing   rest = otherScheme
  byName (just sc) rest = withScheme base sc rest

  bySplit : Maybe (Str × Str) → Parsed
  bySplit nothing             = noScheme base
  bySplit (just (name , rest)) = byName (schemeOf name) rest

------------------------------------------------------------------------
-- Serializing.

slash : Char
slash = fromℕ 47

pathText : List Str → Str
pathText []       = []
pathText (p ∷ ps) = slash ∷ p ++ pathText ps

-- An empty query or fragment is written as a bare "?" or "#", as the
-- browser does: page code reads it back in href (the page cannot tell;
-- supersedes the 2026-11-17 "drop bare ? and #" ruling).
queryText : Maybe Str → Str
queryText nothing  = []
queryText (just q) = fromℕ 63 ∷ q

fragText : Maybe Str → Str
fragText nothing  = []
fragText (just f) = fromℕ 35 ∷ f

originText : Scheme → Str → Str
originText s a = schemeChars s ++ toList "://" ++ a

href : Abs → Str
href u = originText (scheme u) (auth u) ++ pathText (path u) ++ queryText (query u) ++ fragText (frag u)
