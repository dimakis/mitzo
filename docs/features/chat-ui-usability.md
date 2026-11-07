# Chat controls and stable history

Requested by Dimitri on 7 November 2026, with phone screenshots showing a
single-host menu, delayed activity and moving chat rows, an Access screen full
of unknown measurements, missing context capacity and noisy references.
Implementation base: `3079701d8f714945f8478508382e17ff20c61299`.

The Run on editor uses a select only for multiple eligible hosts. A single host
is readable text. Loading, unavailable and saved missing hosts remain explicit;
the picker never replaces an unavailable saved host with another host.

Chats receives the current activity snapshot in its first history response.
Live labels continue to update, while row order changes only through the existing
Show latest action. Initial SSE hydration cannot display a partial list ahead
of the first history page. Newly discovered rows append without displacing
existing rows. Search, pins, menus, deletion and the sidebar keep their existing
owners; disconnected snapshots never establish current authority.
The collection caption reserves its action height before an update arrives;
activity metadata stays on one line so enrichment does not push later rows down.

Access leads with pending approvals and explains the selected mode. Existing
session grants, reusable access, refresh and Connections remain available.
Unsupported service/tool/limit diagnostics start behind Runtime details. This
view observes access; opening it does not grant access or start execution.

Resources → Context shows the same measured usage and capacity as the token
wheel, including remaining tokens when capacity is valid. Unknown, expired and
stale capacity never produces a percentage. Native request totals are explained
as request usage rather than an exact retained context measurement. Context
blocks receive readable mobile rows and an explanation when the runtime only
permits removing selections. Instructions and compaction history remain available
behind a disclosure. Context selection does not itself deliver a provider input.

References explains its purpose and defaults to conversation links and workspace
files. Tool-only URLs remain available through Include links from tool output.
Role filters appear only when multiple roles exist. References remain mentions,
not proof of an output, successful read, authorization or publication.

Terminal continues to navigate to the chat-scoped terminal page, preserving its
return link and draft. Its tooltip now says where it opens. An inline terminal
is a separate layout choice awaiting the operator's preference.

## Design and validation

The change reuses HomeDialog, UiIcon, semantic palette/type/spacing/radius tokens,
existing environment cards, context usage meters and collection controls. The
operator's request to stop reordering is recorded as a new chat-activity ledger
revision; the earlier approval and reference are retained. No palette or font
source is introduced.

Test-first regressions demonstrated the original host, missing budget, noisy
references, automatic reordering and missing HTTP activity behavior. Initial
focused frontend checks: 84 passed. The final focused component/hook/page/design
run passes 203 checks with one existing skip; all 186 API route regressions pass
using a loopback-only test listener. ESLint and formatting pass for changed files.
The final geometry fix is covered by the design rerun and pending browser fixture.

Offline browser fixtures cover stable ordering after browsing ends, explicit
refresh, narrow phone/desktop controls, light/dark and alternate appearance,
token budgets, context selection, References, Runtime details, focus and retained
drafts. The source-bundled chat-ui-usability fixture needs no full application
build, backend, credentials or model calls.

Visual acceptance remains pending: the approved native Playwright command still
carried the macOS Seatbelt marker, and the repository guard refused before browser
launch. No browser was launched or screenshots inspected. The full frontend Vite
build exhausted the required 1 GiB heap; full build/type and browser acceptance
remain CI checks. TaskExecution also lost operator authentication before a later
run; its rejected operation did not start. Permitted native offline checks
continued in the isolated task checkout. No live service, staging or deployment
was used.
