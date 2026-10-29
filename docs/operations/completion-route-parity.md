# Completion qualification across accounts, engines and runtimes

This follow-on starts at PR #1158 head `9dd56c1abf5bc01053d7f333a957f1d453fae80a`.
The dependency remains owned by its implementation session. Its subsequently verified
open head is `8fa10177b2c2a5ceb3d01bf527206a267cbdabc6`; the changes since the initial
head are CI/fixture corrections, not a replacement completion implementation.
An open PR's temporary merge SHA is not acceptance. Integrate its actual accepted
main result before landing this follow-on and retain only this PR's delta.

## Reachable route matrix

“Gated” below means implemented and reachable through the named entry owner when
its deployment, target, account/catalog, profile/context, permission and physical
qualification gates pass. It does not mean that an account or running deployment
has been enrolled. Account authentication/billing, engine and placement remain
independent selections. The pure compatibility resolver is not admission evidence.

| Context/account authentication                            | Engine               | Placement                 | Status and authoritative path                                                                                                              | Implementation and offline evidence                                                                                                                                                                                       |
| --------------------------------------------------------- | -------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ordinary ChatGPT host-login subscription                  | Codex                | Local Host                | Gated: public Local entry → local entry/selection/owned runtime → frozen host bootstrap/login → owned admission                            | Native physical task route. Subscription delivery, preparation/adoption, commit, two reviews, approval, publication, later prompt and cold continuation; native authority/lifetime negatives.                             |
| Ordinary OpenAI API credential                            | Codex                | Local Host                | Gated: same public entry and local owners; API login/key authority is separate                                                             | Same physical task operations, independently parameterized account journeys; no subscription credential or billing fallback.                                                                                              |
| Ordinary configured OpenAI API connection/custom endpoint | Codex                | Local Host                | Gated by configured protocol/catalog/credential connection; frozen API bootstrap carries the connection and retains its exact private home | `frozen-host-codex-bootstrap`, owned API and configured connection tests. Default API account journeys alone do not qualify arbitrary endpoints.                                                                          |
| Ordinary brokered Codex OAuth subscription                | Codex                | dedicated OpenShell       | Gated: public OpenShell entry → OpenShell entry owner/owned runtime/admission → selected sandbox runtime and provider grant                | Exact provider ACK/turn reconciliation, workspace preparation/seed, edit/commit, reviews/publication, later prompt, cold owner, lifecycle and replay composition. External provider/sandbox/GitHub effects are synthetic. |
| Ordinary API credential with pinned sandbox provider ID   | Codex                | dedicated OpenShell       | Gated: same OpenShell owners; explicit API enablement and provider binding required                                                        | Same composed journey separately for API. API credentials are not acquired from the subscription or host login.                                                                                                           |
| Ordinary configured custom API connection                 | Codex                | OpenShell                 | Unsupported by current configuration inventory (`!profile.connection` is required)                                                         | Deterministic route omission/refusal; a compatible generic endpoint cannot create a sandbox provider grant.                                                                                                               |
| Ordinary `sandbox-chatgpt` native-auth profile            | Codex                | either ordinary placement | Unsupported ordinary admission                                                                                                             | Dedicated Symposium authentication does not authorize ordinary chat.                                                                                                                                                      |
| Ordinary Anthropic Vertex ADC/project/region              | Claude SDK           | Local Host                | Gated: Local entry → Vertex owned runtime/SDK authority/command owner → SDK query adapter                                                  | Exact input/result correlation, FIFO, settings between turns, process-close custody and retired-hook fences; shared query-loop/replay. No Codex thread reconciliation is invented.                                        |
| Ordinary Google Vertex ADC/project/region                 | Gemini               | Local Host                | Gated: Local entry → Responses-named existing owned runtime/store → Gemini adapter                                                         | Native Gemini response/checkpoint identity, fixed model/thinking, credential recheck after token waits, shared stream/replay, cold history. The store's compatibility name does not select Responses execution.           |
| Ordinary Vertex account                                   | Claude SDK or Gemini | OpenShell                 | Unsupported by current ordinary inventory/dispatch                                                                                         | No silent substitution with Codex or credential borrowing.                                                                                                                                                                |
| Retained OpenAI Responses history                         | Responses            | Local Host                | Retained-history/continuity only; new entry rejects `new_work_harness_unsupported`                                                         | Existing readers remain for saved state. This work does not revive new custom Responses execution.                                                                                                                        |
| Ordinary accounts with another provider's engine          | mismatched engine    | either                    | Unsupported by `sessionHarnessForProvider` at public new-entry dispatch                                                                    | Schema/account/target checks precede effects. API+subscription are account classes, not alternative engines.                                                                                                              |
| Symposium pinned OpenAI API sandbox provider              | native Codex seat    | owned shared OpenShell    | Gated by seat dispatch, membership/authority grants, exact recipient claim and reviewed runtime/controller                                 | Separate native seat/attempt registry and completion-checkpoint tests. Ordinary chat acceptance cannot qualify this route.                                                                                                |
| Symposium native ChatGPT subscription                     | native Codex seat    | owned shared OpenShell    | Gated by dedicated subscription route/private auth/attempt home/controller and lifecycle                                                   | Exact attempt input, terminal conflicts, joined cleanup, checkpoint and continuity contracts; no ordinary host-login reuse.                                                                                               |
| Symposium Vertex ADC with pinned provider route           | native Claude seat   | owned shared OpenShell    | Gated by Vertex seat launcher, reviewed image/provider and seat grants                                                                     | Separate native Claude lifecycle/terminal evidence. Codex receipts are not Claude completion authority.                                                                                                                   |
| Symposium Gemini or Responses                             | Gemini/Responses     | either                    | Unsupported native seat dispatch                                                                                                           | The current source guide explicitly defers native Gemini.                                                                                                                                                                 |
| Symposium independent Local Host selection                | any native seat      | Local Host                | Unsupported as an ordinary placement selector in current seat dispatch                                                                     | A host controller process for the shared sandbox is not a separately admitted Local Host seat route.                                                                                                                      |

