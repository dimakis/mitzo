# Ordinary Claude approval parity

Qualification: 14 November 2026, main `f801f8df6cac9c1305727b85a7235928eef2e175`,
Agent SDK `0.3.322`. Applies to ordinary Local Mac personal Claude and guarded
Vertex, which already share the SDK query and command owners.

## Implementation

The existing SDK `PreToolUse`/`canUseTool` adapter continues to call
`buildPermissionHandler` in `@mitzo/harness`. Mitzo MCP tools continue through
their canonical handlers, which own operation-specific approvals and effects.
No extra MCP service, grant store, request ledger or provider abstraction is added.

The shared handler now observes both the original callback cancellation signal
and the session owner's signal. Cancellation refuses automatic reads as well as
pending approvals, clears the existing card, retains its cancelled audit outcome,
and prevents a late response from saving consent. Both listeners are removed at
settlement, preserving the existing one-shot decision observation contract.

Ordinary SDK registration supplies the existing authority owner's synchronous
assertion to the shared handler. It rechecks the original caller, account,
workspace and accepted selection before allowing the tool or recording retained
consent after a human wait. A failed assertion returns a sanitized refusal and
logs the original cause internally. Existing asynchronous checks around SDK
callbacks and canonical handler effect checks remain active.

The shared write guard also recognizes the actual SDK name `NotebookEdit` and its
`notebook_path` field. It normalizes absolute paths and resolves relative file
writes against the session cwd before comparing worktree boundaries. Existing
legacy `EditNotebook` callers remain supported.

| Mitzo mode | Native SDK mode | Shared enforcement                                           |
| ---------- | --------------- | ------------------------------------------------------------ |
| Ask        | `plan`          | Read-only ceiling before cached consent or worktree creation |
| Agent      | `default`       | Workspace edits permitted; commands require consent          |
| Auto       | `default`       | Workspace edits and commands permitted by the shared policy  |

Profile and active skill restrictions still precede approval. SDK bypass/auto
permission modes are not enabled. Service approvals, task grants and network
authority stay with their existing owners. Approval records consent; a returned
tool result is still required to claim execution.

## Executed offline evidence

- `packages/harness/__tests__/permission-live-authority.test.ts`: independent
  callback/session cancellation, cancelled Ask/Agent/Auto reads, authority loss
  before an `always` response, original-card replay after reattach, foreign
  conversation rejection, and single settlement/effect after duplicate responses.
- `packages/harness/__tests__/sdk-write-scope.test.ts`: native notebook policy and
  denial of relative/normalized paths outside the selected worktree.
- `server/__tests__/claude-native-development.test.ts`: eleven scenarios execute
  the installed SDK and native Bash using canned loopback Messages responses and
  disposable homes/repositories. Allowed scenarios write files; Ask, explicit
  denial, cancellation, authority revocation, active skill restriction and
  workspace refusal return errors without writes. Native interrupt acknowledges
  cancellation and removes the pending card without firing the watchdog. Each
  prompted invocation produces one card and no retained broad grant.
- `tests/integration/ordinary-local-vertex-chat.test.ts`: 13 public admission
  scenarios pass through the actual ordinary SDK command/query owner, including
  first, queued and settled cold continuation. The installed callback resolves
  each original command once under the original operator/conversation; an
  excluded shell in the explicit profile is denied. Existing real in-memory MCP
  handler invocation and credential/refused-input checks remain covered.
- The focused 19-suite regression selection passed **377 tests**, including
  permission observation, expiry/renewal, audit, notifications, device handoff,
  native Codex approvals and SDK handler authority refusal.
- Server build, full source typecheck, changed-source lint and reviewed artifact
  checks pass. Native and public-consumer tests use synthetic credentials only;
  no real provider/account/service qualification or production write is claimed.

## Integration custody and limits

PR [#1342](https://github.com/dimakis/mitzo/pull/1342) was refreshed as draft/open,
conflicting at `b2675af8199ab8a99f3628d3d93c4e65145c7244`. It retains TaskExecution,
notification and immutable command-skill ceiling custody. Its integrator and the
previous parity lead were unavailable through live peer discovery. This batch
does not recreate that work or claim its combined acceptance. Reconcile its
conflicts and rerun its SDK-to-executor grant reuse/scope/revocation tests before
accepting the full feature.

Lifecycle PR [#1348](https://github.com/dimakis/mitzo/pull/1348),
`04a4b331e4776868ab6d50e423b392b16fe8e098`, was qualified in a disposable source
composition with this batch's permission and public-callback changes: **36 tests
in three suites passed**, including public Stop/reconnect/Continue for personal
and Vertex. Its branch and implementation are unchanged. Settled cold Send is
covered; unsupported cold Continue and uncertain interrupted operations remain
with the lifecycle owner. Reconnect replays existing pending card identities;
this batch does not reconstruct pending decisions after a controller restart.

Integrate shared `chat.ts`, native/public test and reviewed-source-pin edits
sequentially. In the native probe, preserve #1348's disposable Git commit/push
coverage when combining its command with the approval scenarios. Regenerate
source pins for the final composed candidate rather than choosing one branch's
hashes. Connections and Telos adapters retain their separate owners.

The existing Bash path heuristic is not an arbitrary-shell filesystem sandbox.
Normalization closes explicit traversal in the existing guard; it does not prove
symlink or indirect shell confinement. TaskExecution remains the owner of bounded
command roots/network/grants. Broader native shell isolation is outside this
focused adapter repair.

Two local read-only reviews found no implementation blocker. The behavior review
identified the native interrupt watchdog false positive, which was repaired and
retested. Saved specialist authorization and recovery both failed with
`specialist_tool_failed`; no cross-model specialist contribution was obtained.
Normal CI/review gates remain required. Merge and deployment are not authorized.
