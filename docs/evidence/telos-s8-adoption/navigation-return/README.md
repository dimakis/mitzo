# Navigation snapshot and source viewport corrections

Production checkpoint9b595892eccd0bf07257fe684ded0ccfeb838d8d, following the
independently reviewed76 route and81af coordinator baselines.7ce99f29 adds
navigation-only return intent;9b595892 qualifies actual origin views, viewport
following and CI fixture adoption.

A chooser opener retains an item+target-conversation-bound return snapshot. The
ordinary header can use its qualified local item/chat path while metadata is
pending. This does not supply work data or enable item/tree controls: recorded
association, source identity and metadata validation remain separate. External,
wrong-item, wrong-conversation and malformed local return targets are refused.

Materials and Overview source entry restore their actual owning view and entire
navigation state; the workspace caller supplies its current-view snapshot while
the legacy caller keeps its actual location. Existing query/artifact selectors
are preserved. Explicit view beats a later stored tab; routes without explicit
view keep their previous device preference. Linked-context source entry restores
the prior chat/path/query/state. SourceHref and immutable snapshot/backend
contracts remain unchanged. Source entry Back no longer always forces Chat.

Real RED evidence: held-metadata desktop Back was absent; Materials source Back
pointed to the chooser; later stored Chat overrode Materials; Overview source
Back incorrectly forced Materials. Actual mobile/desktop route tests now pass
with metadata held and no authoritative row, stale-tab snapshot, entire collection
state, exact source URL and independent draft retained.

CI on76 also exposed two provider-less artifact navigation unit fixtures and a
real45px transcript-follow gap after async header hydration. The artifact suite
now mocks the new Chat entry at the same boundary as the existing role entry;
every pinned revision/filter/tab/retry assertion remains. The source browser
fixture uses the actual slim item control instead of its removed duplicate link;
source boundary,3px bottom tolerance, reader-scroll and ordinary-send assertions
are unchanged. A13line ResizeObserver keeps following only with existing reader
intent and no retained source anchor. Manual scroll and anchored source remain
authoritative. The existing source failure/activity/follow journeys pass on all
three browser projects after a real local RED.

Final selected verification:311 tests pass in30 files, one existing skip. The
36 combined actual route/source/motion browser cases plus2 startup checks pass.
The coordinator/lead reviewed setup suite is requalified separately. Targeted
lint/whitespace and the complete source artifact registry pass. Source hashes
are qualified narrowly through runtimev1.0.337-telos-source-viewport; no other pins,
shared tokens, approved references or protected tests are rewritten.

No model/live/staging/production operation, merge or deployment occurred. Joined
S5bV2 ordinary-host/coordinator/native/peer acceptance, exact-head CI and trusted
final review remain distinct from these intercepted UI tests.

On production9b595892 the separate coordinator/lead setup rerun also passes
12 scenarios plus2 startup checks. Together the two final runs cover48 distinct
browser scenarios, with startup checks retained for each run. Broad final-head
CI/trusted review remain required; the prior76 CI failures are not called green.
