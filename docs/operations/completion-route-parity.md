# Completion qualification across accounts, engines and runtimes

This follow-on uses accepted main `bf6bc428786617feac601834e4f340254d44bd8f`, containing
PR #1158 merged from verified head `f40bf3c0ad060442ee7e42df4ff559895fc57d94`. The accepted
source tree matches that reviewed dependency head. This PR preserves its recovery
proofs and adds only the remaining delta. The dependency now owns both lazy recovery
iterators; this follow-on retains only the additional queued-row filter.

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
metadata cannot settle unknown downstream writes or release them for replay. The
original accepted live owner retains a no-hook witness before transport teardown;
exact provider completion can then consume that evidence. A cold owner cannot mint
missing proof, and legacy sessions without applicability/effect evidence stay held.

The OpenShell binding callback now re-enters its genuine admission owner, and that
owner obtains fresh asynchronous provider authority even when its last command has
settled. It still uses the original sandbox custody, account, current selection and
permission owners. No new supervisor, publisher, scheduler, registry or status table
is introduced. Later explicit commands retain FIFO and their original IDs.

The accepted dependency streams recovery observations lazily and qualifies any
pre-dispatch exception through its existing coherent proof. This follow-on filters
queued/cancelled probe rows with null native receipts before materializing them.
Rows with non-null native evidence retain the canonical parsing and lineage checks;
the universal effects audit still fences contradictory queued receipts. Independent
calls read SQLite afresh, including external writers.

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

History/database seeding is outside the timed region. Both active streams, replay,
tools, held maintenance and interrupted recovery are inside it. Both sides use the
identical corrected original-owner witness fixture and a 1 GiB heap with one worker.

| Work per measured workflow                                                 | Before            | After             |
| -------------------------------------------------------------------------- | ----------------- | ----------------- |
| SQL reads / writes                                                         | 1,944 / 1,126     | 1,944 / 1,126     |
| Rows materialized                                                          | 31,460            | 31,458            |
| JSON bytes of observed SQL rows                                            | 5,550,199         | 5,549,782         |
| Delivered / history-projected bytes                                        | 118,598 / 408,003 | 118,598 / 408,003 |
| Synthetic provider turns / peak queued successor depth                     | 50 / 1            | 50 / 1            |
| Helper processes / credential refreshes / provider RPCs / real model calls | 0 / 0 / 0 / 0     | 0 / 0 / 0 / 0     |
| Whole measured workflow median, 11 samples                                 | 191.70 ms         | 177.08 ms         |
| Observed timer-gap maximum median, 11 samples                              | 16.16 ms          | 12.79 ms          |

The isolated 44-observation recovery budget reduces materialized command rows from
484 to 44. The accepted dependency already owns the larger lazy-iteration saving;
this PR's remaining whole-workflow saving is two rows and 417 serialized bytes,
with identical SQL call counts, delivery/replay and dispatch counts. Applying the
candidate's 44-row bound to the unchanged accepted store is expected RED at 484;
the candidate is GREEN at 44, using the same fixture and instrumentation.

Whole-workflow samples range 155.29–256.62 ms before and
160.58–219.20 ms after. These overlapping samples do not establish an
end-to-end speedup; timer gaps include scheduling/instrumentation noise. Zero
physical/RPC counters describe absent external transports in this fixture. No
nested durations are summed and no population p95 is inferred.

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
swap allocation during focused checks. Initial commands used a 1 GiB Node heap and
one local test worker. The user then authorized heavier local validation: a fresh
check showed about 12 GiB inactive and 7 GiB file-backed pages (overlapping
categories), stable swap and no new swap-outs. A command-local 4 GiB heap completed
the all-source server typecheck, server build/artifact checks, frontend typecheck
and production bundle build. The prepared-consumer inventory now requires the
actual five delivery and two publication cases; independent Vitest discovery
matches every exact name. Combined-result CI and remaining platform qualification
remain required; local offline tests do not replace their gates.

The initial `4a2ecf63` local run passed 1,794 tests across 83 files in 85.94 seconds. Its two
opt-in skips were the component benchmark (separate repeated performance evidence
is above) and the physical Claude contract. The latter then passed separately in
its cached, unique, networkless container, checking controller/Landlock isolation
and the pinned Claude version without inference. The native API-start opt-in also
passed using checksum-verified Codex 0.160.0 and its matching code-mode helper;
synthetic credentials and interception stop before native `turn/start`. All 38
offline queue/approval/device-continuity browser checks passed in 33.7 seconds
across mobile WebKit, mobile Chromium and desktop Chromium; representative mobile
queue and approval captures were inspected. Full lint passed with zero errors
(22 warnings) and the repository format check passed.

The composition against the final dependency candidate passed 779 distinct tests
across eleven focused suites. One runtime case initially hit Seatbelt's socket bind
restriction; its complete 23-case file then passed on the host. Both full OpenShell
account journeys and the new pre-dispatch/cancellation/Retry fences are included.
All-source server typecheck and the complete server/frontend build passed again.
The tested accepted-main integration snapshot, before this evidence refresh, has
reviewed fingerprint
`bc2ade211d53d992a4b834aea5efad5d46eb2fc3fe50809fee4c63121b576c74`.
The JSON records unchanged runtime/store/fixture hashes separately.

The complete unsharded prepared-consumer owner also passed all seven cases against
that composition through its actual reporter/exit validator: five delivery cases
took 176.63 seconds and both publication/cold-recovery cases took 332.02 seconds.
Fresh-process wall times were 179.303 and 334.798 seconds respectively. Both accounts
retained the original published lineage after the later prompt and cold reopen.
The evidence JSON separates retained initial coverage from these integration checks,
and retains the exact case results, source and log hashes. These offline passes do
not release sessions.

No staging, production mutation/deployment, real provider calls, session resume or
queue release occurred. Runtime adoption and live account/engine/placement behavior
remain separate authorized phases. Historical process causes and historical approval
visibility cannot be reconstructed from the new evidence. The
[future recovery procedure](completion-route-recovery.md) has not been executed.
