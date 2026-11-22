{-# OPTIONS --safe #-}
-- The Payment Request API (TypeScript: ts/client/src/patches/payment-request.ts).
--
-- For a URL-based payment method identifier ("https://google.com/pay"),
-- Chrome itself fetches the method's manifest and the payment app's —
-- when the PaymentRequest is constructed (measured), outside any page,
-- straight to the payment provider (Stripe's Google Pay frames on
-- kenhub.com, modernhealthcare.com fetched gstatic's
-- transparent_square.svg off the proxy). It could not work proxied
-- either: the payment's origin would be the proxy's. Such a method is
-- answered as one with no payment app, as FedCM is refused (fedcm.ts):
-- the request is constructed with an identifier Chrome cannot resolve in
-- its place (nothing is fetched); canMakePayment() answers false, show()
-- rejects with NotSupportedError, its message naming the page's own
-- identifier. Known differences: directly, Chrome answers canMakePayment()
-- true for Google Pay (its app can be installed just in time); for a
-- method whose manifest cannot be had, show()'s message goes on with why
-- ("Unable to download payment manifest …"), which proxied it does not.
--
-- Refused: an identifier that parses as an absolute URL of the https
-- scheme (a URL-based payment method identifier). Standardized ones
-- ("basic-card", "secure-payment-confirmation") stay the browser's.
module Payment where

open import Data.Bool.Base using (Bool; true; false)
open import Data.Maybe.Base using (Maybe; just; nothing)

open import Url using (Str; parse; preprocess; Parsed; url; otherScheme; invalid; outside; scheme)
open import Scheme using (Scheme; https)

isHttps : Scheme → Bool
isHttps https = true
isHttps _     = false

-- nothing: outside the URL model (the spec does not decide).
refused : Str → Maybe Bool
refused s with parse nothing (preprocess s)
... | url a       = just (isHttps (scheme a))
... | otherScheme = just false
... | invalid     = just false
... | outside     = nothing
