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
