# Canonical shared discussion identity — S9

Requested by Dimitri in ordinary contributor chat
`fef5d7f1-d637-8d8b-bee9-d39b84ff0417`: “compact persistent Symposium · N agents
header label on phone/desktop opening the existing Agents panel, plus Chats list
marker/participant information and navigation back to the exact original shared
discussion/history.” No Telos assignment or deployment is claimed.

Base: `9fa5d6fa6da8bfd0e54b8cb544b4f4329342bd76` from freshly acquired `main`.
Branch: `feat/symposium-chat-identity`. No prerequisite PR is required.

## Boundary and implementation

- `Session.sharedConversation` is read-only canonical discussion identity and
  current membership, including unavailable members. The existing list grouping
  scan supplies it before pagination. Prepared singletons have no marker; a
  prior shared discussion retains identity after removal and restart.
- Navigation still uses the exact source row. Shared membership supplies no
  transcript or execution authority. Ambiguous or unverified origin records keep
  their independent navigation. Search still opens its exact participant match.
- `SharedConversationAgents` passes the canonical identity to the existing
  `ConversationAgents` trigger. It preserves the same Agents panel, focus and
  callbacks; there is no second open-state owner. S7 agreed the additive
  `sharedIdentity` prop slot. S7's panel/Details/status changes remain independent.
- The shared list marker is used by Chats, sidebar, tree and preview. It uses
  existing metadata rows and semantic tokens. Loading, failed refresh and
  unavailable membership remain explicit. The composer/title/navigation owners
  and S1/S5 history/authorship work are preserved.
- Inspected #1421 at `002f2453d65623453072edcc509e706dc247ad53` (open draft on
  21 November): no changes to its ordinary admission indexes or runtime metadata
  adapter. One existing membership scan supplies list grouping and identity;
  there are no per-row conversation view or full transcript reads for badges.

## Evidence and limits

Observed failing before implementation: the server grouping adapter omitted
canonical shared identity, the existing header lacked the requested label, and
the list consumer could not identify a shared row. The corresponding regressions
pass after the implementation.

Focused checks cover canonical summary/restart/roster changes, unavailable
members, no transcript reads, cached and full HTTP adapters, same-title row
navigation on phone/desktop, exact participant-history search, loading and stale
header state, the existing Agents dialog, retained composer, and reopening without
beginning another discussion or sending a prompt. Shared package compilation and
design checks pass (one pre-existing design test is skipped). The focused files
contain 427 passing tests in total, including 109 design checks. One cached-list
test initially hit its 5-second timeout during module imports; the complete
31-test file passed with a 15-second runner timeout, without changing the test.

The offline ordinary-surface fixture now asserts the label, single Agents panel,
keyboard focus restoration and 44px in-bounds header controls at phone/desktop
widths, enlarged text and both themes. The session-library fixture also checks
the shared marker and unavailable count in list/tree consumers. Browser test
discovery succeeds. Local Chromium startup was blocked by a
missing installation. Installing the browser inside the admitted task failed
because the download server closed the connection. No local rendered result or
screenshot acceptance is claimed. CI must run the updated browser fixtures and
full application checks; physical mobile, live runtime and deployment acceptance
remain separate.

An Astra planner consultation was attempted using SymposiumConsult request
`a6e5085b-5b89-4bf3-8452-2559950c4d9f`; preparation failed and the original read/recover
receipt remains uncertain, with no contribution or allocated specialist session.
Implementation and local verification were performed in this ordinary Astra chat.
No independent review is claimed. Final exact-head CI/Centaur gates remain required
before any separately authorized merge.

## Review follow-up on #1435

Baseline: `854bb33eb7107062fd01d9f92451f333a3a4b798`. Centaur review
`6007902073` identified `CEN-E98D479B0BD2`: the phone stylesheet hid the
loading/stale membership qualification. The compact ordinary subtitle rule now
excludes shared identity. The ordinary-surface fixture checks visible loading and
failed-refresh qualifications after reopening, retained membership count and
in-bounds touch targets at 320/390/1280px with enlarged text in both themes.
This preserves the existing S7 trigger and panel owner.

CI run `44944930957` also found that the additive list assertions changed the
fingerprinted `session-library.spec.ts` design contract. That fixture is restored
byte-for-byte to the base. New list/tree marker, unavailable-member, exact source
navigation and no badge transcript-read checks now live in the separate
`session-library-shared-identity.spec.ts`, reusing the same production fixture.
No ledger, reference or protected hash is changed. The earlier local design pass
did not validate the final fixture edit; CI exposed that validation gap.

Follow-up local checks: 131 tests passed, including the restored design protection
(one existing CI-only check skipped). Both browser specs discover successfully.
Chromium installation again failed when the CDN closed the download connection;
no local browser rendering is claimed. Baseline hosted browser jobs all passed,
but the new visibility assertions still require hosted execution. Unit shard 3/4
includes the failing design-protection test; its full failure log remains
unavailable through the approved log transport, so no claim is made that this was
its only failure. Exact-head CI and Centaur delta verification remain merge gates.

The original optional specialist request was stopped before publication, with no
allocated session or attributed contribution. The Centaur baseline above is the
completed review being retained for follow-up; no duplicate full review is requested.
