# Claude startup context and Google schemas — 15 November 2026

Slice: `b0d0700b1639efaa`, feature `8e186fdf-9058-4ad6-af18-8fd6797bf935`.
Ordinary implementation custody: `ee064d74-e546-867f-b2ae-b95f874da0f1`, reporting to
orchestrator `1c175758-1a5d-85da-b016-406e103c2944`. Formal Telos assignment is unchanged.
Source baseline: main `b7762c11818dc4066f99d267de3888ccf9d751f7`, SDK
`@anthropic-ai/claude-agent-sdk` 0.3.322 and MCP SDK 1.32.1.

## Source findings and repair

- Ordinary Claude explicitly selected an empty fallback boot context. It now uses
  the existing boot-context fetch, with local executable fallback disabled for
  this account-isolated route. A selected context recipe retains its own compiler.
- `settingSources: []` also withheld project instruction text. Keep that isolation
  and compile the admitted task's canonical `AGENTS.md`/`CLAUDE.md` using the existing
  bounded workspace compiler. Empty ordinary task roots are allowed; explicit
  recipes still require canonical instructions. Symlink, private path, size, UTF-8
  and token-budget checks remain with that compiler.
- Claude lacked Codex's published-knowledge consumer. The SDK now uses
  `prepareHostKnowledge`, its publication verifier and existing `ReadKnowledge`
  handler. Replacement queries select fresh context after the prior process closes
  and before prompt capture, with original account/command/cancellation checks
  before and after the await. Enrollment revocation retires the owning query.
  Publication adoption is recorded only after an SDK assistant message starts.
- MCP's actual `tools/list` returned `{type:"object",properties:{}}` for the Google
  discriminated union. Advertise a flat object derived from canonical operation
  fields and operation enum, removing defaults from optional advertised fields.
  Keep strict per-operation parsing before credential preparation or service I/O.
  Invalid operation combinations return `invalid_input` / `not_started` instead of
  a generic permission refusal. Existing approval owners still decide valid reads.

## Reproducible offline evidence

Red tests reproduced the empty Google listing, misleading validation denial,
missing ordinary boot context and absent replacement-context preparation. Green
tests use actual in-process SDK/MCP `tools/list` and `tools/call`, with synthetic
services and provider peers. No model or live Google account is used.

```sh
LOG_LEVEL=error npx vitest run \
  server/__tests__/ordinary-claude-startup-context.test.ts \
  server/__tests__/claude-startup-context.test.ts \
  server/__tests__/ordinary-local-vertex-sdk-query.test.ts \
  server/__tests__/chat-agent-context-startup.test.ts \
  server/__tests__/chat-account-startup.test.ts \
  server/__tests__/anthropic-api-sdk-model.test.ts \
  server/__tests__/ordinary-claude-information.test.ts \
  server/__tests__/published-host-knowledge.test.ts \
  server/__tests__/agent-context-compiler.test.ts \
  server/__tests__/agent-workspace-context.test.ts
# 175 passing checks

LOG_LEVEL=error npx vitest run \
  server/__tests__/google-workspace-sdk.test.ts \
  server/__tests__/claude-sdk-schema-registration.test.ts
# 37 passing checks

npx tsc --noEmit
npm run build:server --silent
```

Coverage includes Personal and Vertex ordinary admission; boot/project/publication
delivery into SDK options; actual published-memory reads; acknowledgement receipts;
publication refresh, absent enrollment, revocation, failure and cancellation;
actual startup error delivery before provider creation for unavailable/invalid
publications and explicit empty boot fallback when ContexGin is unavailable;
private/symlink project roots; selected-profile boundaries; every registered
credential/helper, Telos and web schema's canonical argument names (including
legitimately parameterless tools); Google numeric `pageSize`/`maxResults`, list
`ranges`, invalid types and operation combinations; and separate denial, expiry,
cancellation, retired-owner and uncertain callback outcomes. Configured Tool Library
schemas retain their existing exact JSON-schema passthrough adapter and tests.

## Accepted naming integration

Integrated accepted main `5d81903c4d6a9511d517304be84b81769b4e23e1` (PR1365)
after GitHub reported a real merge conflict. The accepted naming/diagnostic delta
preserves public request echoing, duplicate suppression, account naming and
transcript failure boundaries. Its `chat.ts` edits compose with startup context
and replacement preparation without changing their ownership or ordering.

The only manual conflict resolution selects a combined runtime revision and the
hash of the composed `chat.ts`. Every manifest entry is retained; both parents'
changed fingerprints are preserved except that shared composed hash. The source
artifact verifier passes at `v1.0.1205-claude-startup-naming`.

Combined-tree qualification: 171 checks pass across 11 focused startup, query,
account, naming, conversation-list and transcript-failure files, with one worker
and a 1 GiB heap. Review archives accidentally matched additional Vitest filters;
their passing results are excluded from this combined-tree count. Formatting and
whitespace checks pass. Hosted CI and trusted review of this integration delta
remain required. The completed independent full-source review of `b30c3196`
reported zero concrete blockers; its unchanged coverage remains the baseline.

