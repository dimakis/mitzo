# Reviewed API templates: Phase 3 acceptance

Existing Telos `e8ae49e9b2f89183`, parent `a27aa207cce82024`. Initial refreshed main
was `d1a3c66a402fe8f027ac844e8fd2717d7044fa13`. This record describes offline source
implementation; source acceptance requires all four dependent PRs and their
exact-current-head gates. No live route is qualified or activated.

## Review slices

1. [Private contract/publication #991](https://github.com/dimakis/mitzo/pull/991):
   strict Home Assistant entity-state configuration, exact mapping, immutable
   receipts and portable references.
2. [Admission/dispatch #992](https://github.com/dimakis/mitzo/pull/992): local API
   selection, existing connection approval and request boundary, exact exposure,
   dispatch and retained continuation mappings.
3. [Library editor #993](https://github.com/dimakis/mitzo/pull/993): bounded
   save/authorize/verify/publish UI, closed retained-owner IPC and inspectable source.
4. [Acceptance #994](https://github.com/dimakis/mitzo/pull/994): pending-approval session revocation, transitive implementation
   drift, verification races, import/export and cold-resume regressions, plus this
   operating documentation.

Every merge requires current-head green CI, two trusted actual Centaur LGTM/merge
reports with zero blockers, resolved review threads, accepted-main ancestry and
the official fenced squash gate. Accepted commits, reviewed heads, review IDs and
matching trees are recorded in the external Phase 3 evidence bundle and existing
Telos items. A PR or queued review is not acceptance.

Accepted preceding slices: #991 `5b3d32530a7cac8ee9a30788f86950eafca93e7b`; #992 `2825699deeb1dcbc2182d4f30037cb016c403344`; #993 `b0d7d94b9d9551ccd5006feceb8c10a072271afc`. The final acceptance slice is recorded only after its own exact-head reviews and CI pass.

## Deterministic coverage

Fake HTTP/vault adapters, temporary stores and mocked provider runners exercise
the production contract. Browser fixtures bundle the actual Agent Library page
and intercept all HTTP and WebSockets. No personal connection configuration,
credential, API target or model is used.

| Contract             | Evidence                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Test first           | Missing catalog/execution modules and missing Configure UI recorded red. Session revocation during awaited approval reproduced an actual unwanted request; the fix registers pending API and separately selected RequestConnectionAccess approvals under the existing connection cancellation boundary. Mobile WebKit selects reproduced 24px height before extending the shared native-select rule. |
| Publication          | `api-tool-catalog.test.ts`: strict configuration, verification required, idempotent publication, invalid endpoint/method/entity/schema, scope mismatch, invalid output, concurrent edits, cancelled verification and newer failed verification superseding older success. Temporary grants always disappear.                                                                                         |
| Version and drift    | The same suite changes a reviewed execution-helper fingerprint independently of the template and requires explicit re-save/reverify/republish. Old receipts refuse resolution. All registered source hashes and the runtime revision are bound conservatively.                                                                                                                                       |
| Approval and effects | `api-tool-execution.test.ts`: exact definition, real connection engine with fake sender, `{}` only, canonical RequestConnectionAccess approval, permission/connection/configuration/session revocation and cancellation during approval. Denied cases read no credential and send no request.                                                                                                        |
| API lifecycle        | `responses-chat-session.test.ts`: both local API providers configure/verify/publish/assign/invoke, preserve exact optional exposure, refuse aliases/wrappers, export/import only references, reject foreign receipts, retain original profile selection across store reopen and reject replacement tool definitions on current dispatch and cold resume.                                             |
| Operator authority   | `api-tool-router.test.ts` and retained-owner IPC tests: same-origin requests, existing recent authorization, real auth-session revocation, closed operation allowlist, private draft projection and no implicit requests.                                                                                                                                                                            |
| Supervised bootstrap | `api-tool-bootstrap.test.ts` and `symposium-custodian-entry.test.ts`: both entry points use one initializer; temporary metadata and fake vault/HTTP verify publication, disabled/invalid settings fail closed, and the credential-free child reauthorizes browser sessions and forwards only validated recent authority. Private Keychain settings remain excluded from its environment.             |
| Cancellation         | `api-tool-cancellation.test.ts`: actual owner IPC through the verification router aborts on cancel, timeout or disconnect, prevents proof publication, releases temporary grants and waits for HTTP cleanup before owner drain. Editor and intercepted browser fixtures also cover missing static AbortSignal helpers on older WebKit.                                                               |
| Compatibility        | Existing selection/catalog/profile and connection/capability tests cover missing versus empty tools, published/admitted immutability, route refusals, canonical identity and write approval/idempotency/retry contracts. No write template is added.                                                                                                                                                 |
| UI                   | Intercepted 320px WebKit/Chromium and desktop Chromium, dark Lavender/System and light Teal/Georgia, failed saves/verifications and retries, source inspection, publish, Escape/focus return, preserved drafts, overflow and 44px controls. Captures: `docs/design/assets/api-template-*.png`.                                                                                                       |

Focused local runs use one worker and a 1 GiB Node heap; broad builds/tests are CI
work. One design-test invocation accidentally omitted the worker argument; it is
recorded in external execution evidence rather than represented as constrained.
Mac browser fixtures use the approved execution path outside Seatbelt, with the
sandbox flags intact. Review and CI receipts are distinct from test evidence.

## Remaining qualification

Phase 1 `88761f514b081ca1` and Phase 2 `fe020c5eb8557e9a` remain source accepted with
live qualification outstanding. Phase 3's intercepted fixtures establish no live
API/authentication/UI-to-provider qualification. Any such run needs a separately
selected and explicitly authorized target. Model-backed tests must select a
supported Luna model and declare the exact model and charged account beforehand.

Canonical staging and its pipeline are stood down. No checks, enqueue, activation,
deployment, recovery or restart is part of this work. Production configuration is
not a fallback. Phase 4 Tool Builder `53c2180aaf6ca8f3` remains outside this scope.
