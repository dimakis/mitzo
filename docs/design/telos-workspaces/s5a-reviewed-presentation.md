# Reviewed human context labels

The role review response now pairs the unchanged strict context selection with a
separate immutable presentation. `POST /api/telos/work/roles/review` accepts the
same request as `roles/context` and returns `{version:1,selection,presentationRef,
presentation}`. `POST /api/telos/work/roles/setup-reviewed` accepts
`{version:1,input,presentationRef}`, where `input` is the existing role setup body.
The old context/setup endpoints and their retained identities stay compatible.

The presentation contains authorized item/goal/parent names at the selected work
revisions, retained source packet title/date and exact artifact revision metadata.
Its `contextSha256` covers the complete normalized selection, including ancestry,
role, goal, sources and material pins. The reference digest covers the complete
normalized presentation. This data explains the selected context and grants no
allocation, task or read authority.

The WorkStore journals the review and associates its exact reference with a setup
request in the existing admission transaction. The original actor and unchanged
input fingerprint must match. A reference cannot attach retroactively to an
existing intent, receipt or rejection. Omission/mismatch cannot borrow positive
pre-allocation recovery proof. A new delegated worker captures the same metadata
inside the existing attempt transaction before work revision advances; replay
uses its retained association, and historical attempts stay on truthful fallback.

A separate immutable session event binds display bytes to the original full
selection, conversation and account scope. The existing context and contributor
guidance events are untouched; S5 TaskStore bindings retain the same context hash.
Session metadata resolves verified display data without consulting current labels.
The setup hook preserves it through uncertainty, rejection history and reload.

The existing native disclosure presents names, source dates and material titles,
filenames and revisions. Source-capture internal filenames stay in the exact
artifact/download; the primary explanation says Reviewed source record. Missing
historical metadata uses generic labels; present malformed metadata fails closed.
No settings surface, shared token, frozen reference or protection changes.

Focused evidence includes actual canonical MGMT fresh schema, HTTP/public client,
full-selection/account/conversation mismatch and immutable events, ordinary
response-loss/restart, worker task/context hash preservation and seventeen hook
cases. Package/scoped server/frontend types pass. Eight browser scenarios cover
metadata and reviewed-wrapper recovery on mobile WebKit and desktop Chromium,
light/dark, 320px, alternate accents and 160% Georgia, focus/44px actions, exact
material errors and retained composer drafts. Captures are implementation evidence.
Full-shell and final combined CI/review remain required. The separate CT06
canonical journey now passes offline through real runtime admission and dispatch,
with fake provider effects; see [its evidence](s5a-canonical-journey.md). Whole S5a
acceptance remains open; S5b runtime still requires accepted S5a.

All evidence is synthetic/offline, with fake provider/external effects. No live
model, staging, production or deployment qualification is claimed.
