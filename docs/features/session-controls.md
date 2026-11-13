# Session controls: support and delivery contract

13 November 2026. Telos slice `8eb4f6b6-f247-41fa-9444-4367beddbaa9`, under
feature `8e186fdf-9058-4ad6-af18-8fd6797bf935`.

This increment establishes the support decisions before control UI or native
mutations. `GET /api/sessions/:id/access` adds `controls` through the existing
operator-authenticated Access projection. Its policy revision identifies this
source audit; `readinessRevision` binds it to the enclosing validated readiness
snapshot. Neither revision proves a provider operation succeeded or grants access.
The existing capabilities observation remains the owner of measured results.

## Source-pinned decisions

Inspected Mitzo base: `9e47c4ab81d836673bacb461d2b03d46d8de390f`.
Claude Agent SDK: `0.3.322`, pinned in `package.json` and `package-lock.json`;
the matching installed `sdk.d.ts` was inspected without reading account data.
Codex's accepted binary pin is `0.160.0` in `docs/spikes/openshell-codex/runtime-codex-version`;
`server/codex-app-server-client.ts` enforces that version. This audit inspects
Mitzo's adapter calls and contracts; it makes no new live-provider qualification.

| Engine / placement     | Account route                                | Branching                                     | Context inspection                    | Scoped rewind                                           |
| ---------------------- | -------------------------------------------- | --------------------------------------------- | ------------------------------------- | ------------------------------------------------------- |
| Codex / Local Mac      | OpenAI subscription or API through Codex     | Unavailable: user branching is not integrated | Limited: retained usage only          | Unavailable: no qualified operation                     |
| Codex / OpenShell      | OpenAI subscription or API through Codex     | Unavailable: user branching is not integrated | Limited: retained usage only          | Unavailable: no qualified operation                     |
| Claude SDK / Local Mac | Claude subscription, Vertex or Anthropic API | Unavailable: user branching is not integrated | Limited: retained usage only          | Unavailable: no checkpoint owner or qualified operation |
| Claude SDK / OpenShell | Any Claude account                           | Unavailable: route is not qualified           | Unavailable: route is not qualified   | Unavailable: route is not qualified                     |
| Responses or Gemini    | Their configured accounts                    | Outside this slice's qualified routes         | Outside this slice's qualified routes | Outside this slice's qualified routes                   |

Unknown, invalid, mismatched or unavailable runtime/session owners produce
`unknown` with the existing readiness reason. An account label, model, tool grant,
or SDK API symbol cannot upgrade that state. No alternate account/runtime is
acquired. `limited` describes the permitted inspection scope, not the presence,
freshness or accuracy of a particular reading. A stopped session loses current
readiness; the retained history and usage stay under their existing read owners.

Evidence and limits:

- `server/codex-conversation.ts`, `replaceFailedProviderThread`, uses
  `thread/fork` through a completed turn for **internal transport recovery**.
  It retains the failed user command as a tombstone and does not replay it.
  This replaces a provider thread generation inside one conversation; it does
  not create a user branch, independent workspace or new consent boundary.
- SDK `forkSession`, `Options.forkSession`, `resumeSessionAt` and
  `resumeDropsTurn` are declared upstream. Mitzo's `sdk-turn-query.ts` and
  `ordinary-local-vertex-sdk-query.ts` own admission, callbacks, retirement and
  process settlement. They do not expose a qualified branching operation.
- SDK `Query.rewindFiles` requires `enableFileCheckpointing`. Neither is wired
  into a Mitzo user control. File rollback is also a different effect from
  changing provider context. No Codex `thread/rollback` operation is exposed
  by the inspected adapter. Upstream rollback semantics remain unqualified.
- SDK `Query.getContextUsage({detail:'summary'|'full'})` exists; `full` may make
  per-category token-count calls. Neither wrapper currently exposes it. Native
  method presence does not establish wrapper, retirement or account support.
- `server/session-list-metadata.ts` projects `token_update.agentContext`, its
  original event time and evidenced model limits. The existing
  `/api/sessions/:id/context` read returns that retained reading or `null`.
  A cumulative session total is not current occupancy. The new Access field
  contains no token counts, source contents, private prompts or raw provider data.
- Prepared source inventory and delivery receipts remain distinct from content
  actually counted in a native context window. Granular inspection belongs to
  existing feature `05f51bcee39031b1` and its qualification/lifecycle/adapter/UI
  slices. This change does not duplicate that implementation or waive its
  Claude/OpenShell dependency.

## Separate bounded deliveries

