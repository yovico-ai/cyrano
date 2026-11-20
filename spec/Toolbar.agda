{-# OPTIONS --safe #-}
------------------------------------------------------------------------
-- The portal toolbar: the small control every WebVPN shows over a proxied
-- page — back to the portal's main page, and a grip to slide it along
-- the top edge (TS: ts/client/src/ui/toolbar.ts).
--
-- The page cannot tell it is there. It is no node of the page's DOM: it
-- lives in a closed shadow root on <body> (whose own content shows
-- through a slot), is out of flow (position: fixed) and takes no pointer
-- events — hit tests, hover and event targets are the page's own
-- elements. The runtime instead takes the user's pointer events at the
-- window, first in line, by coordinates: those inside the toolbar's box
-- (`region`), and every one of a drag in progress, never reach a page
-- listener. Checked against Chromium (toolbar-vs-chromium): node counts,
-- serialization, layout, hit tests as on the page without it.
--
-- What is specified here is its geometry, in CSS pixels: the box is
-- `width` wide and `height` high, at the top edge, its left edge at
-- `left`; from the left: the grip (`gripW` pixels), the jump to the left
-- end ("<<", `jumpW`), the home button, the jump to the right end (">>",
-- the last `jumpW` pixels).
--
-- The cursor over it — it takes no pointer events, so the element under
-- it would give its own — is set on the shadow host while the pointer is
-- inside the box, and inherited by what lies beneath (`cursorOver`).
------------------------------------------------------------------------
module Toolbar where

open import Data.Bool.Base using (Bool; true; false; _∧_; if_then_else_)
open import Data.Nat.Base using (ℕ; _+_; _∸_; _<ᵇ_; _≤ᵇ_; _⊓_)
open import Data.Nat.DivMod using (_/_)

-- Where a drag puts the left edge: the box follows the pointer by the
-- point it was taken at, and stays within the viewport (at 0 when the
-- viewport is narrower than the box).
--   vw: the viewport's width; start: the left edge when the drag began;
--   grab: the pointer's x then; now: the pointer's x.
dragLeft : ℕ → ℕ → ℕ → ℕ → ℕ → ℕ
dragLeft vw width start grab now = ((start + now) ∸ grab) ⊓ (vw ∸ width)

-- Where it starts when no position is remembered: the middle of the top
-- edge (a site's logo and menus sit at the corners).
initialLeft : ℕ → ℕ → ℕ
initialLeft vw width = (vw ∸ width) / 2

-- A remembered position, put back into a viewport of another width.
placeLeft : ℕ → ℕ → ℕ → ℕ
placeLeft vw width left = left ⊓ (vw ∸ width)

-- The ends of the top edge, where "<<" and ">>" put it.
leftEnd : ℕ
leftEnd = 0

rightEnd : ℕ → ℕ → ℕ
rightEnd vw width = vw ∸ width

data Region : Set where
  outside grip toLeft home toRight : Region

-- What a point of the viewport hits.
region : ℕ → ℕ → ℕ → ℕ → ℕ → ℕ → ℕ → Region
region left width height gripW jumpW x y =
  if (left ≤ᵇ x) ∧ (x <ᵇ left + width) ∧ (y <ᵇ height)
  then (if x <ᵇ left + gripW then grip
        else if x <ᵇ left + gripW + jumpW then toLeft
        else if (left + width) ∸ jumpW ≤ᵇ x then toRight
        else home)
  else outside

-- The cursor while the pointer is over a region (CSS cursor keywords):
-- the grip is taken hold of — and held during a drag, wherever the
-- pointer is — the buttons are pressed; outside, the page's own.
data Cursor : Set where
  pagesOwn grab grabbing pointer : Cursor

cursorOver : Bool → Region → Cursor
cursorOver true  _       = grabbing
cursorOver false outside = pagesOwn
cursorOver false grip    = grab
cursorOver false _       = pointer
