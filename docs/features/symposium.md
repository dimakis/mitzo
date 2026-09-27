# Symposium implementation and acceptance

Telos parent: `6403fb22f9bb743c`. Phase 2.5: `c10fc341b0533a54`.

## Status at 27 September 2026

This page describes the implemented feature stack and its acceptance evidence.
It does not assert deployment or production readiness. The source now composes
personal-account/model-refresh UI ([PR #627](https://github.com/dimakis/mitzo/pull/627)),
reviewer setup ([PR #611](https://github.com/dimakis/mitzo/pull/611)), mounted review
routes ([PR #613](https://github.com/dimakis/mitzo/pull/613)), immutable records
([PR #615](https://github.com/dimakis/mitzo/pull/615)), publication preflight
([PR #620](https://github.com/dimakis/mitzo/pull/620)), and session artifact
preparation ([PR #624](https://github.com/dimakis/mitzo/pull/624)). The canonical
product contract is the
[workspace redesign Symposium reconciliation](../design/workspace-redesign/mitzo-redesign-launch-plan.md#symposium-reconciliation).

The director, durable membership and delivery records, portable profiles,
personal connection slots, explicit model refresh, shared reviewer setup,
review workflows, immutable records, artifact preparation, and publication
preflight have mocked tests. These guarded slices do not install a trusted
native review host or publish a pull request. The panel reports the unavailable
host capability; ordinary chat cannot bypass the gate.

Phone device sign-in has been exercised against an isolated host. A separate
attended native smoke completed two real `gpt-5.6-luna` turns through the personal
ChatGPT route. The [sanitized evidence](../operations/evidence/symposium-luna-native-smoke.json)
records exact replies, 16 streamed deltas, two replayed turns, and confirmed
absence of the probe containers and local transport afterward. Its source commit
is `9b67c2a6c0e4decf5bc81d4b43ea2230996ec072`; its charged account was the
personal ChatGPT connection on the isolated test instance. It explicitly records
`productionAdmission: false` and `fullAppAcceptance: false`.

That smoke proves the tested native route, not the complete application workflow,
review budgets, or artifact-bound terminal receipts. Full application admission
still requires the exact reviewed build, current owned-host custody, provider
bindings, policy/seed evidence, and physical artifact proof. Configuration alone
cannot satisfy these gates.

## One conversation, explicit reviewer setup

The Add-reviewer implementation in PR #611 keeps one conversation stream and has responsive
`ChatView` and `DesktopChatView` wrappers; they share the reviewer entry and
conversation behavior. This is not a claim that they have been replaced by a
single component.

In PR #611, **Add reviewer / Ask another agent** uses a focused sheet with a saved profile
revision, connection, model, and explicit context choice. Profile creation/import
is behind profile management. Independent context is the default: the operator
supplies the task package and selected references. It does not automatically read
the repository, fetch referenced artifacts, or include prior conversation.
Summary, selected turns, and full shared transcript are separate explicit choices.
Private directed inputs are excluded from shared-history selection.

A changed account requires acknowledging the data sent through that provider.
Partial seat creation retains the existing seat for retry instead of silently
creating a duplicate or changing its selected bindings. Removing a reviewer
simplifies the composer while preserving the durable Symposium membership and
isolated runtime history; it does not convert a version-2 session back to ordinary
chat.

**New Symposium** creates a draft with explicit account/model and profile choices.
Draft creation does not authorize execution. Activation and addition to an active
roster require current grants and provider admission for every active seat.

## Personal accounts and model availability

Connections supports multiple named personal ChatGPT slots with explicit Connect,
Reconnect, Disconnect, and cleanup recovery. Every login targets an exact slot and
displayed revision. Reconnect fences the old binding and does not silently rebind
existing seats. Credential cleanup remains blocked while physical cleanup is
uncertain, including uncertain sandbox creation in the owned workspace.

[Device sign-in](../operations/symposium-device-auth.md) uses the supported
OpenAI browser link and one-time code; the phone browser does not need a localhost
callback. The ChatGPT security setting enabling device-code authentication is a
prerequisite. Local-browser/SSH callback setup remains an explicit alternative.
Receipts are scoped to the initiating authenticated session; another session
cannot recover or cancel its pending code.

Saved slot metadata survives restart. Personal authorization does not: a
previously connected slot requires fresh sign-in. An interrupted credential
operation remains in recovery until cleanup is proven. Metadata and unchecked
credential files never reconstruct trust, and no work-account fallback is used.

**Refresh supported models** performs account/model discovery without inference
through the selected slot's exact owned provider. It publishes a new catalog
revision only after verified sandbox and physical cleanup. Unavailable or
undiscovered models cannot be selected by silently accepting a placeholder.
A catalog refresh does not choose a model or update an active seat: the operator
must explicitly confirm the current account/model selection again.

## Runtime and physical authority

The current production path gives each seat generation its own durable sandbox
identity and exact provider attachment. It uses upstream OpenShell contracts
without a private gateway patch. The historical version-1 shared sandbox is not
the security model for this path.

The legacy attestation contract permits OpenAI API writer seats. The distinct
owned-native contract can describe OpenAI API and personal Codex seats, including
reviewers, but only after its exact binary/image, custody, provider, and authority
checks pass. Claude admission remains unavailable through these contracts.

Shared artifacts use a separately admitted named volume: writer access is
read-write and reviewer access is read-only. Host leases check the physical mount
and retain writer reservations until exact stop/deletion evidence permits release.
The session artifact service can prepare a bounded owned volume and durable
mapping. A saved draft exposes Prepare/retry after reopening, without activating
the roster or dispatching work. The service cannot
mint runtime admission or replace a failed host attestation.

TLS setup requires the Podman guest hostname as well as loopback in the gateway
certificate. The newer runtime image also carries the guest CA/launcher fixes
used by the attended smoke. These fixes do not automatically update production
build pins. The measured image update replaced the older literal gate pins through
[PR #629](https://github.com/dimakis/mitzo/pull/629) with physical and live evidence.
Admission requires whichever reviewed pins are present in the selected source to
match the actual image. A caller-supplied hash cannot override the schema.

Personal provider receipts are necessary but do not replace the static
attestation's exact provider-instance allowlist. A fresh dynamic provider must
satisfy both checks. This implementation does not silently amend reviewed
authority after login.

## Durable delivery, attribution, and recovery

Version-2 configuration supports one stable anchor and a bounded active roster
of up to eight seats. Membership generations are append-only. Suspension or
removal fences queued and running work before cleanup; replacement creates a new
identity. Historical seat metadata remains available to interpret the ledger.

Every recipient retains immutable configuration, account/profile, context/tool
grant, and membership provenance. Provider acceptance receipts pin the exact
attempt, native thread, and turn. Queued inputs are distinct from received inputs;
dispatched inputs without acceptance evidence remain uncertain. Interception
preserves original and delivered content.

Concurrent seat streams render into the shared transcript with durable ordering.
Replay does not relabel old events from current account/model selections. Restart,
ambiguous completion, or failed cleanup cannot invent success or release a writer.
Late results remain attributed to their original claim without reviving cancelled
work.

Provider usage preserves missing prices and unproven terminal totals as unknown.
A known subtotal is not a proven complete bill. Native hard monetary/token
enforcement requires trusted reservations and completion evidence beyond display
accounting.

## Profiles and reusable reviewer recipes

Mitzo owns immutable, owner-scoped profile revisions with guidance, expected
output, acceptance criteria, and optional version-1 recipes. Five editable
starters cover code correctness, security, architecture, testability, and artifact
review. Saving/importing a profile does not create a seat or change its binding.

Recipes suggest context categories, source kinds, skill references, read-only tool
preferences, and compatible providers. They contain no credentials, transient
paths, transcript, or session authority. Skill references do not install tools;
context references do not grant access. ContexGin is an explicitly selected
context source, with no implicit write-back.

Conversational profile proposals require explicit review and Save. Applying a
saved revision to a seat is a separate action with its own suspension/rebind and
grant checks.

## Review records and publication boundary

This section describes PRs #613, #615, and #620. The base checkout has standalone
review persistence/coordinator services; it does not mount these routes or provide
immutable export, snapshot retrieval, or publication preflight.

The review workflow records structured findings, fix/dismissal decisions, exact
artifact revisions, and delta-review history. The interactive panel reports an
unavailable native review host honestly. Mocked coordinator tests do not prove
live budget enforcement or a complete autonomous review/fix loop.

The immutable-record slice binds an owner/session/workflow to the verified
artifact and exact history sequence, result, and evidence. Authenticated retrieval
does not rewrite a snapshot. Repeating the same export returns the same record;
changed history or artifact identity produces a distinct snapshot. Records are
stored outside the reviewed Git branch.

Publication preflight validates a trusted host binding and current review/artifact
evidence. It is a guarded preparation step, not **Create PR**. Native review-host
completion, durable terminal evidence and approved publication dispatch remain
separate gates. No publication or production deployment is established by the
native smoke.

## Historical compatibility

Earlier Phase 1/2 text described a two-seat, shared-sandbox foundation with injected
executors. Version-1 records remain readable; that historical scope does not limit
the current roster or authorize shared credentials. Version-2 membership history
cannot be erased by deactivating the session into ordinary chat. The original
foundation PR #446 is not a required dependency of this implementation.

The current mocked suites cover persistence, privacy, admission, restart fencing,
cleanup ordering, UI selection, and review-record integrity. Their results must
remain distinct from the bounded live evidence above and from full application
acceptance.