## CI integration fixture correction

Hosted shard 2 in run `43772563660`, job `132992389700`, failed ten cases at
`tests/integration/ordinary-local-vertex-chat.test.ts:2277`. Every failure was the
old assertion that all fetches end in `/health`; the restored boot-context read
intentionally adds the selected agent's context endpoint. The same shard passed
518 other files and 7,357 checks. A single local journey reproduced that exact
assertion failure before the correction.

The offline fixture now supplies boot instructions at one exact mocked ContexGin
endpoint and retains the blocked health fallback. It rejects other requests and
asserts all first, replacement and cold SDK query prompts contain those boot
instructions. Production behavior is unchanged. All ten failed account/repository
journeys pass in four bounded batches, with 42 additional startup/Google schema
checks passing. Each batch uses one worker and a 1 GiB heap; filtered-out cases
are excluded from these counts. Source pins, scoped lint, formatting and whitespace
pass. An earlier multi-case reproduction exceeded the task's 120-second ceiling;
its retained uncertain receipt was inspected and that command was not replayed.
Current-head hosted CI and trusted review remain required.

## Accepted lifecycle integration

Integrated accepted PR1367 at `f7bab377d071e8cf15ac4eaf4e7e59fa687ec087`
after GitHub reported a concrete manifest conflict. Inspected the actual recovery
inspection, retained diagnostic and steering-acknowledgement delta: recovery reads
retain original operator/custody checks and cannot replay commands; completed
turns reject undispatched corrections and preserve uncertain dispatched outcomes.
These changes do not alter startup or replacement-context preparation.

Only the manifest revision label required manual resolution. All entries and both
parents' changed hashes are preserved. On the combined tree, 149 focused checks
pass across ten startup/lifecycle/server/client files, plus one actual-owner SDK
journey covering first/replacement/cold inputs; its 57 filtered cases are excluded.
One worker/1 GiB, source pins, formatting and whitespace checks pass. Existing
whole-source and independent review baselines remain; trusted integration review
and combined current-head CI are still required.

## Accepted transcript-handler integration

Integrated accepted PR1370 at `16e74da83fe6e18e3a027ea4e562cdf0afddddb6`
after GitHub reported a manifest conflict. Its only production delta retains the
original transcript cause before optional logging, using the accepted bounded
failure helper so logging failure cannot prevent the sanitized HTTP500 response.
Inspected all three accepted files and affected error-consumer assumptions; startup,
Google schemas and query preparation are unchanged.

The conflict resolution changes only the manifest revision label. All entries,
15 startup/test fingerprints and the accepted handler hash are retained. Twenty
HTTP/diagnostic/startup checks pass across three files on the combined tree,
one worker/1GiB; pins, formatting and whitespace pass. Prior native repository and
authorization checks and two macOS joined shards passed at `27a25d44`; its remaining
queued native jobs are preserved as baseline evidence, not current-head approval.
Trusted integration review and fresh combined CI remain required.

## Accepted task-run reporting integration

Integrated accepted PR1372 at `f8a421b2be65341ea86de126339fb0b668aa7cbb`
after GitHub reported an actual manifest conflict. Inspected the complete accepted
delta: task IDs retain separate observed native runs and verified parent tools;
late predecessor receipts settle only their own rows, while the latest execution
retains cancellation ownership. The coupled SDK/query/live/cold tests remain
byte-identical to accepted main, as do the query consumer and its evidence note.
No startup or replacement-context preparation changes were needed.

Only the manifest revision label required manual resolution. Every entry and
both parents' changed source fingerprints are retained. The combined tree passes
51 focused startup, query adapter, task consumer and retirement checks across five
files with no skips, one worker and a 1GiB heap. Exact-source fingerprints,
formatting and whitespace checks pass. Prior full and independent review baselines
remain intact; current combined CI and trusted integration follow-up remain
required. This integration does not activate a runtime or establish live acceptance.

## Acceptance still open

Source, landing, activation and live acceptance are distinct. This change does
not activate a runtime. Exact-current-head CI and trusted final Centaur LGTM,
recommendation `merge`, zero blockers remain landing gates.

The dated brief's literal **shared native auto-memory reads/writes** criterion is
not established. The authority-preserving shared-memory behavior implemented here
is accepted published reads plus the existing reviewed memory-candidate write
flow, equivalent to Codex. Native account settings/memory are not redirected or
exposed. If native auto-memory itself is required, the existing memory/readiness
owner must provide an explicit audience/account-scoped writable root and qualify
its read/write/revocation behavior before changing this adapter.

After an authorized activation, announce an exact supported Luna model and charged
account and obtain any missing runtime authority. Verify a fresh Personal and
Vertex Claude can state boot/project/published context without opening files; run
Google numeric/list calls and invalid arguments; exercise command/web approval
cards and an attributed AgentCommunication message. Record runtime version,
account/model, source head, activation and actual receipts. Offline peers are not
live Claude acceptance. Merge, activation and model-backed tests each retain
their own authority.
