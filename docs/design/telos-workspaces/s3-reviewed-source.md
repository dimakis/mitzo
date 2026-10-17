# S3 reviewed original exchanges and lossless transfer

The controlling UX remains the unchanged approved mock, SHA-256
`97efd217cdd8246ee868a7165d2f0272b1d0b0fe76982d02dbb9f48abcfae4ab`.
This continuation extends #977's canonical record projection. It reuses #964's
accepted compiler rather than creating another context or conversation engine.
The merge order is #972 → #964 → #975 → #977 → this continuation.

## Capture and creation

Authenticated operator routes under `/api/telos/work/source` preview and adopt
an actual completed public message selection at a recorded event boundary.
`outcome/preview` reviews a proposal before an item exists; `outcome/create`
passes its unchanged approved proposal to the existing MGMT canonical creator.
The host selects its database explicitly. Accepted MGMT creation supports twelve
acceptance criteria (MGMT #313); an older configured creator may reject a larger
proposal. Never truncate it or switch stores to manufacture success.

The event adapter retains actual message/block IDs, public text and immutable
native seat/account attribution. Thinking, tool/private extensions and unfinished
replies are excluded. Hidden/imported conversations and ambiguous message IDs
are refused. Full-prefix capture uses the compiler's complete bounded witness;
selected artifacts resolve exact retained revisions and verified bytes. Inline
images and attached saved source snapshots (including a briefing's exact bytes,
date and revision) cannot silently disappear from a full/text source selection.
Capture refuses a selected message containing these attachments with advice to
retain them as materials. An unrelated textual selection remains available even
when its later boundary message carries attachments. Mutable unversioned material
links cannot stand in for a full-prefix capture witness. Material discovery uses
the existing Markdown parser family and shared pure path/link normalization.
Bare retained URLs, titled links, used reference definitions and Markdown images
resolve exact revision/hash pins through the retained artifact owner. Code,
escaped Markdown, HTML literals, link labels/titles and unused definitions do
not invent material references. The shared preprocessor preserves parsed reference definitions so completed chat links retain their exact destination.

New capture qualifies attribution across the chosen prefix before filtering selected
messages. Payload seat/provenance markers cannot establish an ordinary author;
verified native column provenance and host recipient bookkeeping keep their existing
meaning. Real operator rows retain the modern normal-chat `user-<messageId>` block
identity. Metadata-only initial prompts without a durable message boundary, and
legacy prompts or overlapping turns that normal chat displays in another order,
are refused rather than silently omitted or reordered. Later events beyond the
chosen boundary do not affect that qualification.

Native turn ownership checks the complete retained provenance snapshot, not just
seat/message/generation. A schema-valid snapshot change within a turn is refused
before selected-message filtering. Block IDs remain unique across public text,
thinking and tool blocks, so reuse cannot relabel private deltas as public text.

Normal chat displays native replies at their message start, while the shared
capture compiler uses durable completion cursors. If concurrent native replies,
or a native reply and an intervening operator message, finish in a different
order from that display, selected and full-prefix capture explicitly refuse to
retain them together.
Select one completed message or a range whose display and completion order agree;
capture does not silently reorder or omit the exchange. Single-message selections
and native replies whose orders agree preserve their exact IDs and provenance.
A final assistant boundary must contain nonblank public text. Blank or private
activity cannot supply that source anchor; earlier valid boundaries and later
visible text remain available, and existing retained packets are not rewritten.

The two existing chat replay paths differ for legacy unfinished blocks: modern
reconnect may display their text at `message_end`, while historical REST can omit
them. The accepted bounded-source contract requires closed public text blocks, so
new capture refuses such records explicitly; neither chat renderer is changed.
The native writer closes remaining blocks before its message end. Existing source
packets and unknown historical selections remain readable and are not rewritten.

Preview writes no item, assignment, session allocation or model turn. Adoption
retains a versioned source packet through `TelosArtifactStore`, then commits its
source reference and origin backlink through `TelosWorkStore`. The full brief,
actual source boundary, selected content and material hashes remain retained
when later messages, settings or item briefs change. Unknown historical author,
dates and selections stay unknown. A source-only outcome has no inferred lead.
Capacity remains unverified until a real recipient and its ordinary settings are
selected in the later collaboration slices.

A durable creation outbox in the existing Telos database holds the exact reviewed
packet and canonical idempotency key before crossing owners. Restart or a lost
canonical response reuses that key and verifies the actual created item, brief,
links and milestones before recording its ID. Artifact and work-command receipts
recover partial/completed adoption. Changed input under an existing request ID
is refused. Uncertain saves stay uncertain; saving never dispatches execution.
The original legacy create tool also uses its real registered chat ID, refusing
stale client bindings. It records a proven origin while leaving any unrecorded
reviewed selection unknown. Internal tokens confer no operator source authority.

These reviewed preview/create/adopt routes and typed client methods are an API
foundation. The production frontend does not yet call `previewSource`,
`previewOutcomeSource`, `createOutcomeFromSource` or `adoptSource`; the existing
creation flows retain their current owners. The frontend integration below reads
and opens already retained sources. API tests prove reviewed capture through real
temporary stores, but they do not establish an approved end-user capture flow.
That frontend caller and its ordinary-chat journey remain outstanding S3 work.

## Sources, Outputs and Links

A source packet has explicit `source_capture` provenance. It stays retrievable
by exact artifact ID/revision/hash through its owning source relationship.
It is neither a produced output nor a generic canonical link. Output browsing
excludes source captures before applying its page limit, so many source revisions
cannot hide older output files. Generic conversation artifact discovery/read
cannot expose source packets. Direct packet download reauthenticates the operator;
future scoped worker delivery must use its actual host authority and reviewed
recipient context, rather than the internal token alone.

Existing canonical items, statuses, hierarchy, profiles, context hints, sources,
links, dates and unmapped fields remain in their owners and are projected without
rewriting them. Existing retained artifacts keep their IDs, revisions and bytes.
The existing backup group restores source packets, origin relationships and the
creation/command recovery receipts together. No migration fabricates a primary
chat, historical timestamp, coordinator, completion or assignment.

## Ordinary chat integration

`TelosItemSources` opens the retained original exchange in the real ordinary
chat. `TelosSourceNavigationProvider` restores its exact boundary and fences late
responses when chat/item selectors change. Native seat/generation attribution
selects the right message. `TelosSourceWorkLink` reuses the existing item link in
one compact contextual row, on mobile and desktop. The original conversation's
Resources also lists every recorded item association, including shared origins.
The existing transcript, composer draft, settings and Resources stay intact.
Known legacy origins can open their real chat while explicitly preserving an
unknown reviewed exchange, including when an unknown source snapshot names the
same conversation. Unavailable origins never start replacement chats.

For an existing retained packet whose exact restored, completed assistant boundary
has no nonblank public text, source navigation reports the unavailable anchor and
releases normal bottom navigation, sending and streamed-reply following. This
includes empty or whitespace text with tool/activity blocks; activity rendering
and the retained packet remain intact. Loading or not-yet-restored boundaries keep
waiting, and a later visible public text block in the same message still anchors
normally.

S7/S8 still own the complete frozen workspace/tree, category pins, child advisor,
lead controls, many-chat entry chooser and the complete slim item/chats/work row.
This increment supplies their source navigation and preserves the normal renderer;
it does not replace those slices or claim whole-product UX qualification. S9
still owns the full device/runtime acceptance matrix and any separately authorized
live target. Staging and its pipeline remain stood down; deployment is separate.

## Offline validation

Test-first regressions cover source authorization, completed public boundaries,
full-prefix pagination, exact material revisions, native attribution, shared
origins, stale previews, immutable brief/content retention, cross-owner failures,
canonical link loss, retry/restart, backup restore and zero execution allocation.
New creation refuses duplicate canonical references before review/creation.
Attachment refusal tests cover both selected and full-prefix messages and verify
that rejection creates no item, packet, relationship, assignment or allocation.
Legacy DTO round trips and retained artifact revision checks remain in #977.

The scoped browser fixture mounts the actual `TodoDetailView` and
`ResponsiveChatView` routes, including `ChatView`/`DesktopChatView`, the real
client store and its unchanged REST transcript restoration. Source evidence comes
from actual temporary event/artifact/work stores; HTTP responses and the inert
protocol transport are synthetic and all browser traffic is intercepted. The
expanded current matrix passes 18 actual-route cases plus two startup cases
(20 total). Earlier 12-route results remain attributed to their recorded tested
heads. The route cases check 320px mobile WebKit/Chromium and 1280px desktop
Chromium in light/dark
appearance with alternate accents/font, exact source anchoring, ordinary bound
account/model/thinking settings, Resources backlinks and composer draft retention
through item/chat navigation. A later simulated streamed reply preserves the
reader's source position. Six added historical blank-packet cases verify the
unavailable-anchor fallback and restored ordinary navigation, send and stream
following without changing retained bytes. Screenshots are recorded per
platform/theme. This is
offline route integration evidence; reviewed capture still needs its frontend
caller, and full S9 device/runtime qualification remains outstanding. No backend,
provider or model starts, and no deployment is claimed. Focused tests use one
worker and a 1 GiB heap; broad frontend builds exceeded that local heap and remain
a required CI gate.
