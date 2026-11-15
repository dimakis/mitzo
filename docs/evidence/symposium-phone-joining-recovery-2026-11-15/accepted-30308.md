# Phone repairs against accepted repository discovery

Accepted main `30308c49d319d0f5c66d0235a4e069ceedd792fc` incorporates the
reviewed #1345 tree `33dc85bc68a0d2ebf114fcac87308e79b81dae1f`. This merge
retains phone baseline `de20999dc44d41bf412f6f4a61271100eb6414c3`, whose full
CI `43711198185` passed all 37 checks and whose trusted exact-head review
`5910662041` reports LGTM, recommendation merge and zero blockers. Its final
status was independently recognized as required from bot `337156191`, bound
by protection to App `5169606`. That evidence qualifies the baseline, not this
new composition.

The only conflict is the reviewed source registry. Its resolution retains the
exact union of 2,505 phone-parent and 2,504 main-parent entries: 2,506 unique
keys, recomputed from actual source under revision 1198. All phone production
files are byte-identical to the baseline. Incoming discovery/read-access,
observation budgets, native-reader forwarding and Telos/peer-message contracts
are accepted source, preserved without branch-specific semantic edits. The
phone joining owner still resolves its current repository and permission
authority; this merge adds no fallback or wider authority.

All 14 repair anchors remain present, and the approved HTML SHA256 is unchanged:
`175e801ff2acd66cd8d176d56bd389da9439d75a4cf061e214b4220357894bbc`.
Owner/design checks pass 280 tests across 21 files in 13.81 seconds, with one
existing design skip. The authenticated review/refusal suite passes 35 tests in
11.03 seconds. Protocol, harness and client packages compile; source pin checks
pass. These are offline owner/application checks, not physical-phone evidence.

A preceding larger selection exceeded the executor's 120-second boundary and
has an uncertain SIGKILL receipt `a41864ed-e3c5-4af2-b03e-620d81dd9845`.
Its original log is retained. It completed the 71 SDK-tool, 33 peer-message,
27 backlog-tool and one actual fresh-agent application cases before reaching
the discovery file; there is no terminal suite summary. That batch is not
reported as a pass or replayed. The subsequent 280 owner/design and 35 review
checks are separate terminal selections. The rejected unsupported Vitest
option was a pre-test invocation error, retained separately.

The original phone request/client build/operation remain unavailable. Native
unknown-effect operations from other runs are retained without replay or a
causal claim. Current combined CI and a targeted exact-head Centaur follow-up
remain required. This preparation does not release an actual merge turn,
deploy anything or perform live-provider tests.
