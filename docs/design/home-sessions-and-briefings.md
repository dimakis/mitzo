# Today, saved briefings and minions

Today prioritizes starting a session and finding an existing one. Its compact
New session action, labelled session-and-message search, ordered pins and recent
sessions use the existing shell, page heading, palette and typography. The shared
shell owns the wordmark position. Appearance Settings continue to choose the
font and accent; this page has no independent theme.

Pins are bookmarks to registered sessions or TELOS records. They do not change a
TELOS star, status or urgency. Pin from a detail view, or add from Today; manage
order and remove bookmarks without deleting the underlying records. Headers use
the same first meaningful title as the corresponding TELOS cards, rather than
placing a complete body of Markdown in a link.

## Workspace state

`HomeStore` owns `.mitzo/home.json` under the configured workspace root. Updates
to names, ordered pins and the daily quote setting require the revision returned by GET
`/api/home/preferences`. Conflicting device edits return 409 instead of
overwriting changes. Successful writes broadcast `home_preferences` through the
existing authenticated SSE stream. The frontend also refreshes on visibility.
JSON writes use a private temporary file and atomic replacement; malformed saved
state fails explicitly rather than resetting user preferences.

The briefing and terminal names are separate, both initially Minion. Terminal
nickname storage is available for the terminal surface to consume; it does not
create a terminal assistant or runtime. Human-readable names are presentation,
not agent configuration or provider routing.

## Saved morning briefing

`GET /api/home/briefing?date=YYYY-MM-DD` reads the latest existing report for that
day, preserving its entire contents. The response identifies the file, generation
time and SHA-256 revision. Reading a briefing does not run the generator or a
model. Missing reports have an explicit empty state. The reader folds calendar
updates and lower-priority supporting material while keeping it accessible.

The producer currently lives in MGMT. Changes to attendee enrichment or its Jira
selection policy belong in that producer's separately reviewed pipeline. Keeping
participant Jira collapsed in the reader improves presentation without silently
throwing away source material. A future producer change should distinguish the
user's own actions and meeting agenda from broad participant activity, and retain
the latter as optional supporting context.

## Discussing a briefing

Asking the named minion opens a reviewable account/model selection. The normal
account catalogue remains authoritative for availability and routing. The
selected account and model are visible; unavailable credentials or models never
silently fall back to a different account. Opening the reader or picker sends no
model request. A confirmed chat uses the existing rich conversation UI and
transports, with the exact saved report as launch context.

V2 sends the report as a structured `sourceSnapshots` reference, separately from
configured `contextBlocks` names. Prompt assembly validates its calendar date,
2 MiB UTF-8 bound and SHA-256 revision before provider dispatch, and includes the
entire report. History stores the original short user prompt alongside the
snapshot, so restoration and account/model changes retain the same source without
duplicating it in a chat bubble. Legacy V1 sends and native commands explicitly
reject this source transport instead of silently discarding it.

`GET /api/home/briefing-chats?date=...&revision=...` returns durable conversation
references for that exact report version. POST registers a reference only after
the ordinary session exists and its actual account/model match the selection.
Other report revisions and older conversations remain separate. These references
contain routing identifiers, not credentials. The EventStore remains the owner
of conversation content and provider continuations.

Deleting a conversation hides it from both briefing lookups and registration.
Its retained history is preserved, and asking with that selection can start a
fresh conversation. Nickname drafts also retain their original preferences
revision: a concurrent edit requires explicit review of the current names before
the draft can be saved again.

## Tiny daily quote

**Settings → Today → Show daily quote on Today** is enabled by default and saved
for the workspace across devices. Existing home files without `showDailyQuote`
retain the enabled behavior. Today waits for preferences before mounting its quote
link. When disabled, it makes no daily quote request and leaves cached snapshots
and the shuffled deck untouched. Direct `/quotes/YYYY-MM-DD` links remain
available and can still request a quote.

The checkbox shows the saved server value while a change is in flight and after
a failed write. A conflict reloads the latest value; **Review current setting**
refreshes it before another choice. Retry never replays a stale change or writes
nickname or pin fields.

The quote mark beside Today opens the quotation, its edition and translator,
editorial explanation, an example, author background and direct source links.
The release catalogue is built from verified drafts; details of admission and
daily selection are in [the authoring pipeline](../../content/quotes/README.md).
CI rejects stale generated output. No model runs in daily delivery. The shuffled
deck and complete daily snapshots are persisted in HomeStore and shared across
devices. Extending the catalogue requires source review through the same pipeline.

## Activation

Branch implementation and offline fixtures do not activate canonical staging or
production. Follow the accepted-main exact-commit staging procedure for an
approved release. Provider enrollment and real-model smoke tests remain separate;
all such tests must explicitly use a supported Luna model and identify the
charged account before the call. Production activation requires an explicit user
action.
