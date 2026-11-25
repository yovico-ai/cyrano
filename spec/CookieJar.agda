{-# OPTIONS --safe #-}
------------------------------------------------------------------------
-- The cookie jar on the server, and the channel through the browser's own
-- jar (owner, 2026-11-23: "go ahead with the server-side cookie jar").
--
-- Every proxied site shares the proxy origin, so in the browser's own jar
-- they shared one site's limit: 180 cookies (Chromium evicts beyond it),
-- and consent and session cookies were evicted on busy sites. Now:
--
--   * the server keeps every cookie of a session — script-visible ones
--     too — in its jar, with Chromium's limits per registrable domain
--     (`put`, `evict`: 180, purged to 150 by Chromium's priority-aware LRU
--     with secure protection, measured; 3300 in all, purged to 3000);
--   * a page's runtime keeps the script-visible ones in memory (`Mem`),
--     given at load with the document (the snapshot) and kept current by
--     the channel — short-lived cookies of the browser's own jar:
--       - outbox: a script's writes, numbered by the writer (a page tree,
--         `tab`), packed into a few slots (`__crn~o!` tab "!" slot: records
--         of the one-write form below); they ride the very next request of
--         any kind, and the server applies each once (`applyOutbox`: a
--         number not above the last applied for its identity is ignored)
--         and answers with one ack (`__crn~a!` tab: the highest number it
--         read "!" the jar's generation then) — the writer's writes up to
--         it are in, as of that generation (`ack`);
--       - inbox (`__crn~i!` + scope): a change the server made to a
--         script-visible cookie (a response's Set-Cookie, an eviction) of
--         the requesting page's own site (`inboxFor`), keyed by identity,
--         numbered by the jar's generation and naming the last outbox
--         applied: every runtime absorbs it (`absorb`) — a write of its own
--         not yet acknowledged stands against it;
--   * the browser's own jar thus holds the session's cookies and a few
--     transient entries, never near its limit.
--
-- Times are microseconds after the epoch (Chromium's cookie clock: an
-- expiry by Max-Age keeps its creation's microseconds, and cookieStore's
-- `expires` reads them as a fraction of a ms — a jar of whole ms gave a
-- response's cookie a whole-ms `expires`, round J). The channel writes
-- an expiry in ms with that fraction (msText, msNum). Outside the model: the public-suffix
-- list (the caller gives each cookie's registrable domain), the strict
-- secure rule (an insecure page overwriting a Secure cookie), last-access
-- times of cookies a script reads (the runtime reads its memory: the
-- server sees sends and writes).
--
-- Implemented by go/src/internal/cookiejar and ts/client/src/cookies/jar.ts.
------------------------------------------------------------------------

module CookieJar where

open import Data.Bool.Base using (Bool; true; false; _∧_; _∨_; not; if_then_else_)
open import Data.Char.Base using (Char; toℕ; fromℕ)
open import Data.List.Base using (List; []; _∷_; _++_; reverse; length; filterᵇ; map)
open import Data.Maybe.Base using (Maybe; just; nothing)
open import Data.Nat.Base using (ℕ; zero; suc; _+_; _*_; _∸_; _<ᵇ_; _≤ᵇ_; _≡ᵇ_; _/_; _%_)
open import Data.Product.Base using (_×_; _,_; proj₁; proj₂)
open import Data.String.Base using (String; toList)

open import Url using (Str; Abs; is; isDigit; eqStr; break; isEmpty; pctDecode)
open import Data.Nat.Show using () renaming (show to showℕ)
open import Cookies
import CookieDate

------------------------------------------------------------------------
-- What a cookie is in the channel: set (until a time, or for the browser
-- session), or gone.

data Expiry : Set where
  session : Expiry
  until   : ℕ → Expiry

data Change : Set where
  put′ : Stored → Expiry → Change
  gone : Stored → Change        -- the identity it names; the rest unused

changed : Change → Stored
changed (put′ c _) = c
changed (gone c)   = c

-- The RFC's identity: name, domain, path, host-only.
sameId : Stored → Stored → Bool
sameId a b = eqStr (sName a) (sName b) ∧ eqStr (sDomain a) (sDomain b) ∧ eqStr (sPath a) (sPath b)
             ∧ (if sHostOnly a then sHostOnly b else not (sHostOnly b)) ∧ samePart (sPartition a) (sPartition b)
  where
  -- (and the partition: a Partitioned cookie of each context its own)
  samePart : Maybe Str → Maybe Str → Bool
  samePart nothing  nothing  = true
  samePart (just x) (just y) = eqStr x y
  samePart _        _        = false

alive : ℕ → Expiry → Bool
alive now session   = true
alive now (until t) = now <ᵇ t

-- Decimal digits, at least one.
natOf : Str → Maybe ℕ
natOf [] = nothing
natOf s  = if Url.all isDigit s then just (go s 0) else nothing
  where
  go : Str → ℕ → ℕ
  go []       n = n
  go (c ∷ cs) n = go cs (n * 10 + (toℕ c ∸ 48))

-- A time in µs as the channel writes it: ms, and when it has some its
-- microseconds as a fraction ("1795506438163.749", "….5"; JS reads the
-- same number Chromium gives).
msText : ℕ → Str
msText t = toList (showℕ (t / 1000)) ++ frac (t % 1000)
  where
  d : ℕ → Char
  d n = fromℕ (48 + n)
  trimZ : Str → Str
  trimZ s = reverse (dropZ (reverse s))
    where
    dropZ : Str → Str
    dropZ ('0' ∷ r) = dropZ r
    dropZ r = r
  frac : ℕ → Str
  frac zero = []
  frac f@(suc _) = '.' ∷ trimZ (d (f / 100) ∷ d ((f / 10) % 10) ∷ d (f % 10) ∷ [])

-- The channel's expiry read back: ms digits, then "." and one to three
-- digits of a fraction; in µs.
msNum : Str → Maybe ℕ
msNum s = byParts (break (is 46) s)
  where
  pad : Str → Maybe ℕ
  pad (a ∷ []) = natOf (a ∷ '0' ∷ '0' ∷ [])
  pad (a ∷ b ∷ []) = natOf (a ∷ b ∷ '0' ∷ [])
  pad (a ∷ b ∷ c ∷ []) = natOf (a ∷ b ∷ c ∷ [])
  pad _ = nothing
  both : Maybe ℕ → Maybe ℕ → Maybe ℕ
  both (just m) (just f) = just (m * 1000 + f)
  both _ _ = nothing
  byParts : Str × Str → Maybe ℕ
  byParts (m , []) = both (natOf m) (just 0)
  byParts (m , (_ ∷ f)) = both (natOf m) (pad f)

-- A Set-Cookie's expiry at `now` (µs), as Chromium: Max-Age (seconds;
-- zero or negative: already expired) before Expires (CookieDate, seconds;
-- a date not after now: already expired; none read: a session cookie),
-- either capped at 400 days; neither: a session cookie. nothing: already
-- expired (a deletion).
cap : ℕ
cap = 400 * 86400 * 1000000

expiryOf : ℕ → SetCookie → Maybe Expiry
expiryOf now sc = byMaxAge (maxAge sc)
  where
  capped : ℕ → ℕ
  capped t = if now + cap <ᵇ t then now + cap else t
  byExpires : Maybe Str → Maybe Expiry
  byExpires nothing  = just session
  byExpires (just d) = dated (CookieDate.cookieDate d)
    where
    dated : Maybe ℕ → Maybe Expiry
    dated nothing  = just session
    dated (just t) = if t * 1000000 ≤ᵇ now then nothing else just (until (capped (t * 1000000)))
  byMaxAge : Maybe Str → Maybe Expiry
  byMaxAge nothing         = byExpires (expires sc)
  byMaxAge (just [])       = byExpires (expires sc)
  byMaxAge (just (c ∷ cs)) = if is 45 c then nothing else positive (natOf (c ∷ cs))
    where
    positive : Maybe ℕ → Maybe Expiry
    positive (just zero)    = nothing
    positive (just (suc n)) = just (until (capped (now + suc n * 1000000)))
    positive nothing        = byExpires (expires sc)

------------------------------------------------------------------------
-- The channel's wire form.
--
--   name  = prefix (h|d) "!" esc(domain) "!" esc(path) "!" name
--   value = (s|i) (n|l|t|u) (L|M|H) "!" expiry "!" number ["!" applied] ":" value
--
-- expiry: "" for the browser session, "x" for gone, else decimal ms;
-- number: the writer's (outbox) or the jar's generation (inbox); applied
-- (inbox only): the last outbox number applied to this identity.

inboxPrefix outboxPrefix : Str
inboxPrefix  = toList "__crn~i!"
outboxPrefix = toList "__crn~o!"

scope : Stored → Str
scope c = part (sPartition c) ++ (if sHostOnly c then 'h' else 'd') ∷ bang ∷ esc (sDomain c) ++ bang ∷ esc (sPath c) ++ bang ∷ sName c
  where
  -- A Partitioned cookie's scope starts "p" and its partition key — beside
  -- an unpartitioned one of the same name. (A page's outbox is shared by
  -- its tree, of documents of other contexts: each write names its own.
  -- A document is told its context in its config.)
  part : Maybe Str → Str
  part nothing  = []
  part (just k) = 'p' ∷ esc k ++ bang ∷ []

prioFlag : Priority → Char
prioFlag pLow    = 'L'
prioFlag pMedium = 'M'
prioFlag pHigh   = 'H'

flagsOf : Stored → Str
flagsOf c = (if sSecure c then 's' else 'i') ∷ sameSiteFlag (sSameSite c) ∷ prioFlag (sPriority c) ∷ []

expiryText : Change → Str
expiryText (gone _)             = toList "x"
expiryText (put′ _ session)     = []
expiryText (put′ _ (until t))   = msText t

chanName : Bool → Change → Str
chanName inbox ch = (if inbox then inboxPrefix else outboxPrefix) ++ scope (changed ch)

chanValue : Change → ℕ → Maybe ℕ → Str
chanValue ch n applied =
  flagsOf (changed ch) ++ bang ∷ expiryText ch ++ bang ∷ toList (showℕ n) ++ appl applied ++ fromℕ 58 ∷ val ch
  where
  appl : Maybe ℕ → Str
  appl nothing  = []
  appl (just a) = bang ∷ toList (showℕ a)
  val : Change → Str
  val (put′ c _) = sValue c
  val (gone _)   = []

dropPrefix : Str → Str → Maybe Str
dropPrefix []       s        = just s
dropPrefix (_ ∷ _)  []       = nothing
dropPrefix (p ∷ ps) (c ∷ cs) = if is (toℕ p) c then dropPrefix ps cs else nothing

-- ["p"] (h|d) "!" domain "!" path "!" name
scopeOf : Str → Maybe (Bool × Str × Str × Str)
scopeOf (hd ∷ b ∷ r) =
  if is 33 b ∧ (is 104 hd ∨ is 100 hd) then afterDomain (break (is 33) r) else nothing
  where
  afterPath : Str → Str × Str → Maybe (Bool × Str × Str × Str)
  afterPath d (p , [])     = nothing
  afterPath d (p , _ ∷ nm) = just (is 104 hd , pctDecode d , pctDecode p , nm)
  afterDomain : Str × Str → Maybe (Bool × Str × Str × Str)
  afterDomain (d , [])     = nothing
  afterDomain (d , _ ∷ r2) = afterPath d (break (is 33) r2)
scopeOf _ = nothing

ssOf : Char → Maybe SameSite
ssOf c = if is 110 c then just ssNone else if is 108 c then just ssLax else if is 116 c then just ssStrict
         else if is 117 c then just ssDefault else nothing

ssOf′ : Str → Maybe SameSite
ssOf′ (c ∷ []) = ssOf c
ssOf′ _        = nothing

prOf : Char → Maybe Priority
prOf c = if is 76 c then just pLow else if is 77 c then just pMedium else if is 72 c then just pHigh else nothing

-- The expiry field (msNum); nothing: gone; one not that form: malformed.
expOf : Str → Maybe (Maybe Expiry)
expOf []       = just (just session)
expOf (x ∷ []) = if is 120 x then just nothing else bad (natOf (x ∷ []))
  where
  bad : Maybe ℕ → Maybe (Maybe Expiry)
  bad (just t) = just (just (until (t * 1000)))
  bad nothing  = nothing
expOf e = num (msNum e)
  where
  num : Maybe ℕ → Maybe (Maybe Expiry)
  num (just t) = just (just (until t))
  num nothing  = nothing

record ChanValue : Set where
  constructor mkCV
  field
    cvSecure   : Bool
    cvSameSite : SameSite
    cvPriority : Priority
    cvExpiry   : Maybe Expiry      -- nothing: gone
    cvNumber   : ℕ
    cvApplied  : Maybe ℕ
    cvValue    : Str
open ChanValue

-- flags "!" expiry "!" number ["!" applied] ":" value
valueOf : Str → Maybe ChanValue
valueOf (s ∷ ss ∷ pr ∷ b ∷ r) =
  if not (is 33 b) ∨ not (is 115 s ∨ is 105 s) then nothing
  else step1 (ssOf ss) (prOf pr) (break (is 33) r)
  where
  withNum : SameSite → Priority → Maybe (Maybe Expiry) → Maybe ℕ → Maybe ℕ → Bool → Str → Maybe ChanValue
  withNum sm p (just e) (just k) ap ok v = if ok then just (mkCV (is 115 s) sm p e k ap v) else nothing
  withNum _  _ _        _        _  _  _ = nothing
  step3 : SameSite → Priority → Str → Str × Str → Str → Maybe ChanValue
  step3 sm p e (num , [])     v = withNum sm p (expOf e) (natOf num) nothing true v
  step3 sm p e (num , _ ∷ ap) v = withNum sm p (expOf e) (natOf num) (natOf ap) (isJust (natOf ap)) v
    where
    isJust : Maybe ℕ → Bool
    isJust (just _) = true
    isJust nothing  = false
  step2 : SameSite → Priority → Str → Str × Str → Maybe ChanValue
  step2 sm p e (nums , [])     = nothing
  step2 sm p e (nums , _ ∷ v)  = step3 sm p e (break (is 33) nums) v
  step1 : Maybe SameSite → Maybe Priority → Str × Str → Maybe ChanValue
  step1 (just sm) (just p) (e , _ ∷ r2) = step2 sm p e (break (is 58) r2)
  step1 _         _        _            = nothing
valueOf _ = nothing

-- A channel entry read back: the change, its number, and (inbox) applied.
unchan : Bool → Str → Str → Maybe (Change × ℕ × Maybe ℕ)
unchan inbox n v = build (dropPrefix (if inbox then inboxPrefix else outboxPrefix) n)
  where
  isNothing : Maybe ℕ → Bool
  isNothing nothing  = true
  isNothing (just _) = false
  fromParts : Maybe Str → Maybe (Bool × Str × Str × Str) → Maybe ChanValue → Maybe (Change × ℕ × Maybe ℕ)
  fromParts pt (just (ho , d , p , nm)) (just cv) =
    if (inbox ∧ isNothing (cvApplied cv)) ∨ (not inbox ∧ not (isNothing (cvApplied cv))) then nothing
    else just (chg (cvExpiry cv) , cvNumber cv , cvApplied cv)
    where
    c : Stored
    c = mkStored ho d p nm (cvValue cv) (cvSecure cv) false (cvSameSite cv) (cvPriority cv) pt
    chg : Maybe Expiry → Change
    chg nothing  = gone c
    chg (just e) = put′ c e
  fromParts _ _ _ = nothing
  build : Maybe Str → Maybe (Change × ℕ × Maybe ℕ)
  build nothing         = nothing
  build (just [])       = nothing
  build (just (x ∷ sc)) = if is 112 x then keyed (break (is 33) sc) else fromParts nothing (scopeOf (x ∷ sc)) (valueOf v)
    where
    keyed : Str × Str → Maybe (Change × ℕ × Maybe ℕ)
    keyed (k , [])     = nothing
    keyed (k , _ ∷ r)  = fromParts (just (pctDecode k)) (scopeOf r) (valueOf v)

------------------------------------------------------------------------
-- The outbox, packed. A slot's value is records joined by "~", a record a
-- one-write outbox entry's name and value joined by "*", each with "%",
-- "~" and "*" percent-encoded (nothing else: a record is made of cookie
-- characters already). A burst of writes (a page setting a hundred cookies
-- in a loop) is a few slots, never a hundred cookies in the browser's jar.

ackPrefix : Str
ackPrefix = toList "__crn~a!"

sepEsc : Str → Str
sepEsc []       = []
sepEsc (c ∷ cs) =
  if is 37 c then toList "%25" ++ sepEsc cs
  else if is 126 c then toList "%7E" ++ sepEsc cs
  else if is 42 c then toList "%2A" ++ sepEsc cs
  else c ∷ sepEsc cs

sepUnesc : Str → Str
sepUnesc (p ∷ a ∷ b ∷ cs) =
  if is 37 p ∧ is 50 a ∧ is 53 b then fromℕ 37 ∷ sepUnesc cs
  else if is 37 p ∧ is 55 a ∧ (is 69 b ∨ is 101 b) then fromℕ 126 ∷ sepUnesc cs
  else if is 37 p ∧ is 50 a ∧ (is 65 b ∨ is 97 b) then fromℕ 42 ∷ sepUnesc cs
  else p ∷ sepUnesc (a ∷ b ∷ cs)
sepUnesc cs = cs

packRecord : Str × Str → Str
packRecord (n , v) = sepEsc n ++ fromℕ 42 ∷ sepEsc v

packSlot : List (Str × Str) → Str
packSlot []       = []
packSlot (r ∷ []) = packRecord r
packSlot (r ∷ rs) = packRecord r ++ fromℕ 126 ∷ packSlot rs

unpackSlot : Str → List (Str × Str)
unpackSlot s = recs (Url.splitOn (is 126) s)
  where
  one : Str → Str × Str
  one r with break (is 42) r
  ... | n , []    = (sepUnesc n , [])
  ... | n , _ ∷ v = (sepUnesc n , sepUnesc v)
  recs : List Str → List (Str × Str)
  recs []       = []
  recs (r ∷ rs) = one r ∷ recs rs

-- The outbox writes a request carries: every record of every slot, read.
outboxOf : List (Str × Str) → List (Change × ℕ)
outboxOf []             = []
outboxOf ((n , v) ∷ ps) with dropPrefix outboxPrefix n
... | nothing = outboxOf ps
... | just _  = records (unpackSlot v) ++ outboxOf ps
  where
  records : List (Str × Str) → List (Change × ℕ)
  records []               = []
  records ((rn , rv) ∷ rs) with unchan false rn rv
  ... | just (ch , k , nothing) = (ch , k) ∷ records rs
  ... | _ = records rs

-- The ack for a writer: the highest number its slots carried.
ackOf : List (Change × ℕ) → ℕ
ackOf []             = 0
ackOf ((_ , k) ∷ ws) = maxN k (ackOf ws)
  where
  maxN : ℕ → ℕ → ℕ
  maxN a b = if a <ᵇ b then b else a

-- Which changes the browser is told as inbox entries: those of the
-- requesting page's own site; with no page known (a blob worker's fetch
-- names none), or on a document's own response (a download, a frame sent
-- to a JSON answer: no snapshot comes with it), those of the response's
-- own site. Other runtimes of the session are given the jar with their
-- next document; so the inbox stays a few entries. (round H: a hidden
-- frame's download, jQuery fileDownload, never showed its cookie.)
inboxFor : Bool → Maybe Str → Str → Str → Bool
inboxFor document (just requester) target site = if document then eqStr target site else eqStr requester site
inboxFor document nothing          target site = eqStr target site

------------------------------------------------------------------------
-- The server's jar: a session's cookies, in creation order.

record Entry : Set where
  constructor mkEntry
  field
    eCookie   : Stored
    eExpiry   : Expiry
    eSite     : Str        -- registrable domain (or the host): the 180's key
    eCreated  : ℕ
    eAccessed : ℕ          -- ms: the once-a-minute threshold
    eOrder    : ℕ          -- the jar's tick at the last access: the LRU order
open Entry public

record Jar : Set where
  constructor mkJar
  field
    entries : List Entry
    gen     : ℕ                    -- script-visible changes so far
    applied : List (Str × ℕ)       -- scope → the last outbox number applied
    tick    : ℕ                    -- one more at every write and access:
                                   -- Chromium orders by access time (µs), never equal
open Jar public

emptyJar : Jar
emptyJar = mkJar [] 0 [] 0

-- Chromium's limits (net/cookies/cookie_monster.h; measured).
domainMax domainKeep totalMax totalKeep : ℕ
domainMax = 180
domainKeep = 150
totalMax = 3300
totalKeep = 3000

quotaOf : Priority → ℕ
quotaOf pLow    = 30
quotaOf pMedium = 50
quotaOf pHigh   = 70

samePrio : Priority → Priority → Bool
samePrio pLow pLow = true
samePrio pMedium pMedium = true
samePrio pHigh pHigh = true
samePrio _ _ = false

count : (Entry → Bool) → List Entry → ℕ
count p []       = 0
count p (e ∷ es) = (if p e then 1 else 0) + count p es

-- Stable sort by last access, least recent first (creation order kept).
byAccess : List Entry → List Entry
byAccess []       = []
byAccess (e ∷ es) = ins e (byAccess es)
  where
  ins : Entry → List Entry → List Entry
  ins x []       = x ∷ []
  ins x (y ∷ ys) = if eOrder y <ᵇ eOrder x then y ∷ ins x ys else x ∷ y ∷ ys

-- Chromium's PurgeLeastRecentMatches: in the round for `prio`, keep the
-- quota (and, protecting secure ones, every secure one); remove the least
-- recently accessed eligible ones up to `goal`. Gives the remaining
-- (in access order), the removed, and how many.
purgeRound : Priority → Bool → ℕ → List Entry → List Entry × List Entry × ℕ
purgeRound prio protect goal es =
  if total ≤ᵇ quotaOf prio then (es , [] , 0)
  else walk es (possible) goal
  where
  ofPrio : Entry → Bool
  ofPrio e = samePrio (sPriority (eCookie e)) prio
  total : ℕ
  total = count ofPrio es
  secureN : ℕ
  secureN = count (λ e → ofPrio e ∧ sSecure (eCookie e)) es
  maxN : ℕ → ℕ → ℕ
  maxN a b = if a <ᵇ b then b else a
  possible : ℕ
  possible = if protect then total ∸ maxN secureN (quotaOf prio) else total ∸ quotaOf prio
  eligible : Entry → Bool
  eligible e = ofPrio e ∧ (not protect ∨ not (sSecure (eCookie e)))
  walk : List Entry → ℕ → ℕ → List Entry × List Entry × ℕ
  walk []       _       _        = ([] , [] , 0)
  walk (e ∷ r)  zero    _        = (e ∷ r , [] , 0)
  walk (e ∷ r)  _       zero     = (e ∷ r , [] , 0)
  walk (e ∷ r)  (suc p) (suc g)  with eligible e
  ... | true  with walk r p g
  ...   | (keep , out , n) = (keep , e ∷ out , suc n)
  walk (e ∷ r)  (suc p) (suc g) | false with walk r (suc p) (suc g)
  ...   | (keep , out , n) = (e ∷ keep , out , n)

rounds : List (Priority × Bool)
rounds = (pLow , true) ∷ (pLow , false) ∷ (pMedium , true) ∷ (pHigh , true) ∷ (pMedium , false) ∷ (pHigh , false) ∷ []

purgeSite : ℕ → List Entry → List Entry × List Entry
purgeSite goal es = go rounds goal (byAccess es)
  where
  go : List (Priority × Bool) → ℕ → List Entry → List Entry × List Entry
  go []                _    r = (r , [])
  go _                 zero r = (r , [])
  go ((p , s) ∷ more) g    r with purgeRound p s g r
  ... | (keep , out , n) with go more (g ∸ n) keep
  ...   | (keep′ , out′) = (keep′ , out ++ out′)

-- Keep `es` in its own (creation) order but without the removed.
without : List Entry → List Entry → List Entry
without es out = filterᵇ (λ e → not (member e out)) es
  where
  member : Entry → List Entry → Bool
  member e []       = false
  member e (x ∷ xs) = sameId (eCookie e) (eCookie x) ∨ member e xs

-- The global limit: least recently accessed first, insecure ones before
-- secure (Chromium's GarbageCollectLeastRecentlyAccessed).
purgeTotal : ℕ → List Entry → List Entry
purgeTotal goal es = take′ goal (filterᵇ (λ e → not (sSecure (eCookie e))) sorted ++ filterᵇ (λ e → sSecure (eCookie e)) sorted)
  where
  sorted : List Entry
  sorted = byAccess es
  take′ : ℕ → List Entry → List Entry
  take′ zero    _        = []
  take′ (suc n) []       = []
  take′ (suc n) (x ∷ xs) = x ∷ take′ n xs

-- After a cookie of `site` was stored at `now`: the expired dropped, the
-- site's and the session's limits applied. Gives the jar's entries and the
-- removed ones (an eviction of a script-visible cookie is a change scripts
-- see).
evict : ℕ → Str → List Entry → List Entry × List Entry
evict now site es0 = afterTotal
  where
  es : List Entry
  es = filterᵇ (λ e → alive now (eExpiry e)) es0
  expired : List Entry
  expired = filterᵇ (λ e → not (alive now (eExpiry e))) es0
  ofSite : Entry → Bool
  ofSite e = eqStr (eSite e) site
  n : ℕ
  n = count ofSite es
  afterSite : List Entry × List Entry
  afterSite = if domainMax <ᵇ n then purged (purgeSite (n ∸ domainKeep) (filterᵇ ofSite es)) else (es , [])
    where
    purged : List Entry × List Entry → List Entry × List Entry
    purged (_ , out) = (without es out , out)
  afterTotal : List Entry × List Entry
  afterTotal with afterSite
  ... | (kept , out) =
    if totalMax <ᵇ length kept then (without kept (purgeTotal (length kept ∸ totalKeep) kept) , out ++ expired ++ purgeTotal (length kept ∸ totalKeep) kept)
    else (kept , out ++ expired)

------------------------------------------------------------------------
-- Storing a cookie in the jar. `api`: from a script (an outbox); an
-- HttpOnly cookie of the same identity then stands (RFC 6265bis §5.7).
-- Gives the jar and the changes scripts see (for the inbox), each with
-- the generation it is.

visible : Stored → Bool
visible c = not (sHttpOnly c)

findLive : ℕ → Stored → List Entry → Maybe Entry
findLive now c []       = nothing
findLive now c (e ∷ es) = if sameId (eCookie e) c ∧ alive now (eExpiry e) then just e else findLive now c es

-- An overwrite keeps the old cookie's creation (its place in the creation
-- order) when the value is the same, attributes aside; with another value
-- it is a new cookie, created now (Chromium, measured: a=1, b=1, a=2 lists
-- b=1; a=2 — the same value lists a=1; b=1).
replaceOrAdd : Entry → List Entry → List Entry
replaceOrAdd x es = go es
  where
  go : List Entry → List Entry
  go []       = x ∷ []
  go (e ∷ r) =
    if sameId (eCookie e) (eCookie x) then
      (if eqStr (sValue (eCookie e)) (sValue (eCookie x)) then record x { eCreated = eCreated e } ∷ r else r ++ x ∷ [])
    else e ∷ go r

drop′ : Stored → List Entry → List Entry
drop′ c = filterᵇ (λ e → not (sameId (eCookie e) c))

-- Changes numbered from the jar's generation on.
numbered : ℕ → List Change → List (Change × ℕ) × ℕ
numbered g []       = ([] , g)
numbered g (c ∷ cs) with numbered (suc g) cs
... | (rest , g′) = ((c , suc g) ∷ rest , g′)

-- Storing `ch` given the live cookie of its identity, if any.
storeWith : ℕ → Str → Change → Jar → Maybe Entry → Jar × List (Change × ℕ)
storeWith now site ch j old = finish (storedAs ch)
  where
  wasVisible : Bool
  wasVisible = vis old
    where
    vis : Maybe Entry → Bool
    vis (just e) = visible (eCookie e)
    vis nothing  = false
  storedAs : Change → List Entry × List Change
  storedAs (gone c) = (drop′ c (entries j) , (if wasVisible then gone c ∷ [] else []))
  storedAs (put′ c e) =
    if not (alive now e) then (drop′ c (entries j) , (if wasVisible then gone c ∷ [] else []))
    else (replaceOrAdd (mkEntry c e site now now (suc (tick j))) (entries j) ,
          (if visible c then put′ c e ∷ [] else if wasVisible then gone c ∷ [] else []))
  withNumbers : List Entry → List (Change × ℕ) × ℕ → Jar × List (Change × ℕ)
  withNumbers kept (nums , g′) = (record j { entries = kept ; gen = g′ ; tick = suc (tick j) } , nums)
  afterEvict : List Change → List Entry × List Entry → Jar × List (Change × ℕ)
  afterEvict chs (kept , out) =
    withNumbers kept (numbered (gen j) (chs ++ map (λ e → gone (eCookie e)) (filterᵇ (λ e → visible (eCookie e)) out)))
  finish : List Entry × List Change → Jar × List (Change × ℕ)
  finish (es , chs) = afterEvict chs (evict now site es)

put : Bool → ℕ → Str → Change → Jar → Jar × List (Change × ℕ)
put api now site ch j = byOld (findLive now (changed ch) (entries j))
  where
  byOld : Maybe Entry → Jar × List (Change × ℕ)
  byOld (just old) = if api ∧ sHttpOnly (eCookie old) then (j , []) else storeWith now site ch j (just old)
  byOld nothing    = storeWith now site ch j nothing

-- An outbox entry, numbered k by its writer: applied once, in order —
-- one numbered no higher than the last applied for its identity is
-- ignored.
lastApplied : Str → List (Str × ℕ) → ℕ
lastApplied s []             = 0
lastApplied s ((t , k) ∷ ts) = if eqStr s t then k else lastApplied s ts

setApplied : Str → ℕ → List (Str × ℕ) → List (Str × ℕ)
setApplied s k []             = (s , k) ∷ []
setApplied s k ((t , m) ∷ ts) = if eqStr s t then (s , k) ∷ ts else (t , m) ∷ setApplied s k ts

applyOutbox : ℕ → Str → Change → ℕ → Jar → Jar × List (Change × ℕ)
applyOutbox now site ch k j =
  if k ≤ᵇ lastApplied (scope (changed ch)) (applied j) then (j , [])
  else withApplied (put true now site ch j)
  where
  withApplied : Jar × List (Change × ℕ) → Jar × List (Change × ℕ)
  withApplied (j′ , chs) = (record j′ { applied = setApplied (scope (changed ch)) k (applied j′) } , chs)

-- Chromium updates a cookie's last access when it is used, at most once
-- a minute (kLastAccessThreshold: 60 000 ms).
touch : ℕ → (Stored → Bool) → Jar → Jar
touch now used j = go (entries j) (tick j) []
  where
  -- Each cookie used takes the next tick, in the jar's order.
  go : List Entry → ℕ → List Entry → Jar
  go []       k acc = record j { entries = reverse acc ; tick = k }
  go (e ∷ es) k acc =
    if used (eCookie e) ∧ (eAccessed e + 60000000 ≤ᵇ now) then go es (suc k) (record e { eAccessed = now ; eOrder = suc k } ∷ acc)
    else go es k (e ∷ acc)

-- What the browser session's end does: session cookies are gone.
endSession : Jar → Jar
endSession j = record j { entries = filterᵇ (λ e → keepIt (eExpiry e)) (entries j) }
  where
  keepIt : Expiry → Bool
  keepIt session   = false
  keepIt (until _) = true

------------------------------------------------------------------------
-- A runtime's memory: the script-visible cookies it knows, each with the
-- generation it reflects and its own write not yet applied (pending).

record Known : Set where
  constructor mkKnown
  field
    kChange  : Change
    kGen     : ℕ
    kPending : Maybe ℕ
open Known public

Mem : Set
Mem = List Known

-- An inbox entry (or one of the snapshot's): a change of generation g,
-- the last outbox applied to its identity a. A pending write of this
-- runtime stands until the server has applied it (a ≥ its number).
-- Memory's order is the creation order (document.cookie lists by it among
-- equal paths): a change keeps a cookie's place when its value stays,
-- else it is a new cookie, last.
sameValue : Change → Change → Bool
sameValue (put′ a _) (put′ b _) = eqStr (sValue a) (sValue b)
sameValue _          _          = false

placed : Known → List Known → Known → List Known
placed old rest new = if sameValue (kChange old) (kChange new) then new ∷ rest else rest ++ new ∷ []

absorb : Change → ℕ → ℕ → Mem → Mem
absorb ch g a []       = mkKnown ch g nothing ∷ []
absorb ch g a (k ∷ ks) =
  if sameId (changed (kChange k)) (changed ch) then (if takes (kPending k) then placed k ks (mkKnown ch g nothing) else k ∷ ks)
  else k ∷ absorb ch g a ks
  where
  takes : Maybe ℕ → Bool
  takes (just p) = p ≤ᵇ a
  takes nothing  = kGen k <ᵇ g

-- A script's own write, numbered p.
write : Change → ℕ → Mem → Mem
write ch p []       = mkKnown ch 0 (just p) ∷ []
write ch p (k ∷ ks) =
  if sameId (changed (kChange k)) (changed ch) then placed k ks (mkKnown ch (kGen k) (just p))
  else k ∷ write ch p ks

-- The server's ack: this runtime's writes numbered up to a are in, and
-- the jar was then of generation g — what they are as of. (They stood at
-- generation 0: a frame's snapshot made before the server had them, given
-- later, took them for gone — nfl.com's consent and analytics cookies
-- vanished at once, 3 s into the load.)
ack : ℕ → ℕ → Mem → Mem
ack a g []       = []
ack a g (k ∷ ks) = resolve (kPending k) ∷ ack a g ks
  where
  maxN : ℕ → ℕ → ℕ
  maxN x y = if x <ᵇ y then y else x
  resolve : Maybe ℕ → Known
  resolve (just p) = if p ≤ᵇ a then record k { kPending = nothing ; kGen = maxN (kGen k) g } else k
  resolve nothing  = k

-- What a script reads: the live cookies.
liveOf : ℕ → Mem → List Stored
liveOf now []       = []
liveOf now (mkKnown (put′ c e) _ _ ∷ ks) = if alive now e then c ∷ liveOf now ks else liveOf now ks
liveOf now (mkKnown (gone _) _ _ ∷ ks)   = liveOf now ks

-- What a context lists of the tree's memory (Cookies.inCtx; nothing: any).
shownIn : Maybe CookieCtx → Stored → Bool
shownIn nothing  c = true
shownIn (just x) c = inCtx true x c

-- document.cookie at u, in its document's context (a tree's memory holds
-- its documents' cookies, of other contexts too).
memCookies : Maybe CookieCtx → ℕ → Abs → Mem → Str
memCookies x now u m = cookieString (byPathLength (filterᵇ (shownIn x) (keep true u (liveOf now m))))

-- The snapshot a document comes with, of generation g, for its URL u:
-- its entries absorbed; a cookie known for u that it lacks and that no
-- write of this runtime holds is gone as of g.
-- (Only what its context lists: the others the snapshot never held.)
snapshot : Maybe CookieCtx → Abs → ℕ → List (Change × ℕ × ℕ) → Mem → Mem
snapshot x u g es m = absorbAll es (map stale m)
  where
  listed : Stored → List (Change × ℕ × ℕ) → Bool
  listed c []                 = false
  listed c ((ch , _ , _) ∷ r) = sameId (changed ch) c ∨ listed c r
  stale : Known → Known
  stale (mkKnown (put′ c e) k nothing) =
    if matches true u c ∧ shownIn x c ∧ (k ≤ᵇ g) ∧ not (listed c es) then mkKnown (gone c) g nothing else mkKnown (put′ c e) k nothing
  stale k = k
  absorbAll : List (Change × ℕ × ℕ) → Mem → Mem
  absorbAll []                   m′ = m′
  absorbAll ((ch , k , a) ∷ r)   m′ = absorbAll r (absorb ch k a m′)
