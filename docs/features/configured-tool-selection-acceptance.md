# Configured tool selection: Phase 2 acceptance

Telos phase `fe020c5eb8557e9a`, parent `a27aa207cce82024`. Work began from
accepted `f995c9d5`; accepted compact-card redesign #960 (`405b0192`) is preserved. Accepted main
`41c4b051` also includes #962 and #973; their sources and manifest entries are preserved.
This is source implementation evidence. No live route is qualified or activated.
Phase 1's separately authorized live qualification remains outstanding.

## Review slices

1. [Identity/schema/discovery #965](https://github.com/dimakis/mitzo/pull/965):
   source-scoped references, private immutable receipts, configured stdio lifecycle,
   full descriptor/launch binding, bounded pagination and source-count admission.
2. [Admission/dispatch/cold resume #966](https://github.com/dimakis/mitzo/pull/966):
   exact local API exposure, selected-peer dispatch, current authority and pinned
   source launch context; private continuation mappings and drift refusal.
3. [Library/editor #968](https://github.com/dimakis/mitzo/pull/968): explicit
   cancellable operator refresh over retained-owner IPC, saved read projections,
   compact cards, source distinctions, exact receipt selection and availability.
4. [Acceptance #969](https://github.com/dimakis/mitzo/pull/969) (this slice): extended lifecycle/authority/import/concurrency tests and current
   operating documentation. Current-head CI and trusted exact-head Centaur gates
   remain mandatory before any merge. The user-authorized merge hold was released after #962 merged at
   `41c4b051f82347841f2cda51b1ef252e3895d413`; no staging, deployment or pool
   activation was authorized by that release.

## Deterministic execution evidence

All MCP peers are injected fakes with temporary databases/configuration. Runners
are mocked at the model boundary; no real model, credentials, personal MCP files,
server installation or production target is used. One local worker and a 1 GiB
Node heap are retained. Browser launches use the approved unsandboxed execution
path on macOS; requests and WebSockets are fully intercepted.

| Contract            | Evidence                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Test first          | Saved red runs for missing catalog module, configured-route refusal, missing refresh endpoint/action, ambiguous source controls, source-count/workspace binding, pinned launch context, missing full-descriptor versioning/admission, and initial-read/discovery ordering.                                                                                                                          |
| Identity/version    | `configured-tool-catalog.test.ts` separates duplicate names, rejects duplicate source UUIDs before processes, versions removal/re-add and descriptor changes, retains receipts after close/reopen, and refuses missing/foreign/configuration-drifted selections.                                                                                                                                    |
| Exposure/dispatch   | `configured-tool-admission.test.ts` publishes one source's search tool while a second source has the same name and another tool is unselected. Both API provider paths receive exactly the selected optional wire plus AskUserQuestion. Actual hashed aliases, canonical/direct names and wrappers for unselected tools cannot call peers.                                                          |
| Immutability/resume | The same scenario publishes a later empty revision, imports the original into an installation with no receipt, refreshes additions/renames/schema changes/removals, closes/reopens library/event/private/catalog stores and resumes the original event-bound selection. Labels may change; contracts may not. Drift blocks resumed and existing dispatch without changing retained metadata.        |
| Current authority   | `configured-tool-authority.test.ts` verifies delimiter collisions, untrusted annotation hints, permission checks and revocation/cancellation while awaiting approval. Peer effects remain zero after authority loss. Existing account, connection, skill and runtime checks are retained.                                                                                                           |
| Exact launch        | `configured-tool-source-launch.test.ts` launches a relative-script source in its private discovered directory rather than a later task worktree; descriptor drift refuses exposure even before a library refresh.                                                                                                                                                                                   |
| Discovery ownership | Catalog regressions cover superseded/cancelled refreshes, configuration changes before commit, cleanup and retained saved results. MCP regressions bound empty unique-cursor pagination; existing repeat-cursor, tool cap and cleanup checks remain.                                                                                                                                                |
| HTTP/IPC            | `agent-library-router.test.ts` verifies GET creates no peer, explicit same-origin operator POST refreshes, caller commands are refused, stale sources show unavailable reasons and revoked discovery cannot publish late results. IPC cancellation reaches discovery; retained owner drain waits for actual cleanup.                                                                                |
| Portable profiles   | Strict schema excludes aliases, launch inputs, paths, credentials and grants; built-in/absent/empty serialization stays unchanged. Imports preserve the reference without name-based resolution.                                                                                                                                                                                                    |
| UI                  | Component/design checks plus the actual-page configured fixture cover source labels, opaque receipt selection/export, loading/error/retry, a delayed initial GET during failed discovery, source filters, keyboard Escape/focus and bounded narrow layout. Six page cases and two startup checks pass in mobile WebKit/Chromium and desktop Chromium, light/dark, Lavender/System and Teal/Georgia. |

Inspected captures are linked from the [UI design contract](../design/ui-design-system.md).
Package/frontend and focused server typechecks pass after correcting a catalog
return type and explicit admission-map narrowing reported by CI. Broad server
builds and the production Vite/full-app browser suite remain CI gates under the
local heap limit; focused actual-page renders do not substitute for those checks.
The initial combined focused run passed 298 checks in 26 files. After accepted-main
integration and the initial review corrections, the combined run passed 306 checks in 27 files.
After the design/compiler hold was released and the source-environment review fixes
were integrated, the final combined run passed 314 checks in 30 files. The combined
actual-page tool and session-library matrix passed 26 checks (24 page cases and two
startup checks), including the
existing Phase 1 journeys, configured-source unavailability, cancellation and focus
restoration. The design command passed 107 checks. These counts overlap and must
not be added as a unique aggregate. Focused lint, formatting, unique manifest entry
validation and package/frontend/focused-server typechecks pass.

## Supported source/runtime matrix and operating limits

Configured selection is enrolled only on local OpenAI Responses and Gemini/Vertex
API routes. Source configuration and interactive runtime admission remain required.
Native Codex, Claude SDK, OpenShell and native Symposium/reviewer/search routes
retain explicit refusals. Missing tools preserves legacy behavior; explicit empty
means required platform tools only. Active-session refresh is unsupported: new
session required. No remote transport, arbitrary command picker, credential store,
API-template builder or Tool Builder agent is introduced.

Configured sources opt in with a unique `librarySourceId` in the existing host MCP
configuration. The picker receives no executable configuration. Read the
[configuration and refresh guidance](agent-library.md#discovering-configured-stdio-tools)
and [private identity/launch contract](../design/configured-tool-selection.md).
Library publication, source acceptance, runtime adoption and live qualification
are separate claims.

Canonical staging and its pipeline remain stood down. No staging check, enqueue,
restart, recovery, recreation or deployment is authorized or performed. Retained
ownership and diagnostic records are preserved. Production is not a test fallback.
Any future live test needs a separately selected and explicitly authorized target,
a supported Luna model and an exact model/charged-account declaration before calls.
Source acceptance must not close Phase 1's outstanding live qualification.

## Review corrections after the merge hold

The exact-head reports on the prior candidates approved #966 and #969 but blocked
#965 and #968. Three discovery regressions were reproduced red and corrected:
`CEN-8D925CF3FF6E` uses structured source/tool wires, `CEN-E881915CF4A0`
rejects inherited directory overrides before peer creation, and `CEN-B7842C6315BF`
retains and awaits the shared peer shutdown promise. A follow-up red test scopes
approval identities by source UUID as well, preventing colliding labels from
sharing a session approval. The real HTTP refresh regression also waits on a
deferred peer close after revocation. Concurrent refresh/publication preserves the
published receipt and reports its supersession rather than changing its contract.

Later review findings `CEN-196960EFF96A` and `CEN-076078401B27` exposed
session-environment drift at both actual chat startup callers. Discovery and
configured-tool admission now use the same explicit base host environment, separate
from `MITZO_SESSION_ID`, agent names and per-session worktree paths. Missing source
environment refuses before starting a peer; receipt validation still detects base
environment changes. Both API provider regressions and actual startup wiring were
recorded red before the fix. The 41-command owner fixture uses a 60-second budget
with one worker and the 1 GiB heap.

All corrections are propagated through the stack over current accepted main.
Previous approvals and green CI do not approve these new heads; fresh current-head
checks and final trusted Centaur reports remain required before merging.
