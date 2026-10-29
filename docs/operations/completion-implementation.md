# Completion implementation ownership map

Base: accepted GitHub main `7fe4360935efbe19602a412f45c6b3ed0829953d`, independently
read from origin on 29 October 2026. The running Node server cwd and retained
release.txt identify the same deployed release. Implementation is isolated in
`fix/completion-ownership`; neither production nor retained task checkouts change.

| Boundary | Existing authority and durable identity | Retain / remove | Failure semantics and required evidence |
| --- | --- | --- | --- |
| Preparation / continuation | RepositoryWorkspaces qualified preparation, account binding, adopted workspace ID and adoption receipt; original source/base intent remains immutable | Reuse current-task/HEAD through adopted identity; avoid second allocation and redundant context discovery. Explicit newCheckout remains distinct | Different requested base conflicts unless explicitly new checkout; physical topology and adopted-receipt checks still run. Test actual persisted owners across restart, edits/commit and external writers |
| Physical reads / admission | NativeHostToolContext, OwnedLocalCodexChatAdmission, frozen bootstrap, provenance registry and LocalRepositoryReadAccess | Consolidate duplicate helper phases only within genuine owner lifetime; fresh authority around each independent effect / await | Revocation, external SQLite and filesystem substitution refuse; cancellation/cleanup retain uncertainty. Instrument SQL/helper/credential costs |
| Development setup | Existing prepareDevelopment, workspace-local toolchain and installation receipts | Own writable HOME/temp/npm/node-gyp/toolchain environment, preserve download cache, verify and reuse unchanged artifacts | Safe typed phase/reason/effect classification; platform/ABI/toolchain/lock changes invalidate. Synthetic install with unwritable host caches, credential isolation and second-run counts |
| Provider process / recovery | CodexAppServerClient, existing command attempt/native thread/turn/generation and tool receipts | Retain child exit/signal/stream outcome and derive exact recovery action from existing records | No inferred OOM, success or automatic write replay; exact terminal reconciliation under fresh authority; provider completion survives later failure |
| Diagnostics / publication | Existing tool result, command/native and RequestGithubPublish operation records | Preserve safe structured cause and identities; reuse connection/review/approval/publication operation | Expired approval requires existing reauthorization; unknown writes stay fenced. Reconnect/expiry and lost ACK tests; no second publisher |
| Streaming / transcript | CodexTextProjection, MessageStreamState, pure conversation-transcript from retained performance work | Integrate four preserved commits; remove completed-text rescans, duplicate block/input/open state and repeated terminal projections | Preserve compatibility exports and exact event-prefix behavior. Run composed real SQLite/synthetic provider tests and operation-count budgets |

Retained inventory: all four original task checkouts are clean. `git cherry`
finds none of their commits in accepted main. Integrate performance 935c075,
58719c0, c251c01, eb741b1. Approval preservation cdfd975 is relevant to reconnect;
screenshot 452ee56 and WebSocket 9950918 require independent scope/validation,
not attribution of native process loss. Credential relay 25cc6d2 is unrelated to
these owner changes and remains preserved on a retained ref, not indiscriminately
combined.

Each implementation slice is test-first, with test+code committed together.
Offline validation uses synthetic transports, actual stores and controlled temp
repositories. No live models, services, production DB writes, queue release,
session resume, staging activity, merge or deployment are authorized here.

Final evidence and remaining acceptance gaps are recorded after implementation;
historical trace sums are not controlled before/after timings.
