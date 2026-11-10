# Drained maintenance with permanently blocked historical commands

This is a separate, explicit maintenance transition for installed source
`279e6703dedebaeb130993fd6e2657b2aed73c0a`. It does not claim that the installed
pause/activate guard approved historical uncertainty. Use ordinary protocol 1
pause/continuation for subsequent supported deployments. Staging remains stood down.

The operator must explicitly choose permanent quarantine of the reviewed old
commands. Their original send/native rows and the original capturing operation
remain unchanged. Quarantine blocks all future input, native FIFO dispatch,
recovery and queue mutation for those historical conversation IDs; retained
history remains readable. Missing custody never becomes proof of completion.
There is no automatic expiry, retry, unquarantine or synthetic settlement.

## Prepare before installing a hold

Land the maintenance and Telos archive changes with exact-head combined CI and
trusted final reviews. Prepare a detached accepted release, verified CI artifacts,
source pins, runtime declarations, configuration and rollback records first.
Do not run broad local builds under warning memory pressure. No live model test
is needed. Preserve original models/accounts for actual resumed user work.

Keep the operator JWT, reviewed pending-command fingerprints, capture plan and
private continuation capability in mode-0600 files under
`<MITZO_CODEX_PRIVATE_DIR>/deployment`, an owned mode-0700 directory inside the
already protected native private root. Use normal interactive login. Never mint
a JWT from the signing secret or expose credentials in arguments/logs. The
reviewed command list is an explicit array of `{commandId, sha256}` records for
the previously inspected historical rows, in command-ID order. It is not an
instruction to quarantine newly discovered current work.

Independently prepare the accepted MGMT importer and private Telos transfer.
Identify the actual legacy refresh/CLI writers. A running operator terminal is
an independent workload, not proof that Telos has no writers. Preserve its
original tmux/task custody and uncertain in-flight input; this procedure neither
ends that terminal nor labels its commands settled.

## Capture and drain the original owners

1. Use the accepted deployment CLI's `prepare TARGET_COMMIT` with a fresh private
   source-state file. In this installation the known historical admission
   predicate refuses capture **after** installing its real durable global hold.
   Require the exact original operation, actor, source and target, phase
   `capturing`, empty session capture and no activation hash. Any other failure
   requires inspection. Do not call installed `activate` or use first-install
   idle procedures.
2. From the accepted release run:

   ```sh
   node scripts/deployment-maintenance.mjs capture \
     "$plan" "$operator_token" "$events_db" "$native_db" \
     "$source_pid" "$source_operation_id" "$reviewed_commands"
   ```

   The CLI verifies signed source observations, original listener/process group,
   hold bytes, local Codex account/runtime/workspace and host custody. It captures
   exact accepted targets for currently running turns and all current owner IDs.
   It reads SQLite through read-only handles and publishes private evidence and
   the separate candidate resume-state file exclusively, with fsync. No old
   activation capability is created.

3. Let the captured current turns complete naturally. Do not interrupt, cancel,
   steer, retry, start replacement prompts or infer success from cancellation,
   silence, terminal metadata or absent rows. Run `... observe "$plan"
"$operator_token"`. Every captured target must match a positive completed
   native execution/turn receipt; global current effects, pending ownership,
   child activity, startup and background execution must be clear. Unknown
   current effects stop this path. There is no deadline extension or force kill.
4. Run `... seal "$plan" "$operator_token"` before closing owners. This
   separately fsyncs the positive completion-receipt fingerprint and a fresh
   helper census, binding PID birth times as well as IDs. It captures helpers
   created while the original turns were finishing. Retain both capture and
   sealed evidence; adoption requires both and revalidates their receipts.
5. Through a real signed SSE connection and its current `X-Connection-ID`, call
   the normal `/api/chat/stop` control for each captured owner only after this
   proof. This closes warm providers while events/native stores are writable;
   ordinary worktrees and task data remain retained. Confirm the active registry
   is empty and all ordinary native, host, MCP and lease owners actually closed.
   The supported original local ownership path disables project hooks; qualify
   that exact installed source path rather than assuming a generic SessionEnd
   hook cannot create effects. Generic cleanup-unconfirmed logs are not proof.

## Exclude source replacement and require natural exit

Disabling an already-loaded KeepAlive launchd job is insufficient: a disposable
sleep-only host qualification on 10 November 2026 observed it respawn after
SIGTERM despite `disable`. Do not use disable alone, a port disappearance, or a
last unlocked GET as the source fence.

The supported path uses launchd's documented **one-shot next-program override**
to the accepted release's inert persistent guard. It needs normal macOS
administrator authentication; enter credentials only in the OS dialog:

```sh
sudo launchctl debug "gui/$(id -u)/com.mitzo.server" \
  --program "$accepted_release/scripts/deployment-maintenance-guard.sh"
```

The physical accepted release must be outside Documents and other launchd-private
locations. The helper ignores the original job's arguments, reads no app
configuration and replaces itself with a persistent fixed Perl sleep loop. Its
next-program-only invocation was qualified on a fresh inert user job on
10 November 2026, including disabled KeepAlive respawn, original PID replacement,
UID, actual executable, fixed inert arguments, persistence and successful cleanup.
The qualification targeted no Mitzo production process, port or data. Retain the
receipt and verify the accepted helper's exact source hash before production use.
Do not substitute a tail/argv override: that attempted variant was not qualified.

