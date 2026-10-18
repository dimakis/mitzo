# Accepted metadata source integration for PR1032

PR1030 merged as `634048b1c7309a411dcfbf39dd2ae4e0308bdcfb` at
2026-10-18T15:55:38Z, tree `fab6f87ff63ce6f0b828cc057338f448d62db994`, sole parent
f39cbfdf. GitHub merge state was independently read; accepted/reviewed tree identity
is recorded separately. The coordinator ratified S5a's owned CT01–CT06 scope; its
decision is retained verbatim and attributed to that owner, not to S9 testing.
Full S9/parent acceptance, S5b implementation, full UX and CT19 remain open.

The initial PR1032 head 7daab55f passed full CI39141479169, including its four S9
contracts in default discovery. Main then advanced to accepted634. Strict protection
requires integration and new head validation; that old CI is not reused as current.
No production or producer unit-test edits were made during integration.

The unchanged S9 fixture on634 produced one pass/three failures because the updated
hook calls the newly accepted APIs and the fixture had not mounted them. S9 now
wires `roleReview` and `roleSetupReviewed` to the actual accepted host, matching the
application's router composition. Response loss covers both legacy and reviewed
setup paths. The three recovery cases now exercise the reviewed wrapper: immutable
presentation/ref persist across reload, retry sends the complete original wrapper,
and no legacy setup fallback is used. The late conflict retains the original
wrapper and cannot start fresh review. The created-child journey also checks the
worker's retained presentation, original pre-attempt context revision and task hash
through replay, result retention and explicit task approval.

A new assertion initially used `name`; the accepted item DTO uses `title`. Only
that S9 assertion was corrected. A subsequent local run again had intermittent
unexpected HTTP failures, including a context request, with the generic client
message `Telos work unavailable`. Their cause remains unproven. The failed reports
are retained; they are not declared expected rejections, fixed defects or producer
defects. The fixture now logs status, content type and synthetic response text when
an HTTP error lacks the application's JSON error field. A bounded ten sequential
four-case diagnostic runs did not reproduce it. No retries or quarantine were
added to the test configuration; assertions remain mandatory.

The qualified run and current source fingerprints are stored separately from the
f39 history. This adds selected exact-wrapper/recovery and worker-presentation
evidence. It does not complete the ten planned adversarial/authorization/storage,
full-shell/settings/Resources and geometry groups from signed154d73d5. Those groups
now have an accepted API source and remain pending S9 implementation/qualification.
No browser, live provider/model, staging, deployment or production fallback ran.
