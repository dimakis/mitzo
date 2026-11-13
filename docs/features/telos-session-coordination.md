# Current Telos session coordination

Prepared on 13 November 2026 in an independent ordinary session. This repair is
not assigned beneath capability feature `8e186fdf-9058-4ad6-af18-8fd6797bf935`.
No active worker, worktree, task grant or live Telos assignment is changed.

## Dependency and incident evidence

Accepted source inspected: `main` at `9e47c4ab81d836673bacb461d2b03d46d8de390f`.
This follow-up uses PR [#1330](https://github.com/dimakis/mitzo/pull/1330) at
`86aebb39222e6672778995d6de11e873dd1fc6b4` as its local base, reusing its reviewed
adoption, worker-start, assignment-observation and chat-tree implementation.
The earlier linked-session and adoption conversations were read. PR #1302 is
historical; #1330 has a current owner and its branch is preserved.
The existing owner explicitly transferred sole PR integration/publication ownership
after the user requested adding this repair and merging. The combined candidate
reuses its unpublished `c2ec53535947df6d0ab2aad761d78a651d157eb6`, which includes
published `39c2b53ded1a06381b1d7e10bdf8f9974d526e5b` and accepted main
`1df45e8e3b0ae57753d6bcb49015fa96fc6a7333`. Its original checkout is preserved.
The only merge conflict was the source registry; both key sets are retained and
hashes recalculated. The first-command authority fence remains enforced through
provider submission and releases only at the first acknowledgement.

The supported `TelosManageItem` read confirmed the capability item is a feature
with five direct slices. Its current brief explicitly distinguishes canonical
classification and formal assignment from work takeover/provenance. The deployed
read did not expose #1330's assignment observations, so the live recorded lead and
creating/admitted login IDs were not independently established here.

Sending the authorized initial milestone to originating chat
`941fa68f-868e-8b52-a4bb-d68c195c0dfa` failed with `recipient_unavailable`, stage
`ownership`, request `b9500d37-c94a-4e16-8b48-c9b1533e3483`. No delivery is claimed.
No private stores were inspected or repaired. Source and synthetic real-owner
regressions establish the defects below; they do not certify that the deployed
incident has been repaired.

## Behavior

- Ordinary communication distinguishes durable creating-login custody from the
  current admitted runtime identity. Separate verified logins in the primary
  operator realm can discover and message each other. Both live identities must
  be verified before treating different logins as peers. Isolated-realm live
  owners remain inaccessible, and frozen runtime identity, permission, skill,
  revocation, approval and delivery fences remain enforced.
- Correlated replies use the original peer's actual grant key. Reauthentication
  does not rewrite custody, messages or receipts. Exact retries inspect the
  original receipt instead of dispatching another command. An unavailable sender
  custody diagnostic identifies ordinary chat recovery; inaccessible recipients
  retain the generic ownership refusal without revealing private identity data.
- The canonical work owner exposes a bounded, transactional relationship read:
  the linked item, its ancestry and direct children for its current lead. An origin,
  previous lead or implementation takeover does not acquire child visibility.
  Protected profiles, unrelated conversations and excessive/cyclic ancestry are
  refused. This read exposes no additional transcript or source content.
- Native Codex and ordinary SDK startup receive a separate current coordination
  observation. Canonical work level, assignment revision, current reporting target,
  direct child assignments and execution observations supplement the immutable
  reviewed context. They do not replace its bytes, task mapping or admission hash.
- `TelosManageItem.workContext` includes direct child assignees and the canonical
  reporting target. Session metadata exposes the same observation for chat links.
  Existing Work/Chats navigation continues to use canonical assignments. An
  unassigned chat no longer falls back to a retained former lead as its current parent.
- The existing **Return to lead chat** link uses current metadata. Missing,
  mismatched, superseded, stopped or unavailable coordination shows the existing
  inline status treatment, retaining the work link, reviewed context and composer.
  Successful completed turns leave an idle coordinator available; stopping,
  stopped and interrupted sessions remain unavailable. An independent review
  identified this distinction, and real execution-ledger/UI regressions cover it.

## Evidence states

| Evidence                               | Meaning                                                               |
| -------------------------------------- | --------------------------------------------------------------------- |
| Allocation / `chat_ready`              | A retained chat allocation exists; no inference started claim         |
| Canonical assignment and revision      | Current responsibility, independent of creation and takeover          |
| `startEvidence.admissionState`         | Exact ordinary admission ledger state, if observed                    |
| `initialCommandId`                     | Existing initial command identity; never a new command                |
| `runtimeState`                         | Live owner presence only when observed; otherwise `unknown`           |
| `executionPhase` / terminal reason     | Existing execution projection, independent of item completion         |
| Message delivered / received / applied | Existing message and control receipts; never interchangeable          |
| Item completed                         | Canonical item status and its evidence; no inference from stale notes |

Absent admissions, missing updates or an unavailable observer produce `unknown`.
They never establish that a worker has not started. A stopped or missing assigned
coordinator remains identified with a recovery diagnostic; another chat is not
silently substituted. Formal live linkage changes still require their supported
reviewed setup/adoption flow and exact receipts.

## Runtime scope

| Engine and target                               | Evidence / limitation                                                                                                                                                                         |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex, Local Mac                                | Real canonical-owner startup regression; actual native message-owner selected tests; no model call                                                                                            |
| Codex, OpenShell                                | Existing retained-lead startup test now checks explicit unavailable coordination; shared caller/adoption contracts retained. No live sandbox or new OpenShell messaging adapter qualification |
| Claude SDK, Local Mac                           | Shared startup assembly and real SDK input/ACK tests with separate signed operator logins; authenticated Telos proposal adapter tests retained. No live SDK/model execution                   |
| Claude, OpenShell                               | Work-bound caller remains unsupported by the existing runtime/host-tool dependency; no parity claim                                                                                           |
| Any caller creating a Claude or OpenShell child | Existing qualifier rejects before allocation; children and explicit startup remain independently reviewed Local Mac Codex routes                                                              |

No runtime was substituted, recovered, restarted or called to obtain these results.

## Validation and remaining gates

Test-first failures were observed for cross-login discovery/custody, isolated-realm
ownership, sender-versus-recipient diagnostics, canonical coordination, and all six
current-lead UI cases. Tests and implementation are committed together.

- 243 ordinary/native startup tests passed across `chat.test.ts` and
  `codex-chat-session.test.ts` (including the real canonical startup fixture).
- The canonical owner/context/adoption/backlog group passed 94 tests before the
  final unknown-observer refinement; its affected owner, observation, navigation,
  backlog and UI subset then passed 44 tests. Counts overlap.
- Communication/SDK/identity tests passed with signed login, isolated realm,
  revocation, stopped-owner, correlated-grant and ACK coverage. Latest shared
  communication suite: 29 tests; focused diagnostic suite: 2 tests.
- Four selected actual native cases passed for viewer replacement, Claude-to-native
  steering, operator revocation during approval and exact ACK recovery. The full
  native test invocation exceeded the executor's 120-second deadline; it is not
  claimed as passing.
- Workspace TypeScript packages compile; selected server roots have zero diagnostics.
  The frontend production typecheck/build passed. Lint, formatting, reviewed source
  fingerprints and the committed-diff secret scan passed.
- Design checks: 109 passed, one pre-existing conditional skip. No CSS, shared
  geometry, palette or motion changes. The repair reuses `telos-chat-context`,
  the existing link, inline status and linked-context disclosure.
- The new intercepted browser fixture covers current/stopped/unknown reporting,
  keyboard navigation, draft preservation, narrow desktop/phone widths, both
  themes and alternate appearance. `npm run test:ui` built successfully, then
  found no browser in the executor's private home. An installed browser was copied
  into the task and retried; macOS denied Chromium's Mach-port bootstrap before
  assertions. Twelve browser cases did not run. No screenshots or visual acceptance
  are claimed. Retained logs are under the local ignored `.mitzo-devtools/` directory.

Combined-candidate validation also passed 293 focused startup, canonical and
communication tests, then 38 focused identity and idle-coordinator regressions
after the independent-review fix (counts overlap). The combined server/frontend
builds, full source TypeScript check, source fingerprints and changed-file lint pass.
The missing-custody fixture uses the owner's actual nullable return contract.

Required hosted CI, browser evidence and trusted exact-head review remain landing
gates. No deployment, live model test or live assignment repair is included.
