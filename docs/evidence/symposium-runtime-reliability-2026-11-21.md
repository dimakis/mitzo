# Symposium runtime-to-consumer reliability evidence

This candidate addresses existing findings 7, 10, 11 and 13 under feature
`0e7adf5e27292950`. It starts at main
`9fa5d6fa6da8bfd0e54b8cb544b4f4329342bd76`; the implementation branch is
`fix/symposium-runtime-consumer-reliability`. This is offline application evidence,
not live Symposium-seat acceptance or an assertion about the historical provider.

## Reproduced gaps and bounded repairs

Two phase regressions and one native callback regression failed before the first
repair: failed phases omitted the sanitized cause/reference, and physical lifecycle
retirement discarded an unexpected callback's cause. The existing diagnostics
from merged #1365/#1370 provide the allowlisted cause projection and bounded
in-memory exception retention. This candidate reuses them, associates an unexpected
lifecycle failure with one host-issued reference/stage, and carries that failure
through the existing bridge. Known runtime and transport errors keep their owners.
Exact safe-refusal and cancellation witnesses retain their existing behavior.

The application regression then reproduced the second gap: the existing durable
command recovery record omitted that lifecycle reference and safe cause. Its
existing transport diagnostic now optionally retains a strict, host-issued
lifecycle projection. No new journal, scheduler, retry policy or event type is
introduced. The original command/session/attempt owns the record. Exception text,
stack, paths and provider payloads are excluded; raw causes remain only in the
existing bounded host memory. Old records remain readable.

## Finding-by-finding disposition

| Finding                                                      | Evidence and disposition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Remaining uncertainty                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 7: one active and one idle seat; both acknowledged a message | New `collaboration-runtime-reliability.test.ts` uses the actual application HTTP/client, reviewed joins, ordinary admission, native lifecycle bridge, conversation/store and shared projection. One target is held active, another reaches idle. The active correction reaches only its exact native turn; the idle target rejects stale steering and receives a distinct ordinary command. A lost steering acknowledgement remains uncertain on repeat observation with no second RPC or command. Existing native owner tests additionally exercise actual peer-send approval/admission into steering and idle wake-up. | Admission, provider acknowledgement and terminal synthetic replies do not prove a live model applied steering. A separately authorized live test must inspect the exact target's resulting behavior.                                                                       |
| 10: promised investigator child has no visible result        | Existing `sdk-task-run-consumer.test.ts` runs a synthetic external SDK stream through the real ordinary SDK query owner, query loop, EventStore, protocol parser/messages reducer and cold replay. It distinguishes resumed task runs, late predecessor receipts and unavailable outcomes at retirement. Inspected #1438 already owns SDK receipt/replay/UI and its qualified Stop consumer. No duplicate child events or UI were added.                                                                                                                                                                                 | **Partial only.** No evidence establishes that the original investigator child existed or completed. Ordinary child tests do not establish shared-seat visibility. No approved shared child-summary disclosure contract/owner is established; that product gap stays open. |
| 11: peer capability unavailable / idle delivery unsupported  | The real host-tool adapter lists the admitted idle recipient with `activeDelivery: steer`, `idleDelivery: queue`, and idle state. An observational source without custody is absent and an explicit send refuses with the original request/recipient and `recipient_unavailable`/`ownership`. Existing #1407 cross-runtime/native tests cover supported runtime delivery, unsupported routes and uncertainty. #1406 remains owner of additional account/repository refusal semantics.                                                                                                                                    | This does not make every runtime, account or unowned historical seat eligible. Runtime qualification and custody remain prerequisites; live availability is unverified.                                                                                                    |
| 13: failed host-tool/bootstrap spans lack cause              | Phase tests verify bootstrap and host-tool execution preserve the safe cause and original reference without secrets. The native lifecycle adapter test verifies a thrown callback retires physically with its original in-memory cause and stage. The real shared-application test injects a transport failure, verifies its originating seat/command, safe error event through the real client reducer, retained `/meta` recovery record, fresh application restart, and no replay.                                                                                                                                     | The historical release `9fb726d2869cfda517d2e905dcd355e776b8e62d` close/bootstrap cause remains unknown. No causal link to earlier Stop is asserted. A fulfilled `success:false` result without a thrown cause remains a failed phase without invented exception detail.   |

