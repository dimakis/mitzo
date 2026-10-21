# Telos lifecycle amendment

The user-approved additive lifecycle controls are separate from the original
Telos acceptance scope. Canonical completion statuses remain `active`,
`acknowledged`, `snoozed` and `completed`.

## Operator API

- `GET /api/telos/work/items/:itemId/lifecycle` reads current lifecycle and history.
- `GET /api/telos/work/lifecycle?view=active|archive|trash` reads the selected view.
- `POST /api/telos/work/lifecycle` requires strict JSON containing `requestId`,
  `itemId`, current `expectedRevision` and `operation`: `pause`, `resume`, `archive`,
  `unarchive`, `trash`, `restore` or `delete_permanently`.
- Only `delete_permanently` accepts and requires
  `confirmation: { itemId, phrase: 'DELETE PERMANENTLY' }`. The item must match.

The existing interactive operator middleware, current session authority and
same-origin JSON guard protect mutations. Internal tokens and conversation tools
do not authorize lifecycle commands. Actor identity is never command JSON.
Exact actor/request/input retries recover their original receipt, including after
restart or permanent deletion. Changed input under the same identity conflicts.
Receipts are historical snapshots; read lifecycle again for current state.

## Pause and active workers

Pause creates existing scoped controls for `new_worker_dispatch`, `safe_point`
and `publication`, rooted at the selected outcome/coordinator. Their explicit
`origin: 'operator_pause'` has null coordinator conversation and priority item;
there is no manufactured lead, priority decision or acknowledgement. Older
coordinator controls retain their required coordinator and priority identities.

A requested hold already denies a new action at its actual admission boundary.
Existing turns are not aborted. ACK requires the actual current recipient and
assignment revision. Applied evidence comes from the existing host enforcement
or verified safe-point path. Missing or replaced recipients remain pending.
The lifecycle pause stage requires evidence across its controls; a single lead
ACK cannot report the whole outcome safely paused.

Resume releases only that root's operator pause controls. Independent coordinator
holds survive. Existing publication release rules still require current-main
revalidation. Archive/trash restoration does not resume paused work.

## Archive, trash and restore

Archive and trash preserve item identity, canonical parent links, brief, original
timestamps, completion status, source records, assignment history, work attempts,
artifacts and provider history. They deny new work through the existing scoped
admission paths; current output and receipts remain readable/reconcilable. There
is no Stop, cancellation, scheduler, file removal or automatic purge.

Descendants inherit visibility and action denial from hidden ancestors without
rewriting child lifecycle or parent links. Trash takes visibility precedence over
archive. Restore returns the selected item to its own pre-trash active/archive
state; another hidden ancestor can still keep it hidden. SQLite guards also
prevent external canonical writers from moving work out of hidden ancestry or
adding children beneath it.

Lifecycle state and commands commit atomically in additive same-database tables.
Work revision tokens include changed lifecycle ancestry, invalidating previously
admitted child mutations. Unchanged legacy work retains its original token.
History and receipts are retained. Traversals are bounded to 1,000 ancestors and
5,000 collection rows; oversize selections fail explicitly.

## Separate permanent deletion

The operator must first trash the exact item and separately confirm deletion at
its current revision. The backend refuses children and retained relationships,
sources, artifacts, sessions, work, control/publication records, source identity,
goal context and references in extension tables. Unknown references stay retained.
Only exact owned metadata/history table names are exempted. Extension names that
share their prefix remain checked, and reference scans cover actual column
storage regardless of declared type, including JSON, untyped and generated columns.
It does not infer disposable relationships or cascade through a graph.

In addition, the existing host must synchronously verify quiescence through
`createTelosWorkRouter.assertLifecycleQuiescent(itemId)`. Missing, asynchronous,
busy or unknown host evidence refuses deletion. Core owns that real composition;
this amendment does not install a replacement runtime or infer idle from a chat
being absent. The production callback remains unconfigured until Core can bind
truthful evidence.

Only a confirmed, unreferenced, quiescent leaf can lose its canonical item row
and item-owned status history. No shared files or artifacts are deleted. Minimal
lifecycle audit and request receipts remain, and deleted IDs cannot be reused.

## Existing list composition

Core owns the shared application route change. Its existing successful
`TodoListResponse` parser output feeds the pure
`projectTelosLifecycleTree(canonical, lifecycle, view = 'active')` helper.
For the default active view, the already-authenticated canonical list uses
`collectTelosCanonicalItemIds(canonical)` followed by
`work.lifecycleVisibilityForCanonicalList(originalParsedItemIds)`. The pure
collector shares the projection's existing node parser, duplicate checks and
5,000-node/1,000-depth bounds, retaining original tree order without mutation or
another application-side parser. This bounded,
read-only host seam returns only `itemId` and `effectiveDisposition` for requested
existing IDs. It grants no authority, queries no history/control/assignment tables,
and has no public HTTP or native-tool route. It works with the initialized
read-only store and never fabricates an operator for existing internal-token
readers. Missing/deleted identities are omitted. Archive and Trash list views
require a current interactive operator and use the existing same-database
`work.listLifecycle(view, realOperator)`; full lifecycle/history and mutations
retain their operator gates.
The helper filters by effective visibility and promotes matching archive/trash
presentation roots while preserving their canonical `parentId`. It retains
priority, age and source fields, recomputes visible child counts, and never sorts
or writes. Missing current lifecycle identities are omitted rather than assumed
active. S7 owns frontend controls, priority/age sorting and nullable pause display;
S9 owns integrated acceptance after Core composition.
