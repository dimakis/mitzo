# Reviewed context forwarding

The shared composer's existing context review now offers an explicit context-only
forward. Users select exact source messages and saved artifact versions, inspect
the frozen contents and recipient list, prepare the request, then confirm it.
The reviewed brief accompanies the material. Forwarding does not send the current
prompt or start an ordinary model turn; recipients receive the material before
their next explicitly requested turn.

The browser retains selectors, hashes and original request identities, never the
source or artifact contents. Preparation and confirmation identities are saved
before their respective requests. A lost confirmation remains fenced until a
read of the original preparation establishes its result. Remount and login changes
do not replay a POST. Confirmation requires the exact inspected selection, note,
recipients and membership; the existing server renews authority and settings.
Clearing accepted composer text and collection discard preserve the recovery
receipt until the forwarding surface explicitly dismisses it.

The real application journey covers the production React surface, authenticated
application owner, exact Unicode/whitespace artifact bytes, response loss after
durable confirmation, remount/read recovery, no duplicate forward and a later
explicit prompt through the synthetic external native transport. Existing server
coverage retains independently saved older-artifact and process-restart delivery.

Validation before publication: 31 focused context/forwarding tests passed; a
subsequent draft-recovery run passed 66 tests (overlapping the six forwarding
hook cases). Design checks passed 109 with one existing skip. Scoped lint, format
and source fingerprints passed. Local full frontend compilation exceeded the
required 1 GiB heap limit. Local browser fixtures were blocked before page startup
by host sandbox restrictions; hosted compile/browser validation and inspection of
retained mobile/desktop light/dark screenshots remain required.

The UI reuses HomeDialog, the existing review disclosure, frozen-artifact preview,
recipient display and shared context controls. No palette, type, spacing or motion
override was introduced. The offline fixture checks 320px mobile and desktop,
light/dark themes, alternate accents/fonts, focus restoration, touch targets,
scroll bounds and the independent explicit prompt. CI retains its forwarding
review screenshots. This is implementation evidence, not a new approved design.

This surface selects context from the current source discussion into its shared
conversation. It does not add a cross-conversation chooser or a separate Telos
artifact picker. API coverage of independently retained artifacts does not prove
those additional UI journeys. Live account/device qualification and production
activation remain separate and are not established here.
