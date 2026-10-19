# Agent Builder accepted-base conflict refresh

GitHub reported an actual conflict after accepted main advanced to Agent Builder `6de2a67c`. Only `server/connections/reviewed-handler-artifacts.ts` conflicted. The resolution preserves both pin sets and uses runtime revision `v1.0.307-symposium-forwarding.5`.

All 78 incoming files match accepted main except the additive design-document union and manifest. All 571 source fingerprints match. All incoming changed pins and existing B pins survive; forwarding producer/tests, artifact UI and existing approved-design content remain byte-identical. No provider, permission, routing, health fixture or delivery behavior was edited.

Focused checks: 194 pass across seven files, zero skips; design: 108 pass and one existing skip; protocol build and official source-fingerprint check pass. Existing capture evidence remains unchanged. The unresolved manifest reproduces TypeScript TS1185; an earlier tsx invocation hit sandbox IPC EPERM and is not counted as a contract failure. Normal commit hooks remain enabled.

Prior head `7813295e` ordinary CI39091742497 finished green on all eight jobs after one native-only retry. Its first native attempt completed the functional bridge but timed out during simulator shutdown; both failure and successful retry are retained in the adjacent CI receipts. This history does not qualify the new head. New exact-head CI, trusted whole-PR review and required App5169606 gate remain pending; automatic review ownership is preserved without a duplicate request.

Draft preparation only. Core consumes ancestry; its separate durable-reader work does not overlap these edits. Existing Work statuses and broader delivery/runtime acceptance remain open. No model, staging, production, activation or deployment was used.
