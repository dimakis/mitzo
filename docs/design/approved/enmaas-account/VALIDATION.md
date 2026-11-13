# EnMaaS account setup

Approved by Dimitri on 12 November 2026 in conversation
`f12e56c7-5123-8fd8-8ee4-3fabf11dd202`: “Yep this is it. Build this and merge the pr”.
The retained [v003 reference](setup.html) includes his preceding instruction:
“I should have the ability to select or hide models from the picker in the settings if I want to.”

Reuse Connections labelled form controls and quiet sections, MotionDetails,
HomeDialog, semantic tokens, and the shared account/model picker. Keep the
approved Chat settings hierarchy; model visibility is a utility inside the
existing model editor, not another top-level settings row.

The source implements automatic catalog discovery, the hosted-model fallback,
Messages x-api-key authentication, saved-key refresh, account-scoped browser
visibility preferences and an unsent Local Mac chat draft. Catalog and save
failures remain distinct. No live inference is used for setup or tests.

Focused component, transport/router/database and design checks are local
verification. The browser fixture covers the actual Connections route on phone
and desktop, both themes and alternate fonts/accents, 44px controls, visibility,
refresh/reload, focus, bounds and screenshots. Local WebKit startup previously
timed out; fresh implementation captures and required CI must be checked before
landing. Source approval, merge and production activation remain distinct.
