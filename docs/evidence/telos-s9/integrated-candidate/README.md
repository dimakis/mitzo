# Integrated offline acceptance, 19 October

This additive map and required red case resume existing S9
`b896d14d79d52682` under `85e8444019a4ae4a`. Both remain active. The original
24 UX and 20 CT rows, frozen approval, historical failures and accepted PR1032
receipt remain unchanged. S5a's separate CT01–06 ratification is preserved.
The six peer rows extend the acceptance plan; they do not rewrite prior criteria.

`acceptance-plan.json` maps every approved row to its owner/reference, selected
source, reused boundary evidence and remaining joined/visual exception. A
published candidate, an accepted source, an integrated result, UX acceptance and
live qualification are separate facts. No live/model call, staging, deployment,
production fallback or completion update was performed.

## Exact source selection and assembly

Accepted main was `8a7dab62d502665b9fd349ead8f9895364b04a66`, directly after
accepted Symposium `3882cd217daad3e61e3642f84f7377c1d2caef52`. Published draft
heads were checked before use: S5b1048 `688d9a57`, its ancestor1046 `63c2679b`,
S6 1051 `aaaa006f`, S8 1050 `3f08dd81`, and S7 1052 `cb56f6c4`.
Full identities and selected file hashes are in `source-manifest.json`.
During execution S6 advanced to `00ff34da` with material recipient/dispatch fixes,
and S7 to `bfb26e39`. Their draft status was rechecked. The earlier assembly
conflict attempt and its S6aaaa run remain historical. S6 current selected tests
were rerun separately; the newer S7 follow-up is not claimed tested here.

Two attempts to assemble the production sources exposed unresolved conflicts:

- main8a7 + S5b688: `useExplicitLocalChat.ts`, `app.ts`,
  `reviewed-handler-artifacts.ts`, `repository-workspace-runtime.ts`,
  `repository-workspaces.ts`.
- S5b688 + S6aaaa: those five plus `packages/protocol/src/index.ts`,
  `codex-chat-session.ts` and `telos-work-delegation.ts`.

Both merges were aborted after retaining exact conflict bytes and identities.
No producer branch, production file or producer unit test was edited. S5b owns
its final-main reconciliation; S6 owns the combined authority/delivery integration.
Unchanged producer tests ran on separate isolated published candidates. Those
results cannot establish the unavailable combination.

## Observed results

| Exact source                | Actual scope                                                                                                                               | Result                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| main8a7 + dedicated S9 test | Actual application mount, real cookie auth, loopback HTTP, typed durable transcript client and canonical EventStore; no router replacement | 2 pass, 1 required red, 0 skips                         |
| S5b688                      | Unchanged CT09 actual-app/native-fake/MCP/Files/artifact/verified-completion journey plus the four existing S9 persistence/recovery cases  | 5 pass, 0 fail/skip                                     |
| S5b688                      | Focused fresh/upgraded schema, advisor HTTP, repository-backed CT06 and non-Git admission/delegation recovery owners                       | 39 pass, 0 fail/skip                                    |
| S6aaaa                      | Selected brief/current-authority/control store, HTTP, scope and tool contracts                                                             | 23 pass, 0 fail/skip                                    |
| main8a7                     | Existing approved-design ledger/reference integrity test                                                                                   | 1 pass, 1 existing local skip; no rendered visual claim |

These are separate scopes, not a combined full-feature pass count. Exact case
names, source pins, JSON results and raw logs accompany this document.

The peer reproduction uses two synthetically admitted independent ordinary Codex
identities, private directories and retained histories. The real application
serves both durable histories independently through the actual typed client,
redacts a private field, and rejects unauthenticated messaging and an internal
delegation request without its host credential. Text claiming merge, credential
or publication permission does not replace authentication.

The selected existing `POST /api/session-collaborations/:id/messages` path returns
its actual `503 execution_unavailable`; no native process or model starts. The
required test asserts successful admission and remains red. Its payload uses the
existing protocol schema, with no guessed new peer endpoint or tool name.
This is an operator-surface prerequisite reproduction, **not** agent sender,
delivery, idle/busy, ACK or reply acceptance. S6 may publish an appropriate peer
transport rather than enable this older collaboration surface; S9 must then test
that real native-tool/API/admission/queue/ACK/reply chain and retain this historical
failure. Direct delivery helpers or a fabricated operator sender cannot qualify it.

The initial in-memory HTTP diagnostic is retained separately. The final result
uses the accepted application's disposable loopback HTTP transport and its real
idle teardown. Private fixture account configuration, token location and databases
exist before application imports. Provider launches and external fetch are refused.
S5b's unchanged journey separately fakes native RPC/source/notification effects and
uses its documented source-mode MCP entry adapter; its filesystem, HTTP, custody,
permission, task callback, native admission and artifact owners remain real.

## Required next joined path

Reuse S5b's private canonical actual-app/native fixture and the accepted HTTP/
teardown pattern. Serve the actual frontend/router/store to outside-sandbox or CI
Playwright with real HTTP/SSE and the real production SendOutbox/storage. Do not
fulfill owned APIs or substitute fixed UI status labels. First join the non-Git
source/advisor/lead/exact-worker/send/ACK/MCP/Files/pending-review/operator-verify
path, then reuse CT06 for the repository counterpart.

Add decisive stale/lost-response/offscreen/reload/reattach recovery, S6 explicit
new-attempt brief adoption, replacement/late results, scoped holds and unrelated
Symposium isolation. S8 production route adoption and the actual shared-main
publication fence remain owner dependencies. The ten earlier metadata groups
are a coverage plan; reuse adequate owner evidence instead of multiplying tests.

Peer native discovery/read/send/reply, unrelated-item authorization, idle/busy
queue behavior, true sender identity, unknown/revoked/stale/unsupported recipients,
durable retries/restart and no transferred action authority remain pending. Final
desktop/mobile light/dark/lifecycle comparisons preserve the approved ledger,
mock hashes, settings/resources/drafts and normal/reduced motion. No new visual
approval or joined-browser result is claimed here. CT19 remains separately gated.

## Reproduce the required red

From the isolated accepted-main checkout, outside Seatbelt for the private listener:

```sh
NODE_OPTIONS=--max-old-space-size=1024 node node_modules/vitest/vitest.mjs run \
  --config tests/integration/telos-s9/integrated-candidate/vitest.required.config.ts
```

The config runs the required case explicitly with one worker, without skip,
quarantine or expected-failure conversion. A green default suite must not be
reported as peer messaging acceptance while this required path is unavailable.

## Imported readable evidence copies

The eight JSON files listed in [the formatting provenance record](imported-evidence-formatting.json) are formatted readable copies. Their parsed contents are unchanged. Their formatted hashes differ from the original raw evidence hashes. Original bytes remain preserved in frozen S9 commit `b8fd3a5a1b6aeeacc94ed0a71260d0f389e83dac` and its retained canonical source/diagnostic archives. Use the provenance record to distinguish original and formatted bytes; this formatting adds no test execution or qualification.
