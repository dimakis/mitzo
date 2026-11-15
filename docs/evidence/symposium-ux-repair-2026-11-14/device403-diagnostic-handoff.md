# Retained queued-admission failure evidence

The original full b6d CI43674377272 failed configured-personal multi-device
continuation at403:409 versus202. Original artifact14146656550 and log/hash
remain in `current-b6d2310a1/`. The original matcher/JSON report omitted the
response body/code. The existing shared-fixture owner2208 later recovered the
exact session/command-correlated runtime_unavailable/not_admitted log,
diagnostic103eedfc-54cb-419b-8670-0bca7695874b. The inner cause was retained in
memory but not serialized there. It is not proof of capabilities_stale or old449.

That same owner retained two negative controls: obsolete capabilities and an
unavailable model produce the same public refusal shape through different inner
entry causes. The original hosted cause therefore remains unknown. No runtime
owner or admission guard is changed in this handoff.

The actual attributable source handoff isd4605c27, following the existing f032
terminal bounded patch/privacy/current-response-contract review377e1f44 /
1a59ec56 with no blocking finding. This is static current-schema privacy review
and inspected positive/negative evidence, not an adversarial privacy test or a
guarantee about future schemas. The existing #1355 owner rechecked its exact
clean preimage before accepting this one-file contribution under its own scope.

Patch SHA256:
578dc15b9d1727ae8ad525db4a8a6f89d3fe54a5163dd752986e91962f008b32.
Original file blob53477c90a5b3c2abdbe924b349b78967271e68e6 / SHA256
1b3788eaf2d816ffb02f1f3c3890b93996ddade6175caaa06cb289f304dddf35.
Adopted file SHA256:
c82e6225fb026a70305c377e8fa1db3805091b11531960677d4cf81148ab39d7.

Only the queued-admission assertion's failure message changes. It records fixed
stage, original command ID, HTTP status, public code and current strict-schema
runtimeFailure (code/diagnostic UUID). It omits request contents, headers/auth,
response.error, raw body/cause, provider text and private paths. Exactly one POST,
the same queued command, order,202 assertion and every remaining lifecycle/
permission/Stop/cold assertion remain. No fault/observer remnant is adopted.

Own exact composed configured-personal scenario passes1 check in10.27s, with
three other cases deliberately unselected: `device403-recipient-positive.log`.
This is deterministic external account/execution with actual public transport/
admission owners, not a live account test. The owner separately inspected an
intentional negative that still fails the same202 assertion and displays the
intended fields. No negative fault is introduced into the target file.

This is a diagnostics-only contribution from the existing fixture owner, not a
403 behavior fix, hosted clearance, old449 import or authority/timeout change.
Own pin/revision1197 retains the complete2516-key union. Normal new-head CI and
trusted final review remain required; independent #1347 is not held on this lane.
