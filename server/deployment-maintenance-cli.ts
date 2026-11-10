import { persistMaintenanceRequirement } from './deployment-maintenance-bootstrap.js';
import { maintenanceIdleFingerprint } from './deployment-maintenance-idle.js';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { codexPrivateDirectory } from './codex-private-path.js';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import Database from 'better-sqlite3';
import {
  MaintenancePlan as Plan,
  MaintenanceSeal as Seal,
  MaintenanceProcessIdentity as ProcessIdentity,
} from './deployment-maintenance-format.js';
import {
  EventStore,
  maintenanceFingerprint,
  readMaintenancePendingCommands,
} from '@mitzo/protocol/event-store';
import { createInteractiveAuth, parseCookieMaxAgeHours } from './interactive-auth-core.js';
import { CodexConversationStore } from './codex-conversation-store.js';
import {
  captureMaintenanceOwner,
  assertMaintenanceOwnerDrained,
  assertMaintenanceAdmission,
  drainedMaintenanceSession,
} from './deployment-maintenance-observation.js';
import { readPrivateOperationFile, publishPrivateOperationFile } from './private-operation-file.js';
import { getLocalCommit } from './git-version.js';

function file(path: string) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1)
    throw Error('Existing owned database required');
  return { path, identity: { dev: stat.dev, ino: stat.ino } };
}
function census() {
  return execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,lstart='], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .map((line) => {
      const parts = line.trim().split(/\s+/);
      const [pid, ppid, pgid] = parts.slice(0, 3).map(Number);
      return { pid, ppid, pgid, birth: parts.slice(3).join(' ') };
    });
}
function descendants(source: number, rows: ReturnType<typeof census>) {
  const ids = new Set([source]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows)
      if (ids.has(row.ppid) && !ids.has(row.pid)) {
        ids.add(row.pid);
        changed = true;
      }
  }
  ids.delete(source);
  return rows
    .filter((row) => ids.has(row.pid))
    .map((row) => ({ pid: row.pid, birth: row.birth }))
    .sort((a, b) => a.pid - b.pid);
}
function assertSourceExcluded(
  plan: z.infer<typeof Plan>,
  sealedHelpers: z.infer<typeof ProcessIdentity>[],
) {
  if (process.platform !== 'darwin') throw Error('Qualified macOS maintenance host required');
  const job = spawnSync('/bin/launchctl', ['print', `gui/${process.getuid?.()}/com.mitzo.server`], {
    encoding: 'utf8',
  });
  if (job.status === 0 || !/Could not find service "com\.mitzo\.server"/.test(job.stderr))
    throw Error('Source launchd job must be fully unloaded after natural source exit');
  const disabled = spawnSync('/bin/launchctl', ['print-disabled', `gui/${process.getuid?.()}`], {
    encoding: 'utf8',
  });
  if (disabled.status !== 0 || !/"com\.mitzo\.server"\s*=>\s*true/.test(disabled.stdout))
    throw Error('Source job must remain durably disabled for the maintenance window');
  const rows = census();
  if (
    rows.some(
      (row) =>
        (row.pid === plan.sourcePid && row.birth === plan.sourceBirth) ||
        row.pgid === plan.sourceGroup ||
        [...plan.helpers, ...sealedHelpers].some(
          (helper) => helper.pid === row.pid && helper.birth === row.birth,
        ),
    )
  )
    throw Error('Original source process or helper exclusion is unconfirmed');
  for (const selected of [plan.events, plan.native])
    if (!isDeepStrictEqual(file(selected.path), selected))
      throw Error('Original database file identity changed');
}
/** Invoked only from the accepted release's explicit host operator CLI. */
export async function maintenanceMain(args: string[]): Promise<void> {
  const [action, statePath, tokenPath, ...rest] = args;
  if (
    !['capture', 'capture-idle', 'observe', 'seal', 'adopt'].includes(action) ||
    !statePath?.startsWith('/') ||
    !tokenPath?.startsWith('/')
  )
    throw Error(
      'Usage: deployment-maintenance.mjs capture|capture-idle|observe|seal|adopt ABSOLUTE_PLAN ABSOLUTE_OPERATOR_TOKEN [EVENTS NATIVE SOURCE_PID SOURCE_OPERATION_ID REVIEWED_COMMANDS]',
    );
  const root = resolve(join(codexPrivateDirectory(), 'deployment'));
  for (const path of [statePath, tokenPath])
    if (dirname(resolve(path)) !== root)
      throw Error('Operation evidence must remain inside the protected Codex deployment directory');
  const token = readPrivateOperationFile(tokenPath, 16 * 1024)
    .toString('utf8')
    .trim();
  const base = 'http://127.0.0.1:3101';
  async function request(path: string) {
    const response = await fetch(base + path, {
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw Error('Original signed source observation refused');
    return response.json();
  }
  let plan: z.infer<typeof Plan>;
  if (action === 'capture' || action === 'capture-idle') {
    if (rest.length !== 5)
      throw Error('Exact original file, process and operation identities required');
    const [eventsPath, nativePath, pid, operationId, reviewedPath] = rest;
    if (dirname(resolve(reviewedPath)) !== root)
      throw Error('Reviewed selection must remain inside the protected operation directory');
    const reviewedCommands = Plan.shape.expectedCommands.parse(
      JSON.parse(readPrivateOperationFile(reviewedPath, 1024 * 1024).toString('utf8')),
    );
    const state = await request('/api/deployment');
    const version = await request('/api/version');
    if ((await request('/api/loop/status')).state !== 'idle')
      throw Error('Source background loop must be idle');
    const active = (await request('/api/sessions/active')) as Array<{
      sessionId: string;
      turnInProgress: boolean;
    }>;
    const operation = state.active;
    if (
      state.protocol !== 1 ||
      operation?.id !== operationId ||
      operation.phase !== 'capturing' ||
      operation.sessions.length ||
      operation.activationHash ||
      version.commit !== operation.sourceCommit
    )
      throw Error('Exact installed uncaptured hold required; no installed activation is claimed');
    const rows = census(),
      source = rows.find((row) => row.pid === Number(pid));
    if (!source || source.pid !== source.pgid)
      throw Error('Exact launchd source process group required');
    const loaded = spawnSync(
      '/bin/launchctl',
      ['print', `gui/${process.getuid?.()}/com.mitzo.server`],
      { encoding: 'utf8' },
    );
    if (loaded.status !== 0 || Number(loaded.stdout.match(/^\s*pid = (\d+)$/m)?.[1]) !== source.pid)
      throw Error('Exact loaded source job required');
    const listeners = execFileSync('/usr/sbin/lsof', ['-t', '-nP', '-iTCP:3101', '-sTCP:LISTEN'], {
      encoding: 'utf8',
    })
      .trim()
      .split('\n');
    if (listeners.length !== 1 || Number(listeners[0]) !== source.pid)
      throw Error('Original source listener identity changed');
    const db = new Database(eventsPath, { readonly: true, fileMustExist: true });
    const native = new CodexConversationStore(nativePath, { observation: true });
    try {
      const held = db
        .prepare('SELECT data FROM deployment_operations WHERE id=? AND held=1')
        .get(operationId) as { data: string } | undefined;
      if (!held || !isDeepStrictEqual(JSON.parse(held.data), operation))
        throw Error('Source hold changed during capture');
      plan = Plan.parse({
        version: 1,
        id: randomUUID(),
        authorityId: randomUUID(),
        sourceOperationId: operationId,
        sourceOperationSha256: maintenanceFingerprint(held.data),
        sourceCommit: operation.sourceCommit,
        targetCommit: operation.targetCommit,
        sourcePid: source.pid,
        sourceGroup: source.pgid,
        sourceBirth: source.birth,
        events: file(eventsPath),
        native: file(nativePath),
        helpers: descendants(source.pid, rows),
        owners: active.map((owner) =>
          captureMaintenanceOwner(db, native, owner.sessionId, owner.turnInProgress),
        ),
        expectedCommands: reviewedCommands,
      });
      const observedCommands = readMaintenancePendingCommands(db).map((command) => ({
        commandId: command.client_msg_id,
        sha256: maintenanceFingerprint(command),
      }));
      if (!isDeepStrictEqual(observedCommands, reviewedCommands))
        throw Error('Pending commands differ from the reviewed historical selection');
      const historicalIds = new Set(
        readMaintenancePendingCommands(db).map((command) => command.session_id),
      );
      if (action === 'capture-idle') {
        if (plan.owners.some((owner) => owner.target))
          throw Error('Idle capture cannot contain a running target');
        plan = Plan.parse({
          ...plan,
          idleSnapshotSha256: maintenanceIdleFingerprint(
            db,
            native,
            eventsPath,
            [...historicalIds],
            plan.owners.map((owner) => owner.sessionId),
          ),
        });
      }
      if (
        plan.owners.some((owner) => historicalIds.has(owner.sessionId)) ||
        native
          .runningConversationIds()
          .some((id) => !plan.owners.some((owner) => owner.sessionId === id && owner.target))
      )
        throw Error('Uncaptured current startup or overlapping historical owner');
      if (new Set(plan.owners.map((owner) => owner.sessionId)).size !== plan.owners.length)
        throw Error('Distinct original owners required');
      // Private exclusive publication precedes any shutdown/adoption action.
      publishPrivateOperationFile(statePath, JSON.stringify(plan) + '\n');
      publishPrivateOperationFile(
        statePath + '.resume.json',
        JSON.stringify({
          id: plan.id,
          sourceCommit: plan.sourceCommit,
          targetCommit: plan.targetCommit,
          activationId: plan.authorityId,
          maintenanceKind: 'drained-handoff-v1',
        }) + '\n',
      );
    } finally {
      native.close();
      db.close();
    }
    console.log(
      JSON.stringify({
        captured: true,
        owners: plan.owners.length,
        running: plan.owners.filter((owner) => owner.target).length,
        uncertainCommands: plan.expectedCommands.length,
      }),
    );
    return;
  }
  plan = Plan.parse(JSON.parse(readPrivateOperationFile(statePath, 1024 * 1024).toString('utf8')));
  const seal =
    action === 'adopt'
      ? Seal.parse(
          JSON.parse(
            readPrivateOperationFile(statePath + '.sealed.json', 1024 * 1024).toString('utf8'),
          ),
        )
      : undefined;
  if (seal && seal.planSha256 !== maintenanceFingerprint(plan))
    throw Error('Original sealed capture required');
  if (action === 'adopt') assertSourceExcluded(plan, seal!.helpers);
  const db = new Database(plan.events.path, {
    readonly: action !== 'adopt',
    fileMustExist: true,
  });
  const native = new CodexConversationStore(plan.native.path, { observation: true });
  let events: EventStore | undefined;
  let nativeFence: Database.Database | undefined;
  try {
    const interactive = createInteractiveAuth({
      passphrase: process.env.AUTH_PASSPHRASE!,
      secret: process.env.AUTH_SECRET!,
      maxAgeHours: parseCookieMaxAgeHours(process.env.COOKIE_MAX_AGE_HOURS) ?? 24,
      cookieName: 'cc_auth',
    });
    interactive.setRevocationStore({
      isAuthSessionRevoked: (auth) =>
        !!db
          .prepare('SELECT 1 FROM auth_revocations WHERE auth_session_id=? AND expires_at>?')
          .get(auth.id, Date.now()),
      revokeAuthSession: () => {
        throw Error('Inspection cannot change revocations');
      },
    });
    const auth = await interactive.authenticateToken(token);
    if (!auth || !interactive.isAuthenticatedOperatorSessionId(auth.id))
      throw Error('Current signed primary operator required');
    const authorize = () => {
      if (
        auth.expiresAt <= Date.now() ||
        interactive.isSessionRevoked(auth) ||
        !interactive.isAuthenticatedOperatorSessionId(auth.id)
      )
        throw Error('Maintenance operator expired or revoked');
      return auth;
    };
    const held = db
      .prepare('SELECT data FROM deployment_operations WHERE id=? AND held=1')
      .get(plan.sourceOperationId) as { data: string } | undefined;
    if (!held || maintenanceFingerprint(held.data) !== plan.sourceOperationSha256)
      throw Error('Original source hold changed');
    const original = JSON.parse(held.data);
    if (original.auth?.id !== auth.id || original.auth?.expiresAt !== auth.expiresAt)
      throw Error('Original signed maintenance actor required');
    if (
      !isDeepStrictEqual(
        readMaintenancePendingCommands(db).map((command) => ({
          commandId: command.client_msg_id,
          sha256: maintenanceFingerprint(command),
        })),
        plan.expectedCommands,
      )
    )
      throw Error('Reviewed historical evidence changed');
    const quarantineIds = [
      ...new Set(readMaintenancePendingCommands(db).map((command) => command.session_id)),
    ];
    const assertDrained = (ids: readonly string[]) => {
      authorize();
      if (
        native.hasRunningCommands() ||
        (!plan.idleSnapshotSha256 && native.deploymentRecoveryPending(ids)) ||
        native.subagents.unsettledConversationIds().some((id) => !ids.includes(id))
      )
        throw Error('Current native effects or ownership remain unsettled');
      if (
        db
          .prepare(
            "SELECT session_id FROM sessions WHERE execution_phase IS NOT NULL AND execution_phase!='TERMINAL'",
          )
          .all()
          .some((row) => !ids.includes((row as { session_id: string }).session_id))
      )
        throw Error('Uncaptured execution phase remains active');
      const completions = plan.owners.map((owner) => {
        const completion = assertMaintenanceOwnerDrained(db, native, owner);
        if (events) assertMaintenanceAdmission(events, owner);
        return completion;
      });
      const completionSha256 = maintenanceFingerprint(completions);
      if (
        plan.idleSnapshotSha256 &&
        (plan.owners.some((owner) => owner.target) ||
          maintenanceIdleFingerprint(
            db,
            native,
            plan.events.path,
            ids,
            plan.owners.map((owner) => owner.sessionId),
          ) !== plan.idleSnapshotSha256)
      )
        throw Error('Exact zero-delivery idle snapshot required');
      if (seal && seal.completionSha256 !== completionSha256)
        throw Error('Original sealed completion receipts changed');
      return {
        retainedSessionIds: plan.owners.map((owner) => owner.sessionId),
        ...(plan.idleSnapshotSha256 ? { idleSnapshotSha256: plan.idleSnapshotSha256 } : {}),
        sessions: events
          ? plan.owners
              .filter((owner) => owner.target)
              .map((owner) => drainedMaintenanceSession(events!, native, owner))
          : [],
        proofSha256: maintenanceFingerprint({
          planSha256: maintenanceFingerprint(plan),
          completionSha256,
          helpers: seal?.helpers ?? [],
        }),
      };
    };
    assertDrained(quarantineIds);
    if (action === 'observe' || action === 'seal') {
      if ((await request('/api/loop/status')).state !== 'idle')
        throw Error('Source background loop must be idle');
      const state = await request('/api/deployment');
      if (
        state.active?.id !== plan.sourceOperationId ||
        maintenanceFingerprint(JSON.stringify(state.active)) !== plan.sourceOperationSha256
      )
        throw Error('Live source hold changed');

      const active = (await request('/api/sessions/active')) as Array<{
        sessionId: string;
        turnInProgress: boolean;
        hasSnapshot: boolean;
      }>;
      if (
        active.some(
          (owner) =>
            owner.turnInProgress ||
            owner.hasSnapshot ||
            !plan.owners.some((saved) => saved.sessionId === owner.sessionId),
        )
      )
        throw Error('Source owner capture has changed or is still active');
      if (action === 'seal') {
        const processes = census();
        if (!processes.some((row) => row.pid === plan.sourcePid && row.birth === plan.sourceBirth))
          throw Error('Original source process changed');
        const completions = plan.owners.map((owner) =>
          assertMaintenanceOwnerDrained(db, native, owner),
        );
        publishPrivateOperationFile(
          statePath + '.sealed.json',
          JSON.stringify({
            planSha256: maintenanceFingerprint(plan),
            helpers: descendants(plan.sourcePid, processes),
            completionSha256: maintenanceFingerprint(completions),
          }) + '\n',
        );
      }
      console.log(
        JSON.stringify({
          drained: true,
          sealed: action === 'seal',
          owners: plan.owners.length,
          sourceHoldRetained: true,
        }),
      );
      return;
    }
    const resume = JSON.parse(
      readPrivateOperationFile(statePath + '.resume.json', 16 * 1024).toString('utf8'),
    );
    if (
      !isDeepStrictEqual(resume, {
        id: plan.id,
        sourceCommit: plan.sourceCommit,
        targetCommit: plan.targetCommit,
        activationId: plan.authorityId,
        maintenanceKind: 'drained-handoff-v1',
      })
    )
      throw Error('Original private maintenance capability required');
    execFileSync('/bin/bash', ['scripts/assert-deployable.sh', '--offline'], {
      stdio: 'pipe',
      timeout: 15_000,
    });
    if (getLocalCommit() !== plan.targetCommit)
      throw Error('Exact accepted target release required');
    assertSourceExcluded(plan, seal!.helpers);
    // Native writes are excluded only after every original owner has closed.
    nativeFence = new Database(plan.native.path, { fileMustExist: true });
    nativeFence.exec('BEGIN IMMEDIATE');
    authorize();
    persistMaintenanceRequirement(statePath, plan, seal!);
    events = new EventStore(plan.events.path);
    authorize();
    const operation = events.deployment.maintenance.adopt(
      {
        ...plan,
        expectedRunningSessions: plan.owners
          .filter((owner) => owner.target)
          .map((owner) => ({
            sessionId: owner.sessionId,
            targetSha256: maintenanceFingerprint(owner.target),
          })),
      },
      {
        authorize,
        assertSourceExcluded: () => assertSourceExcluded(plan, seal!.helpers),
        assertDrained,
      },
    );
    console.log(
      JSON.stringify({
        adopted: true,
        id: operation.id,
        kind: operation.maintenance?.kind,
        quarantined: operation.maintenance?.quarantinedSessionIds.length,
        retainedOwners: plan.owners.length,
        phase: operation.phase,
      }),
    );
  } finally {
    events?.close();
    native.close();
    if (nativeFence) {
      nativeFence.exec('ROLLBACK');
      nativeFence.close();
    }
    db.close();
  }
}
