# PR #1362 — independent permission assessment

14 November 2026. GPT-6.1 Sol, audit conversation
`eed63efb-da6e-8843-8796-e75eba8c7269`. This extends the existing parity audit;
it is independent of implementation/integration owner
`f0325706-afeb-8067-baca-1aece1c090b9` and the two source owners.

Candidate: `314d751899ef93c149285eea84e395e9af029ca6`;
tree: `d91976617d209b210e1b2e2e16abf0e139b0d567`;
accepted comparison base: `27345bb50c698646f5a7c2128ab6573b488f624c`.

**Decision: no blocking findings in the complete reviewed permission-sensitive
delta on exact 314d7518.** This is a full assessment of this bundle relative to
27345bb5, not another full audit of the entire parity programme, an exact-head
Centaur decision or approval to merge/deploy.

The candidate is tested in an isolated detached audit worktree, with dependencies
reused from the existing audit clone. Vitest's repository aliases resolve the
workspace packages to this candidate's source. Production/test bytes are not
edited. The separate #1342 audit branch and its full assessment remain intact.
This candidate does not contain #1342; no combined #1342/#1362 acceptance is
claimed. The real accepted #1342 delta requires a focused composition follow-up.

## Complete permission-sensitive production scope

All 19 changed production TypeScript files were reviewed relative to the base.
The generated source manifest is additional, and its checker passes at
`v1.0.1170-claude-parity-controls`. The companion JSON records the exact file list.
Changed tests and relevant unchanged identity, transport, authorization, custody
and failure-classification consumers were also inspected.

| Boundary                                      | Evidence and retained contract                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cross-login identity                          | Reuses `ordinaryOperatorOwnsConversation`, backed by the host's verified primary-operator registry. A creating-login ID remains historical provenance; a new viewing login does not replace runtime/account/workspace custody. Custodian/foreign/internal identities do not become primary operators through this helper.                 |
| Public entry, continuation and historical ACK | Existing captured transport authorization, immutable command fingerprints, profile/account/target/workspace comparison, claimed checkout and native history fences remain. An active executor cannot be cold-resumed into a second owner. Exact duplicate command receipts remain observations, not duplicate dispatch.                   |
| Stop and queue controls                       | Original session/command, current binding, owner identity, interrupt target and durable request receipt remain authoritative. The canonical interrupt owner prevents successor interruption and duplicate effects. Targeted Stop retains pre-effect and post-await authorization/cancellation checks.                                     |
| Approval on a second device                   | The authenticated, open, watching transport can answer the existing session's pending card without moving its execution attachment. Wrong session, missing/foreign/revoked identity, reused connection and already-resolved requests retain refusal paths. Existing pending-decision ownership is reused.                                 |
| Selection/workspace diagnostics               | Refactoring splits existing predicate checks to identify failure stages. It preserves scope, root inode/device, symlink, claimed Git identity, permission revision, profile/account and admission checks. Caught errors retain their original classification/cause through bounded annotations.                                           |
| Refusal and telemetry                         | Retained `SessionRuntimeError` survives normal iterator closure or generic SDK AbortError; ordinary Stop remains distinct. Startup logger fields and new trace attributes use allowlisted classifications/checks, not raw upstream text/stack. Original causes remain in memory. Existing tracing wrappers preserve handled ERROR status. |

No second business-logic, storage, permission or recovery owner is introduced.
Account/route scope is ordinary Local Mac Claude: Vertex, configured/managed
subscriptions and the qualified Anthropic API path. Existing Codex behavior is a
regression boundary; this patch does not enable unsupported Claude runtime tuples.

## Execution evidence

The first control batch has 490 passing tests and ten setup failures, with no
skips. All ten failures are the unchanged continuation fixture reaching the
denied host-private path during `AccountProfiles` construction, before its
assertions. The exact same ten tests pass with the existing supported
`MITZO_CODEX_PRIVATE_DIR` setting pointed at a synthetic `/private/tmp` path.
No permission expansion, host credential access or test/source edit was used.
The initial failed batch remains retained; it is not relabelled green.

The four public two-login journeys pass on the exact candidate. They exercise
actual local HTTP/SSE and frontend continuation consumer code with a canned SDK
provider across Vertex, configured subscription, managed subscription and API
fixtures. Each covers pending approval replay/answer, normal Send, duplicate
admission, targeted Stop, FIFO/Continue, cold explicit continuation, exact custody
preservation, foreign token, borrowed connection and revoked-login negatives.
Other executed control suites cover target/owner/binding replacement, post-await
authorization loss, cancelled senders, retained interrupt receipts, original
command mismatch and sanitized failure/trace behavior.

All 48 SDK journey cases pass (172.33s), zero failures/skips. They include first,
queued and cold consumers; eager/delayed startup probes across modes; personal
and Vertex mode/workspace refusals under original-error, normal-close and generic
AbortError exits; actual Pino serialization with private injected causes;
Stop/reconnect/Continue, bounded failed-turn Retry and original-intent recovery.
Tests verify retained diagnostic identity and failed child/session/chat-start
traces without dispatching refused input or exposing its original cause.

There are **548 distinct passing test cases across 14 suites**: 490 in the first
control batch, the ten setup-blocked cases after environment correction, and 48
SDK cases. This does not mean the original 500-case batch passed, and the ten
cases are counted once. No additional production/test change followed the runs.
Fresh remote refs confirm candidate 314d7518 and accepted main 27345bb5 at the
terminal decision; #1342 remains separate at 09e9eed2. No source merge or deployed
adoption is inferred. This full bundle baseline can be retained for focused
verification of later accepted #1342/reporting/conflict deltas.

All tests use one worker and a 1GiB Node heap. `LOG_LEVEL=info` is explicit for
serialized diagnostic evidence. Raw result paths and SHA256 hashes are retained
in the companion JSON; shared tests are counted once rather than summed across
reruns or earlier #1342/accepted-source assessments.

## Required remaining qualification

Reporting S01/S02/S06/S09 remains unimplemented at this source checkpoint. These
diagnostics are distinct from post-result persistence, context measurement and
child/background reporting. Optional S05 and S03/S04/S07/S08/S10–S14 retain the
original audit's bounded dispositions; they are not silently converted to parity
prerequisites. Separate #1345 owns correlated replies across logins; no extraction
or absorption is assessed here.

Physical desktop/iOS, real subscriptions/API/Vertex accounts, full process
restart, real installed/account-specific inventory and production adoption remain
unqualified. The two-login reproduction does not establish the original device
incident's cause. Synthetic startup diagnostics do not establish the original
input-authority incident's cause. No live model/service write, scheduled delivery,
worker launch, deployment or merge is performed by this audit.

The complete #1362 assessment is candidate-bound. CI/Centaur, source-owner
follow-ups, accepted #1342 composition and subsequent reporting changes retain
their existing owners and gates. No new agent, backlog copy or programme is
created. Full Claude parity is not established by this candidate.