Synthetic qualification accepts only inert fixture bytes. Provider RPCs are the
substituted boundary; the new application tests do not mock successful consumers,
delivery stores, admission, recovery or shared projection. Teardown closes only
owned offline fixtures. No live provider, credentials or production service is used.

## Existing owners and integration boundaries

| Candidate             | Inspected revision / relationship                                                                                                                                                                                                                                                        |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S3 #1434              | `a5b272aeeb0908abb564d9e0ff1d50d2cd705050`: only the same-account fixture's published-profile reuse guard is reused here so the second reviewed join works. Preserve this fixture provenance when integrating. No production qualification code is copied.                               |
| S2 #1436              | `b59ae22774fa167bbf53135369405679dc451f74`: queue identity remains its owner; this candidate consumes exact command identities without changing that policy. Combined regression gate.                                                                                                   |
| S5 #1442              | `3197a24180796e05c153f6f67875550c0ca71c19`: trusted origin/activity presentation remains its owner. This candidate only observes existing originating seat/command references. Combined source-attribution and mobile gate.                                                              |
| S8 #1441              | `d68ebff8458b97f9cc30f4c33d1b341726dff572`: policy remains its owner. No production policy changes here. Combined regression gate.                                                                                                                                                       |
| #1438                 | `4fb8db67178915738b72e9f38c2437156ae017d1`: SDK task receipt/replay/UI and Stop consumer remain owned there. No automatic implementation prerequisite for this diagnostic repair; explicit integration/live gate for child presentation. Generation-less production Stop stays disabled. |
| #1406                 | `12e1a1528368620f691198a5be12e73546cddeee`: retain account/repository refusal ownership; no duplicate refusal framework.                                                                                                                                                                 |
| #1407 / #1365 / #1370 | Accepted peer-delivery and merged diagnostics already exist on the pinned main. Their owners and tests are reused.                                                                                                                                                                       |
| #1428                 | Installer `8ad9db0c5d2fac0f3f9ba1ef266bc945ed2dcaa0` used only for task-local setup with `dependencyStore:false`, preserving proxy environment. No installer changes included.                                                                                                           |

S4 membership/removal/Stop mutation logic is untouched. S1 history restoration
remains stopped. No branch is copied wholesale. The coordinator confirmed the
partial finding 10 disposition on 21 November 2026.

Narrow follow-up question for the product owner: which existing owner can authorize
an explicitly shareable child summary containing only originating seat, authorized
status and a result link, and how should inaccessible/unknown results appear?
Resolve that disclosure contract before implementing a shared projection. Never
copy private tool payloads or the ordinary transcript into shared progress.

## Verification and remaining gates

Node 24.22.3, one Vitest worker, `NODE_OPTIONS=--max-old-space-size=1024`:

- 147 tests: `collaboration-runtime-reliability`, `codex-conversation-store`,
  `owned-codex-lifecycle-bridge`.
- 74 tests: `sdk-task-run-consumer`, `agent-communication-cross-runtime`,
  `local-codex-observation`, `runtime-failure-diagnostics`,
  `collaboration-application-messaging`.
- Seven selected `agent-communication-native` cases: Claude MCP sender composition,
  attributed active-turn delivery, active rejection, lost steering acknowledgement,
  idle wake-up, recipient replacement uncertainty, uncertain dispatch failure.
  The other 67 native cases were not claimed as passing. An initial broad run hit
  the executor's two-minute limit; its uncertain receipt was inspected before
  running this bounded selection.

The suite uses `vitest run <named files> --maxWorkers=1`; the native selection uses
`-t 'composes the explicit Claude MCP sender|delivers an attributed peer message|records a rejected active-turn|losing an active-turn delivery|wakes an idle native queue|uncertainty after recipient replacement|uncertain native dispatch failure'`.

Focused ESLint, Prettier, reviewed-source artifact check and `git diff --check`
are publication checks. Full build/type checks and broad tests remain CI gates.
Before landing, integrate relevant owner changes, rerun combined-result tests,
verify actual web/mobile presentation, obtain separately authorized live target
evidence, and require current-head CI plus Centaur's exact-head final LGTM/merge
recommendation. No merge, deployment, live acceptance or completed finding 10 is
claimed by this draft.
