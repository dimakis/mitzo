# Independent follow-up to the consolidated review

S9 `b896d14d79d52682`, parent `85e8444019a4ae4a`: **active**. This is an
acceptance-engineering increment in PR1018, with user-authorized gated merge.
It does not finish feature acceptance. The original UX01–UX24/CT01–CT20 map
remains intact, with a deduplicated review overlay rather than new phase records.

## Source and custody

[Exact sources and file hashes](audit-source.json) distinguish accepted main
`fea33e215b0d1bcf29604aa13e793329588a2980` from disposable combined candidate
`c6e55fb9b47df1726f4806fc5142e3e45811eaad`. The latter composes S7 PR1019
`b101e78ee8f04cad93d1ffd90c2b3bb84a82f0a8`, priority PR1009
`f5d54268a3a71b94d5d70b01c779df19389a2734`, S5 PR1013
`75a9937c2a4689186797e4772bfaea4c76e84293`, and foundations preparation
PR1017 `ea40e9a281afe23dbb306b630cab3c4236954627`. All four are **unaccepted
candidates**, not accepted prerequisites. Foundations preparation is not a repair.

The composition preserved S7's complete replacement `TodoDetailView.tsx` when
priority conflicted with it. Other resolutions retained the composition's design
document and reviewed-handler manifest. These choices are diagnostic only: no
production file, merge resolution or governance manifest is included in PR1018,
and the composition is not runtime-qualified. Missing priority integration is a
real consumer gap on these candidate sources, not an accepted production merge.
The newer S5 source resolves its earlier app/chat/Codex integration conflicts;
we did not repair those owners. S5's source/interface handover remains authoritative.

The original frozen mock hash remains
`97efd217cdd8246ee868a7165d2f0272b1d0b0fe76982d02dbb9f48abcfae4ab`.
No design protection, original review failure or planned S1 evidence was changed.
Historical reports describe their own commit; later results do not rewrite them.

## Contracts and results

[Structured results](audit-results.json) link raw reports, commands, counts,
screenshots and test/config hashes. Counts overlap earlier runs; do not add them.
All local runs use one worker and a 1 GiB Node heap. Supertest sockets and macOS
browser execution run outside Seatbelt. No application backend, provider, native
runtime, model call, staging operation or deployment is started.

- The existing 49 focused checks pass on accepted main and on the disposable
  composition. These prove the existing isolated shared-owner boundaries, not
  exact S5 worker delegation or a full Telos/Symposium feature journey.
- Seven foundation assertions collect successfully through real Node owners,
  a real hook/client, actual Express routers, and canonical SQLite. **Five fail,
  two pass** on the combined source. Store-local and HTTP advisor failures
  localize the same canonical schema defect; they are not four independent bugs.
- Desktop Chromium and narrow mobile WebKit exercise real mounted Telos pages,
  canonical DTO/client/hooks/event bus, shared shells/styles and retained bytes.
  Each runs eight required UI contracts in both light and dark themes. The
  browser-startup and canonical priority/material controls are separate from
  feature acceptance. Required UI failures are recorded as failures, not skips
  or passing assertions that bugs exist.

