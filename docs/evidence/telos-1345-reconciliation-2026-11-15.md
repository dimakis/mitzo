# PR #1345 accepted-source and shared-fixture composition

Sole integration writer: ordinary conversation
`1428dc32-6bd9-8974-949a-a60fd1eced22`. This updates the existing draft PR;
original head `a7cb0ac5d54d6eb85480b5516e8206402d6c2181` and author history
remain ancestors. No merge turn, readiness, deployment or staging action is claimed.

## Accepted source

Additive merge `baf2011626db3942f2760945880ee0a7226fd6ad` composes accepted
main `4bc83d18f24bb14f24b7c190a32c2a4fa0834963` (#1356), which retains accepted
#1342/#1362. The sole conflict was registry metadata. All 2,489 accepted keys
and this PR's overview entry remain; fingerprints use actual composed bytes.
Final runtime revision is `v1.0.1186-telos-sdk-fixture-composition`.
Accepted runtime/UI, privacy, recovery, Stop and permission guards are retained.

## Minimal shared fixture handoff

Fixture owner `2208b5d4-686e-8b94-82bc-8d46e0611614` explicitly handed off only
`tests/integration/ordinary-local-vertex-chat.test.ts` from published #1359
`0b93b77f6f5f8f43b02f611b66684c97fd3cd2f3`. Author attribution is retained.
No #1359 implementation, other fixture, registry or whole branch is imported.

- Exact preimage blob: `abba9b62246aa4f1037ce371e7a4babcb249883f`.
- Exact adopted blob: `47610a58827f5d700c3a5f023ac7d7549be23f84`.
- Adopted file SHA256: `721c4cdf15e7354e1d9ef26f27cb9e1ae79a46079b2af164a176f55dd2cd1bfd`.
- Independently packaged one-file patch SHA256: `98c09a893d56b92bbd6917d1ba2d43720e77b614eae343fdadb22393672dd8a4`.

Per-command information/repository work is observed before lifecycle assertions;
original phase failures are rethrown. Cleanup attempts every callback and resets
fixture state before surfacing failures. Actual guarded retirement/detach retain
both original failure references and first cause; disposal follows both successes.
The actual active-owner guard is unchanged. Superseded unconditional-finally
cleanup is excluded. Source-owner and independent published-source reviews resolve
that prior blocker; they are not this target's CI or final approval.

Each fixture phase and lifecycle observation remains bounded at ten seconds, and
the scenario remains sixty seconds. Total observation allowance increases.
Later active-input readiness explicitly changes from one second to ten seconds.
This is a fixture timing correction, not an unchanged-deadline claim or a runtime
permission change. Complete hosted failure causes remain unproved.

## Target qualification and retained failures

On the accepted-source composition, 330 tests across 13 focused suites pass with
one worker/1 GiB. The adopted fixture passes nine distinct selected checks in two
bounded runs: four default/explicit transfers (100.16s), then two excluded-profile
transfers plus three cleanup/actual-guard controls (36.50s). Ten selected native
messaging checks pass (21.54s). Scoped lint, formatting, whitespace and complete
source-artifact checks pass. These batches do not add historical runs as unique
coverage; original 149-test and earlier takeover evidence remain historical.

Prior target `7746a21f` run `43657212327`, Unit 2 job `132639229352`, failed four
repository-transfer cases at old line 1583 (`RUNNING` versus `TERMINAL`). The exact
four passed locally before adoption; that did not clear hosted failure. Queued
work continued near the lifecycle deadline, and a later selection refusal was
retained without asserting it as the original cause. All three joined macOS
shards passed on that prior head. Earlier hosted CT12 timeouts and the distinct
local artifact HTTP 503 / subprocess exit 71 remain failures with separate causes.
Earlier full-server typecheck heap exhaustion and native executor timeout are
not relabelled as passes. No real models or production writes were used.

Fresh exact-head CI and trusted final review remain required. Retain Centaur
baseline review `5905968622` on `0d65a690`, finding `CEN-017925FDE009`, its tested
101-child correction and original automatic job `7555` for prior `7746a21f`.
Successor service state must be inspected through its existing owner; a green
GitHub reconciliation workflow or internal FIXED entry is not final approval.
No forced duplicate review is requested. Bounded specialist authorization and
recovery returned no policy/contribution; no independent assessment is inferred.
Membership/discovery semantic dependencies and combined acceptance remain separate.
