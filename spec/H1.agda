{-# OPTIONS --safe #-}
-- The header order recorded off a browser's HTTP/1.1 connection (Go:
-- internal/headerorder conn.feed / header, fed the bytes as they arrive,
-- in pieces of any size). RFC 9112 framing, for what a browser sends:
--
--   * a request is a header block ending at the first CRLF CRLF; its
--     record is the names of its header lines, in order — the text before
--     the first ":", SP / HTAB trimmed, ASCII-lowercased (a line without
--     ":" is not a header); the request line is not one;
--   * its body: chunked when a Transfer-Encoding value holds "chunked"
--     (any case) — chunks of a hex size (before any ";", SP / HTAB
--     trimmed), their data and CRLF, until a size of 0 and the trailer
--     lines up to an empty one; else the last Content-Length's digits
--     (none: no body);
--   * after an Upgrade header, CONNECT or PRI the connection is no longer
--     HTTP/1.x: nothing more is recorded; so after a chunk size that is
--     not hex.
-- A request whose block or body has not all arrived is not recorded yet.
-- (Go also gives up on a header block over 1 MiB, and on a chunk size
-- beyond 63 bits.)
--
-- Checked in Go (headerorder conformance): over pipelined requests split
-- at random points the recorder's records are these, and net/http's own
-- server, reading the same stream, serves requests that carry them.
module H1 where

open import Data.Bool.Base using (Bool; true; false; _∨_; _∧_; not; if_then_else_)
open import Data.Char.Base using (Char; toℕ)
open import Data.List.Base using (List; []; _∷_; _++_; reverse; length; map)
open import Data.Maybe.Base using (Maybe; just; nothing)
open import Data.Nat.Base using (ℕ; zero; suc; _+_; _*_; _∸_; _≡ᵇ_; _≤ᵇ_)
open import Data.Product.Base using (_×_; _,_; proj₁)
open import Data.String.Base using (toList)

open import Url using (Str; eqStr; is; isDigit; lowerAscii; break; within)

hasPrefix : Str → Str → Bool
hasPrefix [] _ = true
hasPrefix (_ ∷ _) [] = false
hasPrefix (p ∷ ps) (c ∷ cs) = (toℕ p ≡ᵇ toℕ c) ∧ hasPrefix ps cs

contains : Str → Str → Bool
contains p [] = hasPrefix p []
contains p (c ∷ cs) = hasPrefix p (c ∷ cs) ∨ contains p cs

-- The text up to the first CRLF CRLF, and after it.
block : Str → Maybe (Str × Str)
block s = go s []
  where
  go : Str → Str → Maybe (Str × Str)
  go (a ∷ b ∷ c ∷ d ∷ rest) acc =
    if is 13 a ∧ is 10 b ∧ is 13 c ∧ is 10 d then just (reverse acc , rest) else go (b ∷ c ∷ d ∷ rest) (a ∷ acc)
  go _ _ = nothing

-- Lines split at CRLF (a block holds no bare CR LF of its own).
crlfLines : Str → List Str
crlfLines s = go s []
  where
  go : Str → Str → List Str
  go [] acc = reverse acc ∷ []
  go (a ∷ b ∷ rest) acc = if is 13 a ∧ is 10 b then reverse acc ∷ go rest [] else go (b ∷ rest) (a ∷ acc)
  go (a ∷ []) acc = reverse (a ∷ acc) ∷ []

ows : Char → Bool
ows c = is 32 c ∨ is 9 c

trimOws : Str → Str
trimOws s = reverse (dropW (reverse (dropW s)))
  where
  dropW : Str → Str
  dropW [] = []
  dropW (c ∷ cs) = if ows c then dropW cs else c ∷ cs

record Header : Set where
  constructor hdr
  field
    names    : List Str
    chunked  : Bool
    len      : ℕ
    stops    : Bool    -- Upgrade, CONNECT, PRI

digitsValue : Str → ℕ
digitsValue = go 0
  where
  go : ℕ → Str → ℕ
  go n [] = n
  go n (c ∷ cs) = go (n * 10 + (toℕ c ∸ 48)) cs