All omitted account/engine combinations are unsupported. Ambiguous subscription
plan `api`, Ask mode on OpenShell, shared/retained targets presented as new dedicated
targets, missing provider IDs/grants, stale catalogs, revoked logins, changed account
revisions and changed permissions remain refusals. Local Host physical Codex
qualification is the current Mac contract; Linux toolchain evidence does not grant
a Linux native-host route. Vertex target availability on another host still needs
its own actual filesystem/toolchain/admission qualification.

The entry/admission/dispatch sources are `ordinary-local-codex-entry.ts` (including
its new-entry engine guard), `ordinary-openshell-codex-entry.ts`, the corresponding
entry owners, `ordinary-local-vertex-owned-runtime.ts`,
`ordinary-local-responses-owned-runtime.ts`, `account-profiles.ts`,
`symposium-seat-runtime.ts` and `symposium-session-runtime.ts`. The current
[Symposium guide](../features/symposium.md) remains authoritative for seat behavior
and the uninstalled public collaboration preparation/send ports.

## Completion and authority changes

OpenShell's local CLI exit can close a transport while the remote provider continues.
The adapter now opts into exact-turn recovery independently of Local's terminal-close
policy. The existing conversation/store owners reconcile the retained command,
attempt, provider thread/turn and generation under fresh route authority before
acknowledging recovery. Missing/wrong/active provider evidence remains fenced.
Provider completion is retained separately from pending tools and completion phases;
metadata cannot settle unknown downstream writes or release them for replay.

The OpenShell binding callback now re-enters its genuine admission owner, and that
owner obtains fresh asynchronous provider authority even when its last command has
settled. It still uses the original sandbox custody, account, current selection and
permission owners. No new supervisor, publisher, scheduler, registry or status table
is introduced. Later explicit commands retain FIFO and their original IDs.

Recovery observations lazily read the existing command rows until the relevant
witness is found. The old eager materialization of the complete command history is
removed. Queued/cancelled rows without native receipts are omitted from the probe;
rows with retained native receipts keep the existing lineage/unknown-acceptance
rules. Independent calls still read SQLite afresh, including external writers.

Real node-gyp qualification exposed Python bytecode writes inside fingerprinted npm
sources. Setup now gives Python a fresh cache inside its existing invocation scratch.
The cache is joined and deleted before setup returns; mutable bytecode is not reused
as toolchain authority. npm downloads, Node headers and verified toolchain/dependency
artifacts retain their existing caches and integrity rules. The offline native
qualifier owns its own fresh scratch and withholds readiness until cleanup succeeds.

## Composed validation and its limits

Local account journeys use real temporary Git/SQLite, public admission, durable client
outbox, native FIFO, preparation/adoption, trusted selected-file commits, existing
review/approval/publication and later prompts. Both account types now cold-reopen the
same published lineage, preserving custody, committed HEAD and the publication rather
than creating another PR. Physical readers, provider/adviser transports and GitHub
are synthetic. No model is invoked by the adviser fixtures.

