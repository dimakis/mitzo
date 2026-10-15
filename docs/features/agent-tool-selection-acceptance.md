# Agent tool selection: Phase 1 acceptance

Telos parent `a27aa207cce82024`, Phase 1 `88761f514b081ca1`.
Implementation started from accepted `97935dbda839c5ffabec41d1d3d4ecdb1559a2fa`.
This record distinguishes offline implementation evidence from live qualification.
Phase 1 remains active until its remaining gates pass.

## Review slices

1. [Catalog and schema PR 948](https://github.com/dimakis/mitzo/pull/948):
   authoritative static registrations, versioned portable references, legacy/empty
   semantics, persistence and canonical filtering primitives.
2. [Editor and library PR 949](https://github.com/dimakis/mitzo/pull/949):
   advisor above the editor, Tools tab, searchable existing-tool picker, removal,
   compatibility/connection reasons, usage references and intercepted browser fixtures.
3. [Runtime PR 951](https://github.com/dimakis/mitzo/pull/951): local API model
   exposure and invocation ceiling, private admitted catalog snapshot, unsupported
   native-route refusals and runtime-selection reasons.
4. Acceptance/documentation slice: published-profile cold-restart regression,
   explicit empty behavior, missing connection checks, README and this record.

These PRs are stacked review candidates. Partial merge/deployment is not a completed
feature. Each changed reviewed source closure advances its runtime contract, so
existing independently enrolled targets must follow their normal reviewed update
process; source publication alone does not enroll or qualify a runtime.

## Offline evidence

| Gate                              | Evidence                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Test first                        | Published subset regression failed for the missing selection module before implementation; schema/catalog, editor/API, runtime and availability regressions also recorded red before implementation.                                                                                                                                                     |
| Draft/save/publish/import/history | `agent-library.test.ts` restarts the draft store, publishes exact references, imports a versioned artifact and reads the original immutable revision after a later empty selection. Existing conflicts, retries and owner separation remain covered.                                                                                                     |
| Portable schema                   | `packages/protocol/__tests__/agent-tools.test.ts` rejects credential/grant fields, wire aliases, duplicate IDs, invalid versions and oversized selections; missing fields serialize exactly as legacy definitions.                                                                                                                                       |
| Exposure plus execution           | `responses-chat-session.test.ts` checks exact selected definitions plus AskUserQuestion on mocked OpenAI and Vertex runners; direct calls, connection tools, publishing wrappers, capability names and forged MCP names are rejected before execution. Selected guide execution uses the actual host handler.                                            |
| Immutable admitted snapshots      | `agent-tool-snapshot.test.ts` reopens private SQLite storage and refuses changed definitions, account and profile hash or a missing resume snapshot.                                                                                                                                                                                                     |
| Full published lifecycle          | The API session regression publishes two tools, pins the profile in durable conversation metadata, opens the runner, publishes a new empty revision, closes/reopens library/event/private stores and cold resumes the original set. A fresh conversation gets only AskUserQuestion.                                                                      |
| Authority                         | Existing connection and runtime tests retain approval, cancellation, account/session ownership and revocation checks. A selected guide is denied after a skill-policy change. Missing active connections/configuration refuse selected admission before the model runs.                                                                                  |
| Unsupported routes                | Route projection, native entry and Symposium grant/allocation tests refuse explicit selections; no filtered application-only catalog is advertised as native enforcement.                                                                                                                                                                                |
| UI                                | Component tests cover legacy/empty selection, search, portable additions, removal and required tools. Intercepted Agent Library fixtures cover recovery, publication, exports, usage, keyboard focus/Escape, 320px mobile and desktop, light/dark, Lavender/System and Teal/Georgia. CI retains agent-tools and tool-library screenshots for inspection. |

Focused runs passed: catalog/lifecycle/credential/schema (28 tests),
editor/advisor/recovery/design (118 tests), library API/IPC (17 tests),
runtime/catalog/snapshot/selection/grants (90 tests), native session API (10 tests),
existing chat dispatch (19 tests), and the extended API/availability acceptance
regressions (40 tests). These overlap; they are not a unique aggregate test count.
One local broad server typecheck exhausted the required 1 GiB heap, so no success
is claimed for that command. Workspace package and frontend typechecks passed;
current-head broad checks and rendered evidence remain CI gates.

## Operational limits and remaining gates

On 2026-10-15 the required canonical staging check refused:
`Canonical custodian check/drain refused or uncertain.` The host resource check
also refused admission (`host-memory-pressure`; pressure level 2, about 11.1 GiB
swap). No lock, registry, owner, credentials or service was modified. No second
backend, custodian or background preview was created. No production interaction
or deployment occurred.

Live model qualification has not run. It requires canonical stage integrity and
current-source admission, independently reviewed provider/runtime enrollment,
a supported Luna model and an explicit exact model/charged-account declaration
before execution. Do not use a different model or production fallback. The existing
queue/controller owns any accepted stage update; feature sessions do not replace
its baseline. Production deployment needs a separate explicit user action.

Remaining gates are current-head green CI, inspected offline desktop/mobile
screenshots, required exact-head review, accepted source and safe canonical staging
qualification. Native Codex, Claude SDK, OpenShell, native reviewer/search routes
and configured MCP selection remain explicitly unsupported in this cut. Existing
legacy profiles keep their original behavior on those routes. Arbitrary executable
tools, server installation, API builders and Tool Builder remain later phases.
