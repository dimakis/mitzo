# Native Codex subagent implementation evidence

Recorded 5 November 2026. The final v005 mock is retained byte for byte from
the originating conversation's mockups/mitzo-subagents directory. That
conversation (911e7aaf-f8a0-8aaf-862e-c322cfd6c163) contains the user's approval:
“yep, this is excellent, I like this. lets just ensure that we don't get rid of
the other icons in the screen chat, for terminal etc. the mock has left these out”.
Subsequent refinements preserved toolbar actions, phone layout, context wheel
and Resources. The current user explicitly requested implementation.

The implementation uses existing shared dialog, text, tool and icon components.
Component tests cover parent and sibling draft preservation, targeted controls,
uncertain request identity and retained unavailable output. The offline browser
fixture mounts the real composer and child UI at phone and desktop widths,
in light and dark themes, including touch geometry, focus and Terminal checks.
The ledger protects these test sources and the original reference.

Local evidence before final preparation: 452 existing conversation tests passed;
37 focused tests across six files passed. Store tests and package builds also
passed. An earlier full server type check exceeded the configured 1GiB heap;
a focused server type check passed. A focused frontend type check lacked the
Vite environment declaration in its temporary include list. These do not replace
the repository's full CI checks.

The browser invocation was interrupted before a result. No browser pass,
screenshot comparison or live model execution is claimed. At the user's
direction, final combined-source validation and rendered browser checks run in
CI. Review their retained screenshots against the approved reference.

This evidence does not establish production activation, upstream live child
inheritance, deployment or final user acceptance. No production runtime was
changed. The Telos creation tool did not create an outcome; code and this
document preserve the implementation handoff.

## Landing corrections

The first complete CI run built and type-checked the feature and passed nine
layout shards and three unit shards. Three layout jobs failed because this
fixture did not mark public image URLs external to its esbuild bundle. The core
resume probe failed during temporary-directory cleanup while an upstream CLI
marketplace clone was still writing; the probe now owns and terminates its
whole process group. An unrelated native session-history case exceeded its
20-second test envelope; its assertions and allowance remain unchanged.

Centaur's first review identified history-wrapper hydration, optimistic-state
rollback, descendant command attribution, retained tool output, admission-buffer
lifecycle loss, parent cancellation ordering, dispatch-time authority and actual
ChatArea unmounting. These received focused regressions and source corrections.
The browser fixture now uses the real ChatArea and verifies that finishing the
parent preserves the open child dialog and draft. The real-renderer component
regression also preserves the uncertain request identity. The late attributed
task-prompt follow-up is fixed in the same batch.

Final CI and Centaur verification must cover these corrections before merge.

The follow-up review verified seven prior blockers and identified cancellation
during control preparation and output-only changes preventing rejection rollback.
The dispatch fence now checks parent cancellation; rollback uses a separate
native lifecycle revision and the optimistic state/turn identity. New regressions
cover both races while retaining terminal-event protection. Successful CI runs
retain the native-subagents screenshots in the responsiveness visual artifacts.

The real-renderer fixture also exposed a WebKit ResizeObserver delivery loop in
the shared disclosure animation's synchronous resting-layout measurement. Resize
delivery now coalesces that measurement into the next animation frame and
cancels pending work when the animation releases. A focused regression verifies
deferred measurement, coalescing, retained animation timing and cleanup; the
existing browser error assertion remains intact for CI verification.

The combined-head CI run 42126223156 passed, including all layouts and native
authorization/build checks. Current phone and desktop captures in both themes
were inspected. Centaur's current-head comment confirmed the cancellation fixes
and found CEN-6C06A6E886DA in the accepted main integration: an inbox scan await
could outlive the middleware's path authorization. Both inbox mutation routes
now refresh private-path and runtime-authority source/destination guards at the
synchronous mutation boundary. Eight enrollment-during-scan regressions pass
alongside the existing inbox route cases; final-head CI/review remains required.

The focused inbox selection passed 17 cases. A broader local route run passed
133/181 cases and failed 48 after suite environment restoration exposed the
host's denied `.mitzo` enrollment path (EPERM); this includes path-guard 403s
and pending-scan cases that cannot enter the guarded handler. No guard or test
assertion was relaxed. CI owns full-suite validation in its isolated environment.

## Independent permission review corrections

On 5 November, final-head CI 42129508719 passed and Centaur review 5793739148
approved the inbox correction. The independent full pass 5793784653 found four
additional blockers: CEN-051BA38BEB48 (approval cleanup overwrites Stop),
CEN-2AA43C013DA1 (late admission escapes parent cancellation), CEN-6F6A7C131BB2
(child claims are unavailable to real signed read helpers), and CEN-22FF6B7964DD
(completed children exhaust the live admission bound).

The correction batch gives approval cleanup and optimistic controls explicit
lifecycle ownership; coordinates late admissions with cancellation epochs even
across resume; and evicts inactive live owners while preserving saved output and
lazy, identity-checked Message admission. Trusted host contexts now recognize
only exact invocation objects registered by the original child owner, backed by
an unfinished durable child claim and the original acknowledged command attempt
and thread generation. The same base read policy is exposed through a frozen,
nonenumerable capability whose fence expires with that callback. Existing
operator, workspace, account, custody, profile, role and revocation checks remain.

Recorded 6 November: 44 child owner/store/route tests and two parent integration
tests pass locally. All 17 required signed repository-read cases pass, including
actual DiscoverLocalRepository and InspectLocalRepository child calls after
parent completion; one existing opt-in diagnostic remains skipped. The fixture
uses synthetic home/enrollment paths so native tests do not touch denied host
configuration. CI's exact native coverage count increases from 15 to 17; prior
cases remain mandatory. The local type check exceeded the 1GiB heap, so full
type validation remains a CI responsibility. No live model was called. This
batch still requires fresh CI and verification against the independent review.
