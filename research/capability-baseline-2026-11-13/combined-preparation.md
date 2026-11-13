# Combined parity candidate

13 November 2026. Local preparation for existing draft PR
[#1342](https://github.com/dimakis/mitzo/pull/1342), preserving its history and
the original slice checkouts. This supplements the earlier
[functional checkpoint](local-integration-checkpoint.md); its compatibility-only
proposal and pending custody are historical.

## Inputs and resulting behavior

- Accepted source: `23816770cc1d80b16c557dd88f7078c7cf53f163`, including the
  accepted PR #1322 visibility owner. No speculative main refresh was performed.
- Local functional candidate: `798bb56b7476dc0302341e9e7110ebf075d3930e`.
  Ordinary Claude TaskExecution uses the shared task grant, permission and
  notification owners. Profile exclusion removes task guidance and admission.
  SDK completion delivery defers to the installed central notification owner;
  the standalone legacy path retains diagnostics and existing behavior.
- PR #1342: `6dc2ba3322dbdc2a870c25b35b4b4f2d5c4f132d`, merged locally at
  `15f04587`. The additive controls contract lives beside `helperSupport` in the
  accepted protocol `SessionAccessEvidence` interface. The existing Access
  projection and sanitized logging remain the owners. Branching and rewind are
  unavailable; qualified context inspection means recorded usage only.
- PR #1343: `b9e2adaba6288b4de69f02259b33c72181757cd0`, plus the completed
  local follow-up `8ff47e011c958006f5ea87a4359b30b7278f0c88`. The merge retains
  strict skill parsing, dependency ceiling intersection, visible unsupported
  admission, immutable context in the existing command ledger and original FIFO
  command authority. No replacement queue or permission registry was introduced.

The joined managed-handler seam captures the original SDK callback state's
`checkTool(actualWireName)`. It checks the named handler before dispatch and
through existing asynchronous and synchronous effect fences, including the
TaskExecution, session-launch and peer-message special paths. Per-name cached
tool owners preserve that exact fence. Peer-message runtime and approval
assertions recheck it before effects instead of relying on a check after return.
Existing profile, account, runtime, permission, task, cancellation and skill
checks still apply.

New real-MCP regressions first reproduced TaskExecution store reads outside the
frozen ceiling and after retirement during an authority wait. A further red
case reproduced a peer handler effect after retirement inside its awaited
dispatch. The joined guards make those cases pass. The peer seam fixture
substitutes its effect; it does not claim live peer delivery qualification.

## Combined local verification

These four disjoint test groups ran with one worker and a 1 GiB heap:

| Group                                                                                                                           | Result                                                    | Retained local log                         |
| ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------ |
| TaskExecution native fences, actual application startup/continuation, original SDK command boundary                             | 21 passed across 3 suites                                 | `.verification/managed-peer-green-2.log`   |
| Composer, FIFO owner, SDK query/turn, shared skill policy, owned runtime, registry, bundled skills, refusal, startup and launch | 195 passed; one startup case blocked by socket permission | `.verification/combined-skills.log`        |
| Managed credentials, ordinary connections/effects, notification lifecycle, query loop and launch selection                      | 154 passed across 6 suites                                | `.verification/combined-shared-owners.log` |
| Controls and helper-support composition through pure Access projection                                                          | 14 passed; HTTP listener case deliberately excluded       | `.verification/combined-controls.log`      |

Total: 384 passing tests. The startup failure is `listen EPERM` at
`chat-account-startup.test.ts:972` in “serializes paused ordinary resume and draft
conversion in both orderings.” It also produces an unhandled listener error;
neither is accepted as green. The current task grant has `network: none` and was
not widened. Existing Access HTTP tests also require an authorized listener or
coordinated CI. No unchanged listener denial was retried.

Protocol, harness and client TypeScript builds pass. Scoped lint, formatting,
whitespace and intentional source-artifact checks accompany the merge. Runtime
source revision: `v1.0.1135-claude-parity-composition`.

An initial invocation of the new seam group used an incorrectly short executor
timeout and was killed before any completed test result. Its uncertain receipt was inspected;
the successful run above used a new request after correcting the timeout. The
timeout and an unavailable process-list command are not test evidence.

## Publication and remaining acceptance

PR #1342 custody was released by its original owner in receipt
`6a45b05f-cf1c-416f-8df0-6cef65230d9b`, with its branch still at `6dc2ba33` and
no operation in flight. This candidate preserves that ancestor so publication
can use a non-force fast-forward after fresh remote inspection. Custody transfers
neither a task grant nor publication, merge or deployment authority.

No remote write, new PR, hosted CI, live model/device call, merge to main or
deployment was performed for this assembly. The coordinator must sequence the
single publication and final validation. Current-head hosted CI, broad server
typechecking, browser checks and trusted Centaur review remain pending.

Restricted prompt admission remains refused, including empty ceilings. Trusted
startup admission must atomically retain the resolved ceiling, and the joined
initial/FIFO/cold-recovery and remaining managed routes need qualification before
enablement. Native Codex restricted execution remains unsupported. Hook support,
`srt-mux` diagnosis, native branching/rewind and provider/live acceptance remain
unfinished. Task grants do not authorize native tools or broader actions.

Routine Telos mutations remain deferred. This is retained repository evidence,
not a saved Telos status, formal reassignment or acceptance receipt.
