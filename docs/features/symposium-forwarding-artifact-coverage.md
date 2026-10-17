# Exact forwarding and artifact coverage

Workstream B, 17 October 2026. Initial accepted main
`189289da78d971497deaa9cc4ca29365ba9c6e56`; subsequently integrated accepted
`fea33e215b0d1bcf29604aa13e793329588a2980` (#1006). Draft PR
[#1020](https://github.com/dimakis/mitzo/pull/1020) now includes exact-content
preparation and the assigned saved-artifact product surfaces. Source implementation,
application integration, approved full UX, physical native share, live qualification
and deployment remain separate facts. Staging remains stood down.

## Existing ownership and coverage

Durable Work parent `4f55b423d0731750` is separate from Symposium
`c0851ba23fcc5d04` and Telos orchestration. All eight existing children were read;
only scoped progress/evidence is appended, with their states preserved.

| Existing child                        | Relevant coverage and remaining boundary                                                                                                                                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cbc784ecd482c3f9` audit              | Preserve accepted Access audit and delivery receipts (latest retained revisions 6/7). Record actual source capabilities here.                                                                                             |
| `17d4e63c70a52daa` UX walkthroughs    | Saved-version dialog, version choice, reload/Files return, keyboard/mobile and recorded native export are exercised offline. Participant forwarding and physical native walkthroughs remain pending.                      |
| `fc31a120c313d9e1` Access             | Existing Access/resource classification remains owned; links, Git references and source-dependent references are not retained bytes or access grants.                                                                     |
| `36cba91c81bfe559` inline references  | `SessionOutputReferenceStore` binds finalized message/block/end-sequence/hash; v1 remains transcript-dependent. B adds exact authorized selection/handoff.                                                                |
| `fceaee601360f594` associations       | Existing explicit revisioned Work associations are reused. Forwarding/retention never creates an outcome, infers membership or grants work authority.                                                                     |
| `1a385d2c7a65ba52` retention          | `TelosArtifactStore` already retains immutable BLOB revisions, exact reads/downloads, request retries and compare-and-append edits. B reuses those reads; standalone artifacts still require an owner-approved migration. |
| `4d450c8e0d64ce10` context            | Existing visible-source capability/compiler owns private-history exclusion and bounded exact source reads. B hands selected material to core; no context engine or provider adapter.                                      |
| `0be7b914fc804aec` review/publication | Exact source/version identity is useful input only; no review, publication or release acceptance is implied.                                                                                                              |

The latest canonical plan `dad6534e91551b3e375a57307df729a1` r12,
joining acceptance `4c8cef1b18a2e14db03b301fdef01c4c` r2 and mock approval
`d2b5bce4090c39a595457335763271b5` r1 were read along with all available
child attachments. The live records and historical source reports do not establish
that their broader criteria have been implemented or qualified.

Core owns shared protocol/storage migrations, durable request/target receipts,
app/router mounting, capacity, joining/allocation, ordinary queue/dispatch,
reply attribution and reader delivery. Workstream A owns projection/composer
and its optional ChatArea rendering slots; it has no message-action/version/share
edits planned. B owns new forwarding/artifact modules and their focused tests.
Telos S5 uses the shared artifact/context owners; B changes none of its delegation files. Core explicitly assigned two narrow
read-only additions to the shared Telos artifact store after S5 confirmed it has no
artifact-store edits; storage schema/migration ownership remains core.

## Private exact-content contract

`prepareCollaborationForward` accepts a request UUID, an explicit collaboration/
membership revision/stable recipient list, source conversation and boundary,
selected message sequences and exact block/hash pins, and explicitly selected
artifact pins. It reads through `AuthorizedCollaborationContext` and never accepts
caller-supplied message content or provider-history selectors. Only complete
selected public blocks enter the packet; no implicit adjacent blocks/messages.

The context-only packet preserves request, target, boundary, source identity and
original author/source attribution. Serialized content and its hash are immutable
strings; returned packet objects are independent projections. Input schema
normalization produces a canonical request fingerprint. Core must bind that to
the operator and persist/recover the original packet in its existing request
ledger; the fingerprint is not an idempotency receipt.

Source/target authority and source integrity are renewed before returning, and
`assertCurrent` repeats the checks for the delivery owner. These are point-in-time
checks, not an atomic revocation protocol, capacity proof or dispatch permit.
The existing delivery owner must enforce its actual admission ordering. Selection,
preview and renewal have no queue, session-allocation, model or billing port.
Exact command/reply and source-to-delivery byte comparison remain joint integration
work with core and acceptance C; they are pending until the real path is exercised.

Source-dependent inline refs are labelled `transcript_reference` /
`source_dependent`, even though the handoff contains selected bytes. An in-memory
handoff does not establish independent durable retention. Linked external documents
and Git change references are not accepted as retained content. Missing references,
private blocks, stale hashes, unavailable sources and empty/inferred targets refuse.
Retained artifacts use a distinct `retained_artifact` selector and a mandatory
`RetainedCollaborationArtifactSource`. It reads the exact item-backed saved revision
and records independent retention plus original source kind/session/path provenance.
The original session may be absent. Live artifact/item authorization is renewed on
every read; source-capture packets and LifeOps content refuse. Missing retention never
falls back to a transcript reference or latest revision.

The existing artifact owner now exposes `metadataForRevision` and
`readBoundedRevision`. Exact metadata and current privacy policy are checked before
BLOB hydration. SQL checks both stored size and actual BLOB length/type and conditionally
projects bytes only within the requested positive safe bound. The adapter verifies
actual byte length/hash after that bounded read. Existing save/read/document semantics
and all artifact IDs/URLs/revision associations are preserved; no schema changed.

The complete input and serialized packet are bounded to 512 KiB with no truncation.
The owner read and complete serialized packet each accept exactly that boundary and
refuse the next byte. Serialization overhead can therefore make a valid bounded
artifact too large for forwarding; the handoff refuses rather than truncates.

## Evidence and open gates

Focused offline tests use synthetic data in databases initialized by the real
EventStore. Source loss is fault-injected in those owner-created tables. A separate
synthetic canonical-owner backup supports the retained reader fixture: actual MGMT
`TodoStore`/`create_outcome` created it, its export hashes identify the exact
schema/data, and the real Telos artifact initializer applies supported migrations.
No minimal hand-built replacement schema is used for that fixture.

Red/green logs and exact commands are retained under `implementation-evidence` in
the task checkout. Core assigned the metadata history endpoint and artifact UI,
plus response-custody hardening in the existing artifact router. The existing app
already mounts this router; B changed no shared app/protocol/migration or provider
owner. See [the product handoff](symposium-artifact-product-handoff.md) for final
source evidence and the precise outstanding delivery dependency.

Focused commands (one worker, 1 GiB Node heap):

```sh
NODE_OPTIONS=--max-old-space-size=1024 ./node_modules/.bin/vitest run server/__tests__/collaboration-forwarding.test.ts server/__tests__/collaboration-retained-artifact-source.test.ts server/__tests__/telos-artifact-store.test.ts server/__tests__/collaboration-context-source.test.ts server/__tests__/collaboration-context-compiler.test.ts --maxWorkers=1
NODE_OPTIONS=--max-old-space-size=1024 ./node_modules/.bin/tsc --noEmit --target ES2022 --module ES2022 --moduleResolution bundler --esModuleInterop --strict --skipLibCheck server/collaboration-forwarding.ts server/collaboration-retained-artifact-source.ts server/__tests__/collaboration-forwarding.test.ts server/__tests__/collaboration-retained-artifact-source.test.ts server/__tests__/fixtures/collaboration-retained-artifacts.ts
```

Initial sets passed 15/15 forwarding, then 17/17 after final-fence and exact-byte
cases, then 18/18 including saved-version handoff. Retained-reader/owner checks
passed 12/12, then 13/13 with physical source-database removal. The five-file
regression set is reported as one overlapping set, never a sum of those runs.
Broad application builds/tests and trusted full-PR review remain CI/integration
gates. No models, account services, credentials, staging or production were used.

## Product implementation follow-up

`revisionPage` is metadata-only, exact-ID keyset pagination (maximum 50 rows).
The operator-authenticated versions endpoint excludes private source packets and
current ineligible items. Preview/download hydrate the exact bounded revision,
verify metadata and bytes, and renew current item eligibility immediately before
responding. Existing scoped interactive source-packet reads remain separate.

The output title is one route link opening `SavedArtifactDialog`, with exact
artifact/revision/hash in the existing Work URL. It survives reload and later
saved edits. The dialog uses the existing document preview policy, safe Markdown,
sandboxed HTML and literal code/text; unsupported formats state that no preview is
available. File options → Open reaches the existing full Files editor at the exact
selected revision, with a pinned return route. Existing explicit document references
still use their Files bridge. Work provenance and unknown-author fields are retained.
There is no inferred outcome, Work association or standalone-retention migration.

For retained-artifact-only selections, `sourceConversationId` and `boundary` may both
be null when messages are empty and every selected artifact is independently retained.
No source capability is opened; original saved provenance is preserved. Transcript
messages and references still require a real source and boundary. Target/artifact
authority and final local custody fences apply equally to both forms.

Core's durable forwarding prepare/confirm/read API and original-actor receipt contract
remain unavailable. B therefore exposes no enabled recipient send action or invented
sharing status. Prepared bytes, persisted forwarding receipts, dispatched context and
visible recipient acknowledgment are distinct stages. Ordinary recipient admission,
unsupported media refusal, queueing and uncertainty remain with core. Native export
is distinct from agent delivery. Full approved Symposium UX is not yet accepted.