allDigits : Str → Bool
allDigits [] = false
allDigits (c ∷ []) = isDigit c
allDigits (c ∷ cs) = isDigit c ∧ allDigits cs

readHeader : Str → Header
readHeader b with crlfLines b
... | [] = hdr [] false 0 false
... | rl ∷ ls = go ls (hdr [] false 0 (hasPrefix (toList "CONNECT ") rl ∨ hasPrefix (toList "PRI ") rl))
  where
  go : List Str → Header → Header
  go [] (hdr ns ch n st) = hdr (reverse ns) ch n st
  go (l ∷ rest) (hdr ns ch n st) with break (is 58) l
  ... | _ , [] = go rest (hdr ns ch n st)
  ... | name , (_ ∷ value) =
    go rest (hdr (nm ∷ ns)
                 (if eqStr nm (toList "transfer-encoding") then contains (toList "chunked") (map lowerAscii v) else ch)
                 (if eqStr nm (toList "content-length") then (if allDigits v then digitsValue v else 0) else n)
                 (st ∨ eqStr nm (toList "upgrade")))
    where
    nm v : Str
    nm = map lowerAscii (trimOws name)
    v = trimOws value

dropN : ℕ → Str → Maybe Str
dropN zero s = just s
dropN (suc n) [] = nothing
dropN (suc n) (_ ∷ cs) = dropN n cs

-- One line (up to LF, CR before it dropped) and the rest; nothing: no LF yet.
line : Str → Maybe (Str × Str)
line s = go s []
  where
  go : Str → Str → Maybe (Str × Str)
  go [] _ = nothing
  go (c ∷ cs) acc = if is 10 c then just (dropCR (reverse acc) , cs) else go cs (c ∷ acc)
    where
    dropCR : Str → Str
    dropCR x with reverse x
    ... | (r ∷ rs) = if is 13 r then reverse rs else x
    ... | [] = x

hexVal : Char → Maybe ℕ
hexVal c = if isDigit c then just (toℕ c ∸ 48)
  else if within 97 102 c then just (toℕ c ∸ 87)
  else if within 65 70 c then just (toℕ c ∸ 55) else nothing

hex : Str → Maybe ℕ
hex [] = nothing
hex s = go s 0
  where
  go : Str → ℕ → Maybe ℕ
  go [] n = just n
  go (c ∷ cs) n with hexVal c
  ... | just d  = go cs (n * 16 + d)
  ... | nothing = nothing

data Body : Set where
  rest   : Str → Body    -- the body is over; what follows
  short  : Body          -- not all here yet
  broken : Body          -- not HTTP/1.x framing any more

-- The trailer lines, up to an empty one.
trailers : ℕ → Str → Body
trailers zero _ = short
trailers (suc g) t with line t
... | nothing = short
... | just ([] , more) = rest more
... | just (_ ∷ _ , more) = trailers g more

-- A chunked body; fuel: the stream's length.
chunks : ℕ → Str → Body
chunks zero _ = short
chunks (suc f) s with line s
... | nothing = short
... | just (sz , after) with hex (trimOws (proj₁ (break (is 59) sz)))
...   | nothing = broken
...   | just zero = trailers f after
...   | just (suc k) with dropN (suc k) after
...     | nothing = short
...     | just d with line d
...       | nothing = short
...       | just (_ , more) = chunks f more

-- The records of a stream; fuel: its length.
records : ℕ → Str → List (List Str)
records zero _ = []
records (suc f) s with block s
... | nothing = []
... | just (b , after) = Header.names h ∷ next
  where
  h : Header
  h = readHeader b
  body : Body
  body = if Header.chunked h then chunks (suc (length after)) after
         else (if Header.len h ≡ᵇ 0 then rest after else bodyOf (dropN (Header.len h) after))
    where
    bodyOf : Maybe Str → Body
    bodyOf (just r) = rest r
    bodyOf nothing  = short
  next : List (List Str)
  next with Header.stops h | body
  ... | true  | _       = []
  ... | false | rest r  = records f r
  ... | false | short   = []
  ... | false | broken  = []

recordsOf : Str → List (List Str)
recordsOf s = records (suc (length s)) s
