# Canonical ordinary-work integration qualification

`server/__tests__/telos-ordinary-canonical-journey.test.ts` qualifies the CT09
backend journey against the accepted MGMT `3077b7b4` fresh schema, using synthetic
rows in a private temporary database. It adds integration coverage to the existing
ordinary workspace contract; it introduces no new allocator, dispatcher or
production behavior.

The test uses the actual application, authenticated typed clients, ordinary
readiness and reviewed V2 role routes. A synthetic operator retains an acoustic
plan, reviews an ordinary advisor and saves a child from that advisor's selected
source. A separately reviewed lead starts through the actual native command
router. Its unchanged internal delegation route provisions exactly that child
with independent worker conversation, workspace and TaskStore identities. Exact
and concurrent duplicate delegation recover the original receipt without starting
worker execution. The fixture's unrelated auxiliary prepared session remains
untouched.

An explicit worker command passes real custody, native admission and the existing
command ledger. Fake provider RPCs acknowledge startup and the turn; no native
model executable or account is invoked. Actual bundled task MCP starts through
stdio. In source-mode tests only, the entrypoint adapter resolves the test loader
and Node executable absolutely because the real task cwd deliberately contains
neither a repository nor `node_modules`. Its callback server uses an ephemeral
private port, never a configured production or historical staging port.

The fake provider writes a report in the claimed worker directory and emits native
message events. The authenticated Files route reads those actual bytes. The real
Telos artifact path bridge then retains them, and the test compares saved bytes
and digest. Provider-side tool requests pass through native tool identity,
permission and tool-result owners into actual MCP task handlers and application
callbacks. A synthetic operator explicitly answers each actual permission request
once. TaskArtifact retains the artifact reference; TaskComplete stops at
`pending_review`. A separate synthetic verification reads the retained report,
approves the task through the authenticated route, and only then asks the lead's
item-update route to record verified completion. These synthetic actions qualify
workflow semantics, not human acceptance of real work.

Detach/reattach and exact consumed-command replay retain identity without a second
turn. After explicit native stops, the test reopens workspace custody and canonical
artifact owners, opens an independent task reader, and checks original IDs,
completed state, file bytes and directory inode. This is bounded owner recovery,
not a full server-process restart or revocation-owner replacement. Existing CT08
regressions separately cover interrupted allocation and owner restarts. Actual
repository authority ports remain forbidden; configured and task directories have
no `.git`, and no repository ID is supplied. Existing repository pinning tests
remain applicable.

Initial integration runs exposed fixture schema, source-loader, RPC-lifecycle and
explicit permission-response assumptions. Those runs are diagnostics, not a
manufactured failing-before product regression. This increment changes only the
test and its documentation. Focused ordinary/native, advisor and canonical-schema
regressions accompany the qualification. Existing intercepted ordinary role, chat
and Files browser journeys separately cover responsive UI, draft retention,
manual retry, Resources navigation and editing; this test is not a browser joined
to the backend. Pixel approval, S7/S9 acceptance, dependency acceptance, exact-head
CI/trusted review and final combined-base validation remain separate gates.

No live target, model-backed test, staging operation or deployment is authorized
or qualified by this evidence.