The OpenShell journey uses real `RepositoryWorkspaces` preview/preparation/claim/seed,
OpenShell owned runtime and admission, `openCodexChat`, the native store/FIFO,
OpenShell lifecycle store, query loop, EventStore, client parser/history loading,
`createConnectionsRuntime`, `OpenShellGithubSandboxTransport` and the existing host
publisher/review/capability-operation owners. Synthetic transport maps the sandbox
filesystem to a temporary actual Git repository; on Mac it adapts GNU realpath's
`-e` spelling for this existing fixture path. It is not physical OpenShell isolation
qualification. Provider and GitHub replies are synthetic, and actual Git bundle
export/reconstruction/push goes only to a temporary bare repository. The approval
card must survive a real client reconnect/history request before its permission is
resolved. Cold recovery preserves the original sandbox and publication receipt and
does not acquire the newly configured publisher as a sandbox credential attachment.

Claude/Gemini tests exercise their actual supported terminal/checkpoint and shared
stream paths separately. Existing configured-endpoint/API tests qualify connection
selection rather than assume protocol compatibility. Symposium tests retain its
recipient/attempt, terminal conflict and joined-cleanup boundaries separately. They
do not establish arbitrary repository/publication support for those engines or
native collaboration account/runtime parity.

## Controlled efficiency evidence

Raw samples and fixed operation counts are in
[evidence/completion-route-parity.json](evidence/completion-route-parity.json).
The repeated workload uses two active stream owners, 200 retained native commands
per session, 25 synthetic turns and delayed tool results per session, 50 history
switches, held single-flight maintenance, and exact interrupted recovery with one
retained FIFO successor per session. It composes actual query-loop, connection/session,
EventStore and native command owners. Provider terminal effects are synthetic.

| Work per repeated workload                                                 | Before            | After             |
| -------------------------------------------------------------------------- | ----------------- | ----------------- |
| SQL reads / writes                                                         | 1,794 / 1,118     | 1,794 / 1,118     |
| Rows materialized                                                          | 33,060            | 31,362            |
| JSON bytes of observed SQL rows                                            | 5,793,512         | 5,470,266         |
| Delivered / history-projected bytes                                        | 118,598 / 408,003 | 118,598 / 408,003 |
| Synthetic provider turns / peak queued successor depth                     | 50 / 1            | 50 / 1            |
| Helper processes / credential refreshes / provider RPCs / real model calls | 0 / 0 / 0 / 0     | 0 / 0 / 0 / 0     |
| Whole-workload median, 11 samples                                          | 150.22 ms         | 148.78 ms         |
| Observed timer-gap maximum median, 11 samples                              | 11.56 ms          | 9.45 ms           |

The isolated 44-observation recovery budget reduces materialized command rows from
9,240 to 44. Whole-workload samples range 132.42–516.34 ms before and
131.57–514.66 ms after; timer gaps include scheduling/instrumentation noise. These
small timing differences do not establish a reliable end-to-end speedup. Counts
establish less materialized work with identical delivery/replay and dispatch counts.
Zero physical/RPC counters describe absent external transports in this fixture,
not a claim that real admission needs no physical effects. No nested durations are
summed and no population p95 is inferred from these samples.

#1158's prepared-owner, topology-helper, credential-RPC and projection budgets remain
in place. This PR neither reimplements its performance/approval refactor nor combines
the separately retained screenshot, WebSocket or credential-relay features.

## Development and remaining acceptance

Actual Mac setup installed its own pinned npm version and Node 24 toolchain, loaded
native dependencies, then compiled/loaded an ABI-137 addon through task-owned paths.
After the Python fix, unchanged setup reuse performs probes and zero installs.
A disposable Linux ARM64 container compiled/loaded the same ABI with verified public
Node 24.22.2/npm 11.18.0 artifacts, one CPU, 1 GiB RAM, no network and no account
credentials. That is native compilation evidence; full-project setup/helper adoption
inside an admitted OpenShell sandbox remains unqualified. The cached generic image's
original Node 22/npm 11.11 tools did not satisfy the project contract and were not
silently accepted as Node 24/npm 11.18.

The Mac remained at pressure level 2 with 48 GiB physical RAM and stable/decreasing
swap allocation during focused checks. Commands used a 1 GiB Node heap and one local
test worker. Full all-source compilation, builds, browser/native qualification and
combined-result CI remain required; offline runtime tests do not replace them.

No staging, production mutation/deployment, real provider calls, session resume or
queue release occurred. Runtime adoption and live account/engine/placement behavior
remain separate authorized phases. Historical process causes and historical approval
visibility cannot be reconstructed from the new evidence. The
[future recovery procedure](completion-route-recovery.md) has not been executed.
