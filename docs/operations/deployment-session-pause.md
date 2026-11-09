# Server deployment with session pause and continuation

Deployment is a separately authorized production operation. Staging remains stood
down. Build and preflight the accepted release before pausing any work.

The server exposes protocol 1 at `/api/deployment`. It requires a current signed
interactive operator JWT, persistent logout/revocation authority and same-origin
JSON mutations. Internal agent tokens cannot control owned chats. The deployment
script reads its JWT from `MITZO_DEPLOY_OPERATOR_TOKEN_FILE` (regular file, mode 0600) and retains its operation ID in `MITZO_DEPLOY_STATE_PATH` (private file).
It sends credentials only to `http://127.0.0.1:3101`, without redirects. Do not put
tokens in command arguments or logs. Use a fresh state path for each deployment.

The durable ledger shares the event database and its admission transactions. It
records the source/target release, signed actor expiry, exact active native turn,
account/runtime/workspace/settings, cancellation claim, pause proof and stable
continuation ID. It contains no credentials. Keep it with normal database backups;
never delete uncertainty records to unblock a restart.

1. `node scripts/deployment-sessions.mjs prepare TARGET_COMMIT` installs the global
   admission hold, captures active owned ordinary Codex sessions and requests exact
   parent/child cancellation. New ordinary input, native FIFO claims and new child
   controls are held; active tool/terminal receipts may settle. Saved queued input
   remains in its original FIFO. Unsupported live owners, unresolved startup,
   contributor/adviser ownership and uncaptured child activity block preparation.
2. Cancellation acknowledgement is not pause proof. The source runtime must
   observe the exact terminal turn, bounded native item/tree evidence and original
   settled host receipts. Unknown shell/patch/host effects or missing evidence
   block activation. Legacy child receipts without trusted effect metadata remain blocked
   until independently reconciled; migration never labels them settled. The ledger distinguishes interrupted capture from an empty
   successfully captured inventory.
3. `node scripts/deployment-sessions.mjs activate` claims external activation
   ownership while the source is still quiescent. Its private capability stays in
   the local state file; the ledger retains only its hash. Once claimed, another
   request cannot cancel the hold or resume the old source while the deployment
   process may still restart it. Preserve the same operation through rollback.
4. Activate the accepted release. `... health` verifies the exact target and fresh
   Yapper/ContexGin health before any continuation. `... resume` uses the activation
   capability and the existing ordinary headless dispatch owner, with fresh actor,
   account, workspace, runtime, policy and closure checks. Only captured sessions
   receive a new continuation; original interrupted tools are never replayed.
5. A stable continuation ID is claimed once. After a lost acknowledgement, inspect
   its original admission receipt rather than resend. The ledger remains held for
   blocked or uncertain sessions. Completed admission is reported as resumed; it
   does not claim that the agent finished its task.

`scripts/deploy.sh` performs this sequence after its existing build/preflight.
Before continuation starts, activation/health failure restores the previous plist
and explicitly invokes `... rollback` against its exact healthy source commit.
After continuation starts, an error must not roll back over running resumed work.
The activation owner must finish or reconcile rollback; the API does not offer an
unsafe lease timeout or automatic hold expiry. If that process is lost, retain its
private state/capability, confirm no forward activation process remains, and
reconcile the same operation. A pre-activation `... cancel` releases the hold but
leaves paused sessions and all histories intact for explicit operator continuation.

## Recovering an interrupted deployment

The global inventory also checks durable ordinary admission/startup uncertainty,
cold parent effect/completion fences and pending native thread ownership. Empty
registry and terminal chat metadata do not prove that those owners have settled.

If the deployment JWT expires or is revoked, obtain a fresh primary interactive
login through the existing sign-in flow, update the private operator-token file,
and run `node scripts/deployment-sessions.mjs reauthorize` with the original private
state/capability. This explicit action revalidates current custody and settings for every continuation
still needing session control and retains the earlier actor in the ledger. It never renews
old tool consent or sends a continuation by itself.

After repairing a session marked `blocked` before delivery, run
`node scripts/deployment-sessions.mjs reconcile SESSION_ID`, then the appropriate
`resume` or `rollback` command. Reconciliation requires current custody, original
pause proof and definite absence of any delivery attempt/receipt. A session marked
`uncertain`, or any possibly attempted delivery, cannot use this path. Inspect its
original receipt; never resend it just because acknowledgement was lost.

## First installation

An older daemon cannot enforce this protocol. The CLI refuses a missing protocol;
it does not interrupt through a side channel, edit native databases, fabricate
operator authority or bypass an idle guard. The first accepted release containing
this capability must use the retained idle deployment procedure. Later redeploys
can pause/resume active qualified sessions through the API. Live model tests are
not part of deployment; any such test needs separately authorized target, supported
Luna selection and advance exact model/account disclosure.
