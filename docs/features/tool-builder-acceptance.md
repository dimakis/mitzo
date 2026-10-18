# Tool Builder source acceptance

Phase 4 extends the existing Tool library and reusable agent profiles. Source
acceptance is independent of deployment, live API/model qualification and agent
assignment. Phases 1–3 remain source accepted with live qualification outstanding.
No target is selected by this document; staging and production remain untouched.

## Contract

See [draft, review and publication](../design/tool-builder.md) and
[bounded development](../design/tool-builder-development.md). The code-owned
Tool Builder opens in regular chat settings/composer with its pinned profile.
It interviews the user, searches actual installed contracts first and recommends
reuse or configuration of the existing reviewed Home Assistant API template when
suitable. Illustrative tools from the original mock are not installed inventory.

Custom work requires an authorized isolated worktree and exact development
approval. The Builder writes a complete typed source bundle, strict bounded
schemas, examples, tests, permissions and compatibility. The fixed offline runner
can report success; that candidate report is private review material. The regular
Tool library offers versioned source inspection, a downloadable JSON review bundle,
independent operator feedback/acceptance and a separate publication action.
Feedback revision never edits accepted versions. The Builder has no review or
publication tool and cannot approve its own work.

There is no runtime upload/import bridge. An accepted application source change
must statically install the exact implementation, validators, independent checks
and complete source mappings in the code-owned registry. The initial inventory
is empty. Publication refuses a missing installation, unsupported permissions
or routes, changed closure or failed independent qualification. Successful
publication creates an immutable opaque catalog identity/version/revision.
Assigning it to an agent remains a separate explicit selection and requires a
new chat; active-session refresh is unsupported.

## Deterministic evidence

- `tool-builder.test.ts`: catalog reuse without allocation; tested unpublished
  drafts; bounded input/output contracts; exact complete source/evidence binding;
  independent snapshots; failed/cancelled/incomplete checks and cleanup.
- `tool-builder-review.test.ts`: immutable feedback/version fences, denied review,
  installed-source/schema/closure binding, independent qualification, retries,
  overlapping attempts, cancellation, revocation and operator route isolation.
- `tool-builder-workspace.test.ts`, `tool-builder-test-runner.test.ts`: actual
  temporary filesystem and OS sandbox boundaries, no-follow descriptor ownership,
  scoped reads, fixed typed unit entry and retained hostile-candidate diagnostics.
- `custom-tool-admission.test.ts`, `tool-builder-responses.test.ts`: real catalog,
  portable opaque references, exact local OpenAI Responses and Gemini/Vertex
  exposure/dispatch with fake runners; denied/mutated/substituted approval,
  logout/revocation/cancellation/drift and private cold resume. Selection grants
  neither credentials nor execution permission.
- `session-tool-builder-tools.test.ts`, `tool-builder-catalog.test.ts`: real
  contract search, reuse/template advice, tested drafts, duplicate-call coalescing,
  changed retries, authority/worktree replacement, private overlap, Ask mode,
  feedback revision and full generated-draft acceptance through a synthetic static
  installation. Publication alone does not assign the tool to the Builder.
- Frontend unit tests: regular chat entry/picker, strict separate operator actions,
  feedback retention, missing installation, cancelled publication and keyboard focus.
- `tests/offline/tool-builder.spec.ts`: all-intercept actual-page fixtures at
  320px mobile WebKit/Chromium and 1280px desktop Chromium, dark Mint/System and
  light Teal/Georgia, source pages/download, feedback/version switching,
  publication failure/retry, separate assignment, 44px actions, scrolling,
  keyboard focus and Escape. No backend, credentials or model calls.

Red-before-green observations, exact commands, counts, diagnostics and scope
limits are retained in the Phase 4 evidence directory and canonical existing
Phase 4/parent Telos records. Counts from overlapping focused runs must not be
summed as independent coverage. Local checks use one worker and a 1 GiB Node heap;
broad builds/tests and full application browser contracts remain CI gates.
macOS browser checks use the approved execution path outside Seatbelt with the
sandbox flags preserved.

## Remaining qualification

Offline evidence does not qualify a real provider, model, API endpoint, managed
connection, deployment or configured custodian runtime. The custom runtime
supports read-only computation on invocation input on ordinary local API routes.
It exposes no filesystem, shell, connection, credential or general request proxy.
Broader runtime grants need their own reviewed implementation. Custodian routes
and unsupported native/SDK routes retain explicit refusals. Live tests require
separate target authorization and an explicitly declared supported Luna model and
charged account before any real model call.