The override applies to the next invocation only. Require successful installation
against the exact loaded source job before signaling it; preserve the guard if
anything fails. Administrator authentication changes only that next program; the
replacement remains the existing user job. Ordinary deployment authorization
does not provide an administrator password.

After ordinary owners close, reserve an events SQLite writer with `BEGIN
IMMEDIATE`. Re-read the exact capturing operation, original file identity and
current actor/revocation under that reservation. Require a fresh signed source
GET under the reservation immediately before signaling; a blocked, revoked or
unavailable source-auth observation refuses shutdown. Its readable hold continues to
block native FIFO; the writer reservation excludes old `/deployment/cancel` and
new admission mutations. Do **not** lock native SQLite across owner close.
A tasks writer reservation can exclude new terminal HTTP operations but cannot
prove pre-fence operations drained; terminal input can write after an await
without another DB mutation. Do not use it as terminal or Telos quiescence proof.

Disable the job for reboot persistence, send normal SIGTERM, and retain the
events reservation until the exact original PID has naturally exited, with
confirmed normal shutdown, no replacement Mitzo process and no original ordinary
helper/lease left alive. The next job must be the inert guard. Only then remove
that guard job with `bootout`; it must not target a live Mitzo owner. A timeout,
changed owner, failed cleanup or uncertain exit retains the hold/guard/evidence;
there is no SIGKILL fallback or automatic old-source restart.

Stop the actual legacy Telos writers separately. Complete the explicitly selected
private orphan-archive transfer, credential configuration and accepted importer
selection under the [storage cutover contract](telos-storage-cutover.md).
Keep the source and recovery evidence. After target writes, rollback to old
storage is not supported by this maintenance transition.

## Adopt, start and restore

With source launchd job fully unloaded, original process group/helpers gone and
actual stores excluded, run from the accepted detached target:

```sh
node scripts/deployment-maintenance.mjs adopt "$plan" "$operator_token"
```

The CLI checks the accepted-source guard, original file/hold identities, current
signed operator and persistent revocation, positive original owner completion
and actual current admission semantics. A separate native writer reservation
excludes native mutation after owner close. One events transaction retains every
original uncertain row, permanently quarantines exactly the reviewed historical
sessions, retires only the original hold bit without rewriting its operation,
and creates a **new** `drained-handoff-v1` hold with a separate capability hash.
It does not mint the installed operation's activation hash or pause-settled facts.
Only the plan owners with originally captured running targets receive entries
in the new operation. Their distinct `drainedProof` binds the sealed handoff,
exact target, positive completed execution receipt and original custody. Idle
owners and quarantined history cannot acquire continuation entries.
Uncertain publication/adoption is inspected by identity, never blindly rerun or
deleted to make progress.

Before adopting, the CLI exclusively publishes the private permanent
`deployment/required-handoff.json` requirement, binding the original plan and
sealed evidence. Startup discovers this marker even without an environment
selector. Keep the marker, plan, seal, continuation state and quarantine data in
backups permanently. Restoring an old events file or omitting the selector must
fail before app routes, timers or recovery start. An explicit
`MITZO_MAINTENANCE_PLAN_FILE` must identify the same protected plan. Never remove
the marker or evidence to make startup pass. A completed handoff remains valid
historical evidence on later accepted releases; it grants no new delivery authority.

Start the accepted target only after adoption and Telos transfer succeed. New
ordinary admission/FIFO remains held. Set the ordinary deployment CLI state path
to the private `$plan.resume.json`, then use `health` and `resume`. The maintenance
coordinator requires the exact healthy, initially quiescent target and its
separate private capability; it refuses cancel and rollback. Each originally
running owner receives the existing code-owned deployment continuation through
normal ordinary admission, with its stable resume ID. Original queued input
keeps its ordering, and completed/unknown tools are never replayed. Idle owners
receive no prompt and retain their history cold until actual new user work.

On a partial retry, a previously accepted continuation may now be running. Its
original receipt can be reconciled without requiring that new work to finish;
new delivery still requires that entry's original drained/custody/effect proof.
An uncertain attempted continuation cannot be resent. The new proof never acts
as a generic permission to clear uncertainty or retry old commands.

Verify actual original-running owner readiness and the correlated native
continuation/queued-input receipts, stable IDs, accounts, runtime/workspace,
retained history and FIFO ordering. Admission acceptance is not task completion;
failed or unavailable providers must be reported honestly. Do not use the generic
cold `/reattach` or queue `/continue` routes as a substitute: bound cold chats
need the existing guarded deployment dispatch, and idle chats need no new input.
Reconnect the independent terminal without changing its original tmux/task
identity. Confirm actual refresh-service configuration and import adoption,
representative Telos rows/artifacts and that no old writer restarted.

The CLI supports only this retained local source. Unsupported owners, changed
custody, new uncertainty or missing positive completion evidence fail closed.
Its archived historical states remain unknown and permanently non-executable.
