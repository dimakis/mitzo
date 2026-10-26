# Local agent efficiency

This change builds on progressive integration discovery for ordinary owned Local
Mac Codex chats. See [OpenShell agent efficiency](openshell-agent-efficiency.md)
for the corresponding sandbox-owned delivery boundaries and separate measurements. It does not change model selection, compaction policy, repository
custody, native permissions, credentials or staging/production state.

## Codex boundary

The pinned Codex app-server already budgets model-facing function output and owns
conversation compaction. Its Code Mode path can retain raw function output while
projecting a smaller model-facing payload. Mitzo must not prune native history or
replace that mechanism. Mitzo also normalizes its own dynamic-tool results _before_
Codex receives them; the former text adapter discarded everything after 65,536
characters. That producer boundary needs complete-data handling independently.

See the official [app-server contract](https://learn.chatgpt.com/docs/app-server)
and [tool response guidance](https://developers.openai.com/cookbook/examples/gpt-5/codex_prompting_guide).
The inspected pinned source is `codex-rs/core/src/tools/context.rs` and
`codex-rs/ext/skills/src/render.rs` in the reviewed 0.160.0 qualification source.
These sources establish ownership; serialized byte measurements are not model-token
counts or proof of lower provider latency.

## Text results

Owned local integration text and `GitHubRead` results larger than 8 KiB become explicit JSON
previews with head/tail excerpts, total bytes, digest and an opaque `outputId`.
Complete text is retained in the existing private conversation database, scoped to
the original conversation/account, integration tool and a private digest of its actual launch configuration, effective cwd/environment and exact descriptor. Changed task arguments or source inputs invalidate old references even after restart. `ReadToolOutput` supports
bounded UTF-8 byte pages with UTF-16 offsets and literal search. It rechecks the
selected tool, original peer/source ownership, current operator/runtime and skill
policy. Native `GitHubRead` references expire when their original runtime ends, because a fresh credential admission cannot prove continuity of the old source. Its existing 64 KiB trusted read ceiling remains in force. Output IDs grant no permission, filesystem access or cross-chat lookup.

Retention is a derived-output cache: individual outputs are limited to 4 MiB,
each conversation retains at most eight, and outputs expire after 24 hours.
The private ledger retains at most sixteen globally, bounding payload storage to 64 MiB. Evicted/expired references explicitly
report unavailable. Retention failure or an oversized result preserves the
original operation outcome and instructs the agent to inspect state with narrower
reads. Never repeat a write just to recover its output. Existing image/rich-result
validation and native output handling remain in place. Authority-bearing repository, commit and publication receipts remain exact. This projection does not promise lossless rich-output retention.

## Tools and instructions

Large Mitzo profile, task, communication and history input schemas are described
on demand through the existing discovery catalogue. Their abbreviated direct
registrations retain the original name, provider call identity, input validation,
hooks, approvals and receipt owners. `DescribeIntegrationTool` returns the exact
contract with `invocation: direct`; `InvokeIntegrationTool` refuses those tools.
No proxy can manufacture a native profile/task call context.

Codex's native `skills.max_context_tokens` is set to 1500 for these chats.
`SearchSkills` queries `skills/list` for the admitted cwd, returns only enabled
skills in small searchable pages and preserves exact SKILL.md paths. Native skill
instructions and explicit invocation still apply. A host catalogue is not copied
into another registry or loaded at startup just to perform discovery.

Instruction assembly removes only byte-identical whole sections and retains all
source provenance. It never rewrites or drops distinct mandatory guidance.
Debug delivery manifests record section hashes/sizes, tool-definition bytes/count,
and the native skill budget. Tool observations record input/output bytes, duration
and outcome; prompts, arguments, output content and credentials are excluded.

## Failures and waiting

Typed failures distinguish cancellation, stale owners, invalid input, missing
approval and denied permission. Existing public permission reasons are preserved,
including expired approval and device takeover; an expiry is not called a user
denial. Unknown exception details remain outside model output. A diagnostic ID
correlates executor failures with sanitized host diagnostics. Uncertain effects
always require reconciliation before another write. No denial cache survives a
policy change or prevents newly authorized work.

`AgentCommunication wait` waits for incoming messages after a sequence, up to 30
seconds, using subscriptions instead of repeated model inbox calls. Subscribe
before reading to avoid a lost wakeup; recheck durable state and authority before
delivery, on timeout and on cancellation. Subscriptions are EventStore-instance-local wakeups;
timeout rechecks durable SQLite state if another process wrote it. The operation
sends no messages, grants no authority and does not resume paused recipients.
Native command/CI processes continue to use Codex's existing process handles;
this change does not add an arbitrary host process watcher.

## Offline acceptance

Run `node scripts/measure-local-agent-efficiency.mjs` for the single-worker,
1 GiB offline proof. It retains full test logs outside the model context and
prints a small JSON report with artifact paths, test outcomes, elapsed time and
serialized-byte measurements. No model, production credential or live server is
used. All provider RPC is synthetic.

The proof combines byte-budget regressions with the existing signed repository
preparation, dirty/stale/cancelled custody, workspace handoff, native edits,
trusted commits, publishing validation and source-scope suites. It exercises the
real owners rather than inventing a second preparation implementation. It also checks authoritative catalogue alignment, selected-source revocation, and the actual public qualified cold-admission case on its current tool registry. The cold case runs in a separate sequential stage with its own retained diagnostics; both stages use one worker and a 1 GiB heap. Passing
these component journeys does not claim a live autonomous end-to-end success
rate, model context peak, compaction latency or a production rollout. Those need
separately authorized live targets, explicit supported Luna and a named charged
account. Startup credential/helper optimization remains owned by PR #1118.
