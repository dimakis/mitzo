# Conversation search

Authorized on 7 November 2026 in the originating chat: after reviewing the phone
screenshot showing no results for `Claude personal` and the proposed first release,
Dimitri said, “Yep. Let’s build it and open a pr.”

Search requires every word, in any order, across a conversation's title, visible
message text, selected model/provider, current account alias and project directory
name. Quotes require an exact phrase within one field or text block. Model/account
terms remain searchable text rather than silently imposed filters. Punctuation
and SQL wildcard characters are literal.

The private disposable worker index assembles assistant chunks by conversation,
message and block across bounded pages and later requests. Different messages/
blocks never fabricate a phrase. Explicit reasoning/tool blocks, contributor-seat
events, hidden chats and internal SDK identities are excluded. Historical standalone
deltas without block identity retain their previous substring coverage.

Title matches rank above model/account/provider, project and incidental message
mentions. Exact titles receive an additional boost; recency breaks ties. Repeated
mentions do not multiply a conversation's score. Queries allow 512 characters and
32 distinct words/phrases. Results remain bounded to 20 by default (API maximum 50);
a full page is labelled best matches rather than an exact total.

During library search, Pinned and Drafts give way to results. Clearing restores
their existing components/actions. Search/help stick within the results scroller.
Shared `SearchMatchText` renders inert React text and semantic highlights in the
library and desktop sidebar. Results explain matching fields and retain model/
account identity. Empty search offers an explicit broader query; failure retains
Retry. The library saves its query in the URL, synchronizes same-route navigation,
and restores query/scroll through both history back and the phone's Back to chats
link. Telos-specific return destinations retain priority.
Approved activity, settings and composer designs retain their existing owners.

## Validation and limits

Test-first backend regressions cover metadata/alias refresh, reversed words, quoted
phrases, incremental streamed text, relevance, literals, deduplication and excluded
content. Existing async tests retain cancellation, protected cache disposal,
visibility revalidation and event-loop responsiveness. Mounted UI tests cover
highlights, focused results, broader queries, errors and query/scroll restoration.
Shared design checks and focused lint pass. Protocol/client builds pass; the full
frontend type check exhausted the required 1 GiB local heap and remains a CI gate.

The new offline search fixture covers phone WebKit/Chromium and desktop Chromium,
dark Mint/System and light Teal/Georgia, 320px phone widths, sticky search, wrapping,
keyboard navigation, loading/empty/error/recovery, in-app return and history back. All traffic is
intercepted; no backend, credentials or models are used. Local execution was refused
before launch by the existing Seatbelt host guard, even through approved escalation.
No environment marker was removed and no browser launch was retried. Rendered
checks and visual inspection remain pending CI; captures use the existing
`conversation-library-visuals` artifact pattern.

Landing review on 7 November found and corrected exact-case non-ASCII search
regression and same-route URL synchronization. Focused independent local follow-ups
verified those deltas, the bounded in-app return helper and the 128-event assembly
boundary. Initial hosted browser checks exposed a fixture boot-order error: the
fixture now initializes durable chat storage before saving its unsent draft, using
the production boot barrier. Final hosted rendered acceptance remains required.

Project search and the activity overview share one directory-name projection,
including the owning repository of conventional .claude/.cursor worktrees on
POSIX and Windows paths. Opaque managed repository-task directories still use
their directory name; recovering their repository label requires a separately
validated workspace metadata projection.

Semantic retrieval, typo tolerance, structured filters, pagination and navigation
to an individual matched message remain future work. Results may carry a stable
message ID, but this release opens the existing conversation route.

## Landing integration, 12 November 2026

The landing session integrates current main while preserving its grouped Drafts
disclosure, masthead search-focus shortcut, current model selection projection,
ordinary turn exports and registered authorization source inventory. Search still
hides Pins/Drafts until cleared. The mounted library fixture now supplies the
draft fields used by the retained disclosure; an integration regression verifies
the shortcut focus and opening All drafts. Shared design and focused search,
navigation and library checks run with one worker and a 1 GiB heap.

The previous candidate's hosted browser/layout suites passed. Its native
repository workflow failed while preparing a repository, before its success
assertion. That historical failure does not establish a search defect or a cause;
the combined candidate requires fresh CI and exact-head Centaur verification.
No staging, production configuration or live model tests are used.

Search RPCs now retain worker exceptions as internal error causes while emitting
only a stable code, stage, request number and exception class. Server and hook
diagnostics omit query text, transcript data and exception messages. Worker exit
and cache-cleanup failures remain observable without replacing the primary
failure. Real-worker append/query regressions, the API error response and the
real hook's retry state verify failure delivery and sanitized diagnostics.

## Combined CI follow-up, 13 November 2026

Candidate `0543e313` passed compilation, source preflight, core checks and all four
unit shards. Its six search browser journeys stopped on an obsolete expectation
that Drafts was a direct link. The fixture now opens the retained grouped
disclosure, verifies its saved draft and All drafts navigation, and verifies the
disclosure returns after clearing search. The approved interface is unchanged.

The native repository artifact identifies the subscription failure at the
`PublishPreparedRepository` helper's existing 30-second deadline. The API account
journey completed its publication helper in 21.5 seconds. These observations do
not establish a search-related cause. All coverage, ownership checks and operation
deadlines remain intact for the fresh combined run. Local browser discovery works,
but the isolated executor has no matching binaries and both full/headless browser
downloads failed with a closed CDN connection; rendered verification remains in CI.

The six search journeys passed after the disclosure correction. Inspection of
their captures then exposed missing root appearance attributes: the fixture's
light/alternate preference labels were not reflected in its rendered theme. The
fixture now uses the existing library fixture's explicit HTML theme/accent/font
attributes and asserts them before interaction. The approved host executor also
refused browser process registration when given matching cached binaries, so the
corrected appearance captures require a fresh hosted run.

Candidate `5f17058d` passed the native repository workflow with its original
30-second helper limit, all unit shards, all browser/layout shards and Swift
builds. Corrected phone/desktop captures were inspected in both appearance
variants. One Telos composition case reached its default five-second composer
readiness wait before its composer appeared in the failure capture. That cold
page-readiness assertion now allows 15 seconds only in CI and retains five
seconds locally; every operation, approval and authorization deadline is unchanged.
The final candidate also integrates the accepted Symposium picker fix `9147f18f`.

Candidate `65aeab5d` subsequently passed the complete combined-result CI run
`43397932958` and Centaur final review `PRR_kwDOR2Rn9s8AAAABXwMurQ` with LGTM,
recommendation `merge` and zero blocking findings. Landing was held for Dimitri's
explicit merge order: CC, EnMaaS, then conversation search.

The final integration includes accepted CC `f08f0173` and EnMaaS `cfa324ca`,
preserving their account enrollment, model visibility, learning and permission
behavior. Their source registrations are retained alongside search's inventory
and regenerated against the combined tree. The accepted Telos source-review
readiness helper and search's finite cold composer-readiness allowance both remain
in the composition fixture. This integration requires fresh combined-result CI
and targeted Centaur verification while retaining the approved search baseline.
