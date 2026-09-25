# Manage work ownership and role policy contracts (O0/O1)

This contract separates one durable conversation from optional Telos intent, task-board
execution, and ContexGin goal accounting. A standalone Symposium has a conversation
ID without invented Telos, task, or goal IDs. A task node may be linked only with an
explicit task root. The provider thread and transient runtime process are never
aliases for the conversation ID. `packages/protocol/src/orchestration.ts` contains
the versioned contract and pure guards; it is not a second scheduler or ledger.

## Ownership

| Concern                                                                     | Authority                                                                          |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Telos item and outcome intent                                               | Telos                                                                              |
| Task root/node, dependency readiness and global worker claim                | TaskStore/TaskOrchestrator, later shared SessionService                            |
| Durable conversation and provider attempt                                   | Mitzo execution/event stores                                                       |
| Symposium stable seat ID, membership generation, recipient and intervention | Symposium event store/orchestrator                                                 |
| Host capacity reservation across workers and active seats                   | Shared SessionService, using Symposium membership CAS for seats                    |
| Account/model availability and role policy                                  | AccountProfiles/model catalog and O1 policy resolver                               |
| Provider process and OpenShell attachment                                   | Runtime adapter after explicit admission                                           |
| Outcome verification                                                        | Evidence linked to pinned result/artifact revision; independent of task completion |

For Symposium v2, O0's `{conversationId, seatId, membershipGeneration}` maps to
Phase 2.5's `{sessionId, seatId, generation}`. Role, profile, model and account can
change independently of the stable seat ID. A membership transition increments the
generation, fences queued claims, and records whether runtime shutdown and provider
reconciliation are confirmed. O0 does not infer identity from array position.

## Work and dispatch

A work order pins input revision and SHA-256 hash, context/authority grant revisions,
role policy revision, actual account binding, model and reasoning effort, scoped files,
acceptance criteria and budget. `AccountBindingSchema` is the existing account route;
the runtime must resolve current authorization and model availability at execution
time. A profile is not an account, and a context grant is not filesystem isolation.

`admitDispatch` is a **pure preflight decision**. The host must atomically persist
the operation key, input hash, ownership generation and any seat membership generation
in its authoritative store before allocating a runtime. Same key and input may
reconcile the original operation; changed input conflicts. Stale ownership or seat
generation denies dispatch. Membership presence must match: a seat operation cannot
claim an ordinary worker context or omit an active seat. The outbox/recovery implementation belongs to O2's
SessionService and existing execution stores, not this protocol module.

An attempt uses the existing `ProviderAttemptToken` identity. Runtime recovery
reconciles the **same** provider attempt, including an ambiguous outcome; it never
automatically creates another provider turn. A failed or ambiguous turn can create
a new attempt only after an explicit retry request, a retryable sanitized failure,
the provider's retry delay, remaining attempt budget and, for ambiguity, separate
confirmation. The runtime records a sanitized
`ProviderFailure` with the existing failure envelope. Cancellation and revocation
persist a fence before signaling a process. A late provider result remains evidence
but cannot complete work under a newer ownership, membership or input revision/hash.
Recovery-required retries always need ambiguity confirmation, even if a later
failure classification reports `ambiguous: false`. Work-result
completion and criterion-level outcome verification are distinct records.

## Role execution policy (O1)

`ExecutionPolicySchema` versions each role policy independently. Its profile binding
is separate from its explicit account, model and reasoning-effort selection. Goal,
task and seat selection overrides resolve in that order of increasing precedence:
seat wins over task, task over goal, and goal over the role default. Changed account,
profile or grant references require an approved policy revision. A different model
or effort on the same account is allowed only when listed as an explicit fallback or
escalation in the policy; it consumes that mode's bounded counter even when selected
through an override. The audit retains both the policy primary and the explicit
requested selection, plus the actual binding, substitution reason, profile revision,
grants and policy revision. No model tier or account substitution is inferred.

`resolveRoleExecution` checks the current `AccountProfiles` catalog and model/effort
validation, then requires injected evidence for runtime route, tools and context
capability. These checks establish a **selection**, not a provider attachment or
durable dispatch. Pricing is either a known upper-bound quote or explicitly unknown.
An unknown price never becomes zero; with a cost cap it requires the policy's
explicit unknown-cost allowance, while token and attempt ceilings still apply.
The resolver returns work-order-compatible account, effort, grant, budget and policy
pins; the host must persist the audit and use O0's atomic dispatch/ownership fences
before runtime execution. Live multi-seat provider routing and policy editing UI
remain separate integration work.

## Handover

The H1 manifest pins source and successor conversation IDs, exact package and input
revision hashes, the ownership generation transfer, grant revisions and cumulative
budget use. A successor receives no new grant and no reset attempt/token/cost usage.
The shared service must create/bootstrap the successor idempotently and persist the
ownership transfer before old ownership can dispatch again. `prepared`,
`transferring`, `recovery_required`, `completed` and `cancelled` support crash
reconciliation. Symposium continuation additionally snapshots current seat bindings,
pending interventions and delivery state; it requires fresh admission and uncertain
turn reconciliation, not copied provider threads or approvals.

## Older PR disposition against 25 September main (`7ea6627d`)

- [#398](https://github.com/dimakis/mitzo/pull/398) is open. Its read-only Telos
  SQLite reader and promote fallback are not in main. Main's promote route accepts
  caller-supplied title/context and creates a new task root each call. O2 must add
  an authoritative idempotent Telos-to-task link; O0 only defines distinct IDs.
- [#414](https://github.com/dimakis/mitzo/pull/414) is open. Main has no
  `external_ref`/`externalRef` unique link in TaskStore. Its duplicate-prevention
  requirement remains for O2's durable create/bootstrap CAS; do not merge its old
  route patch wholesale.
- [#419](https://github.com/dimakis/mitzo/pull/419) is open. Main already returns
  client IDs for orphan detection and TaskNode links active sessions. Keep those
  fixes. A durable conversation/worker link and crash reconciliation still belong
  to O2; old UI changes are not an O0 dependency.

O2 can build SessionService and durable dispatch against the O0 identity,
attempt and handover contracts. Phase 3 Symposium runtime waits for Phase 2.5,
O1/O2 and the separate runtime canaries. This document does not claim live execution.
