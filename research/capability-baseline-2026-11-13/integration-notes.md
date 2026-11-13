# Visibility and session-controls integration note

Received 13 November 2026 from session-controls worker
`19fd1f53-c9aa-84b2-b511-07576fb8609f`, message
`b5ead4d4-5d75-4211-b3ce-f35018cebc90`. These findings are attributed;
they have not been independently checked in this baseline checkout.

- PR #1322 head `6d8a4f2b` moves `SessionAccessEvidence` from
  `server/session-access.ts` into `packages/protocol/src/session-access.ts`.
- Combining PR #1342 requires carrying `controls: SessionControlSupport` into
  that shared interface, preserving `helperSupport` and sanitized Access failure
  logging. The worker reports no readiness-schema change is needed.
- Refresh combined source fingerprints/revision and validate the actual Access
  consumer after resolving the interface move. Neither PR was changed here.
- PR #1342 compile/source preflight and frontend build reportedly passed;
  remaining CI was running or queued. This is not a complete CI result.
- The worker's slice checkpoint saved; its parent-feature handoff was not
  approved or applied. No feature acceptance follows from the slice checkpoint.

The attempted baseline Telos note used request
`baseline-controls-visibility-compatibility-20261113-b5ead4d4`. Its response could
not be parsed as JSON. A fresh item read did not contain that request, so the note
is not confirmed applied. The mutation was not repeated. This local note preserves
the evidence without claiming a Telos update, integration or merge.

## Restricted-skills qualification decision

Worker `3595f736-bf18-8c94-8663-add4ea46254d` reports in message
`11db56ca-0bc9-45a7-b8c5-88bd3ef3a66a` that legacy SDK mutable policy is not
bound to an immutable command across FIFO, startup and cold resume. The candidate
therefore refuses restricted executable skills in common v1/v2 paths and early
`startChat`, including empty ceilings, and supplies disabled catalog reasons.
Ordinary-route refusal remains unchanged. This supersedes any interpretation of
the earlier checkpoint as enabling restricted prompt execution.

The worker reports 639 focused tests across 18 suites, covering refusal and
shared executor primitives for exact names, intersections, delegation and
revocation. No live calls were made. Reported heads progress from
`a4f52636f0ca1221bd2f972e7d132d210996dfcc` through `19d39e89a` to `25a5748ba`;
the final full SHA, draft PR and CI receipts remain pending. Shared `chat.ts`
changes reportedly comprise one import and an early guard; reported inventory
revision is `v1.0.1127-restricted-skill-refusal`.

These are attributed findings, not independent source/test verification or
acceptance. All restricted prompt execution remains explicitly unsupported until
immutable durable command ceilings exist. No candidate integration occurred here.

Publication receipt from the same worker, message
`745d1231-c4f2-4fb0-be04-ce2825ad7e32`: draft
[PR #1343](https://github.com/dimakis/mitzo/pull/1343) against main, exact head
`25a5748baa21ccbe28d2d6cfed8adba2ccb21620`, reportedly clean checkout.
The worker reports all restricted-skills changes included; 639 focused tests
across 18 suites plus lint, format and source-artifact checks passed. CI run
`43482006129` was queued and review pending. This publication receipt is
peer-reported, not independently verified here.

Correction from the worker in message
`77555869-4d00-4701-91d5-64dd20d6edf7`: the previously reported read-back update
on slice `93d58df4` **did not apply**. The tool returned “did not receive approval”;
the worker states no item state changed and will not retry that denial. Do not
treat the earlier persistence claim as evidence. The PR, documentation and
received messages remain the retained handoff. Direct coordinator transport
remained unavailable. This does not establish feature integration,
current-head CI/review approval, merge or live acceptance. Use the exact PR/head
above for subsequent verification.

Later restricted-skills checkpoint, peer message
`10bddcc1-1f3e-4e2a-aca1-e44761b0f660`, supersedes the earlier PR head with
`b9e2adaba6288b4de69f02259b33c72181757cd0`. The worker reports 643 focused tests,
including malformed-description retention and YAML-merge refusal, with prompt
enablement still unsupported. This exact published head was subsequently fetched
read-only for the local compatibility analysis in
[local-integration-checkpoint.md](local-integration-checkpoint.md). Its CI/review
acceptance is not established here.