| Review ID     | Independent observed boundary                                                                                                                                                                                    | Repair ownership and remaining requirement                                                                                                                                                                                                                       |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T-UI-01       | New item opens mandatory legacy capture instead of ordinary advisor entry.                                                                                                                                       | S7 owns entry; full source exchange, ordinary advisor/save journey still awaits S5a/S8. The fixture mounts actual Telos routes, not full ChatView.                                                                                                               |
| T-UI-02       | Clicking the selected retained material title does not display r1 inside the app; no exact-revision read occurs. r2 has deliberately different bytes.                                                            | Symposium artifacts is the shared WorkOutputs/viewer/store/versions-route producer; S7 consumes it in TelosItemWorkspace. Do not create a competing viewer. S9 will verify that exact consumer revision.                                                         |
| T-UI-03       | A kind:null legacy parent has a real persisted child, but no child navigation.                                                                                                                                   | S7 preserves actual hierarchy without fabricating kind or coordinator authority. Leaf behavior remains to verify after repair.                                                                                                                                   |
| T-UI-04       | Context is expanded and lacks an accessible disclosure. Captures show raw field labels and empty values.                                                                                                         | S7 owns disclosure and narrow layout, foundations owns readable role context. Tests stop at the failed disclosure: later readable-label assertions are pending, not observed passes.                                                                             |
| T-UI-05       | After actual event-bus todo_update, the mounted tree/detail retain the old summary/status; canonical record reads do not increase. Tree category display also stays old.                                         | S7 owns invalidation/useTelosRecords and consumer races. Category transport values are explicit synthetic DTO overlays because canonical category persistence is still broken; this is not category-save evidence. Stale-request races remain pending.           |
| T-UI-06       | Computed primary-action foreground differs from the shared --color-on-accent token in both themes.                                                                                                               | S7 narrows generic CSS color inheritance; captures and computed colors reproduce the shared accent regression. This token check is not a complete numeric contrast/native-control audit.                                                                         |
| T-PRIORITY    | Actual replacement workspace has no Priority control, so round-trip assertions cannot proceed. The canonical MGMT owner separately persists all 1–10 and rejects 0/11/1.5 without changing confirmed 10.         | Priority produces canonical projection/shared mutation/control; S7 integrates the header/tree. Save/reload/rejected-save assertions remain blocked at the missing control; concurrency and same-ID priority refresh remain pending. Preserve star/pin semantics. |
| T-S5          | Accepted-main/runtime candidate can compose; existing shared command/queue/task fences pass.                                                                                                                     | S5 still owns exact worker/dispatch authority/replay and receipt navigation. This suite's task dispatcher test is not the new delegateSlice journey. Accepted source and remaining exact-delegation evidence remain pending.                                     |
| T-FOUNDATIONS | Actual advisor setup/capture/preview succeeds, save returns HTTP503. Store-local saves expose canonical categories mismatch. The stale preallocation case returns an error but leaves the hook locked/uncertain. | S5a owns canonical schema/write invariants and positive same-request preallocation proof, then S5b repository-free admission. No fixture-only categories column or fake recovery DTO is introduced.                                                              |

The two passing recovery controls are deliberately different: a committed response
loss reopens stores and recovers the original allocation with no second preparation;
a real HTTP409 after an awaited preparation keeps the original UUID/settings/context
on reload and retry. **Generic409 never proves absence of an allocation.** The
stale test has independent server-side observation that preparation was never called;
it does not prescribe a client reset based on status alone. A positive typed proof
contract is still unavailable. Dropped recovery evidence, pre-commit allocation loss,
readable role context and full accepted S5 integration remain pending.

## Reproduce and consume

Run from the exact source composition, with installed dependencies and a clean
accepted MGMT reference pinned by `fixtures/canonical-schema-source.json`:

```sh
NODE_OPTIONS=--max-old-space-size=1024 node_modules/.bin/vitest run tests/integration/telos-s9 server/__tests__/collaboration-joining-owner.test.ts server/__tests__/collaboration-ordinary-delivery.test.ts server/__tests__/collaboration-ordinary-replies.test.ts server/__tests__/ordinary-contributor-stop.test.ts --maxWorkers=1
NODE_OPTIONS=--max-old-space-size=1024 node_modules/.bin/vitest run --config tests/integration/telos-s9/red.vitest.config.ts --maxWorkers=1
NODE_OPTIONS=--max-old-space-size=1024 S9_MGMT_SOURCE_ROOT=/path/to/clean/accepted/mgmt node_modules/.bin/playwright test --config tests/integration/telos-s9/ui.playwright.config.ts --project desktop-chromium --workers=1 --output=/tmp/s9-desktop-results
NODE_OPTIONS=--max-old-space-size=1024 S9_MGMT_SOURCE_ROOT=/path/to/clean/accepted/mgmt node_modules/.bin/playwright test --config tests/integration/telos-s9/ui.playwright.config.ts --project mobile-webkit --workers=1 --output=/tmp/s9-mobile-results
```

The explicit red and candidate UI configs assert required successful behavior.
They are opt-in pending-contract suites, not default green CI evidence, and contain
no permanent skips. Promote repaired contracts to normal regression discovery once
accepted; do not weaken assertions. No guessed future allocator, error DTO, viewer
or repository-free adapter is tested.

Needs you, canonical category persistence, S6 coordination, S8 full ordinary chat
journeys, non-code workspaces and final visual/lifecycle acceptance remain pending.
Captured 320 px/mobile and desktop light/dark states are diagnostics compared with
the retained approval, not UX signoff. Actual Symposium application journeys remain
with Symposium acceptance; shared-owner isolation from Telos does not replace them.
CT19 still requires a separately authorized single-runtime window. Any model-backed
qualification must explicitly select supported Luna and state the charged account.
Keep S9 and its parent open after this evidence PR merges.