These are delivery contracts inside the existing slice, not new Telos children
or claims that worker sessions have been created.

### Branching

The first executable delivery must produce an independent Mitzo conversation
with an immutable source conversation, source event/turn boundary and provider
lineage. It must preserve the original transcript and bind the selected account,
model, runtime and workspace through their existing owners. Inherited transcript
content is historical context, never renewed execution authority. Task grants,
pending decisions, credentials and contributor control authority are not copied.
Independent writable workspace admission is required before writes can run.

Branch from a complete, durably retained turn boundary. A busy source must first
reach a supported safe boundary or refuse visibly. A native SDK session/thread
ID alone is insufficient provenance. No native fork may start model generation
as a side effect of opening controls or previewing the boundary.

Persist an operation/request receipt before mutation. Cancellation before
dispatch means no effect. Cancellation or disconnect after dispatch requires
inspection of that receipt and the provider's existing result before retry.
Partial allocation must retain its identities and an actionable unavailable or
uncertain state. Never create a second branch to resolve an unknown first effect.

Acceptance: adapter and consumer tests cover source isolation, account/root
changes, revocation, stop, disconnect/reconnect, late/duplicate acknowledgements
and failure after provider fork but before Mitzo registration. Native history
must remain recoverable. Review/CI and any separately authorized live acceptance
are recorded per route before its control can become available.

### Context inspection

Reuse `05f51bcee39031b1`: a bound snapshot must retain session, provider
thread/query/turn identity where supported, model, account/runtime scope,
measurement method and original observation time. Missing usage is unknown,
never zero. Prepared, delivered and counted sources are distinct. Stale or
partial snapshots retain their last known state and reason without appearing
fresh after reconnect, account/model change, compaction or query retirement.

The current limited inspection uses existing retained usage reads and performs
no provider probe. Native summary/full refresh, category attribution, source
drilldown and responsive UI remain owned by the context-inspector contracts.
Opening a panel must not start a generation turn. Detailed token counting needs
an explicit user action and its owning route's overhead/authority policy.
Private provider prompts, reasoning and credential material stay excluded.

Acceptance: existing retained reads plus shared snapshot/adapter/consumer tests
must distinguish absent, stale, partial and failed measurements, preserve scope
through stop/reconnect and expose sanitized failures. Synthetic evidence is
separate from live wrapper support. Do not enable a full native inspector based
on this policy field.

### Scoped rewind

The initial candidate scope is **provider conversation context after a complete
turn**, with the original history retained as a recoverable lineage. Preview
must identify the retained boundary and discarded provider tail. No transcript
deletion, workspace file restore, Git reset, external service compensation or
automatic tool replay is included. Executable rewind stays unavailable until
both native semantics and the host operation ledger are qualified.

A future file-rewind operation requires a separate explicit checkpoint owner,
file-change preview and current workspace permission check. SDK file checkpoints
cannot promise restoration of shell writes, external applications or every file.
Already completed external effects remain completed; uncertain effects remain
uncertain. Recovery inspects their original receipts and service state. It never
resubmits them because their conversation tail was removed.

Stop and settle the existing turn through its actual owner before mutation;
refuse while effects, permissions, queued input or process termination are
unresolved. Recheck boundary, account, model, runtime generation and permissions
at dispatch. A deterministic SDK `resumeDropsTurn` refusal clears the pending
truncation target and preserves evidence; do not retry the same truncation or
silently discard queued entries. A plain resume must not dispatch a new turn.

Acceptance: separate adapter and consumer evidence covers busy/retired queries,
concurrent queued messages, stale boundaries, stop/reconnect, cancellation before
and after dispatch, deterministic refusal, partial persistence and uncertain
external effects. Originals and receipts remain inspectable after every failure.
No availability flag changes until those tests and required review/CI pass.

## Evidence for this increment

`server/__tests__/session-control-support.test.ts` first failed for the missing
Access field, then verifies the matrix through `projectSessionAccess` and the
authenticated Access router. It covers scope mismatch, absent/malformed owners,
stop, reconnect, rejected fabricated native support, no mutation route and
unchanged grants. All 52 focused controls, readiness and Access tests passed
with one worker and a 1 GiB Node heap. Protocol/harness/client package compilation,
changed-file lint, formatting, reviewed source fingerprints and whitespace checks
passed. A server/test TypeScript check exhausted the prescribed 1 GiB heap;
its broader import graph is left to CI without increasing local resource limits.
No rendered UI changes, provider mutation or live model calls are included.
CI/current-head review and integration into the feature PR remain separate
delivery evidence; the canonical slice stays active until its acceptance is met.
