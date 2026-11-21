import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  lstatSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexConversationStore } from '../codex-conversation-store.js';
import { SessionPromptStore } from '../session-prompt-store.js';
import { getLocalCommit } from '../git-version.js';
import { MaintenancePlan, MaintenanceSeal } from '../deployment-maintenance-format.js';
import { maintenanceFingerprint } from '@mitzo/protocol/event-store';
import { maintenanceIdleFingerprint } from '../deployment-maintenance-idle.js';
import { publishPrivateOperationFile } from '../private-operation-file.js';
import {
  migrateCompletedMaintenanceIdentity,
  persistMaintenanceRequirement,
  validateMaintenanceBootstrap,
} from '../deployment-maintenance-bootstrap.js';
import { afterEach, expect, it, vi } from 'vitest';
import { EventStore } from '../event-store.js';
import { createDeploymentRuntime } from '../deployment-runtime.js';
const f = vi.hoisted(() => ({
  cold: false,
  primary: true,
  native: undefined as unknown,
  deliveries: 0,
  remountedDatabases: new Set<string>(),
}));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    lstatSync(path: string, options?: { bigint?: boolean }) {
      const stat = fs.lstatSync(path, options);
      if (f.remountedDatabases.has(path))
        stat.dev = typeof stat.dev === 'bigint' ? stat.dev + 1n : stat.dev + 1;
      return stat;
    },
  };
});
vi.mock('../auth.js', () => ({
  hasPersistentRevocationAuthority: () => true,
  isAuthSessionCurrent: () => true,
  isAuthenticatedOperatorSessionId: () => f.primary,
}));
vi.mock('../codex-chat-session.js', () => ({
  getCodexRuntime: () => undefined,
  getCodexConversationStore: () =>
    f.native ?? {
      hasRunningCommands: () => false,
      runningConversationIds: () => [],
      deploymentRecoveryPending: () => f.cold,
      subagents: { unsettledConversationIds: () => [] },
    },
}));
vi.mock('../session-prompt-dispatch.js', () => ({
  createSessionPromptPort: () => ({
    close() {},
    deliverOrdinary() {
      f.deliveries++;
      throw Error('Idle handoff attempted delivery');
    },
  }),
}));
vi.mock('../ordinary-contributor-execution.js', () => ({
  assertOrdinaryContributorControlAllowed() {},
}));
const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((close) => close());
  f.cold = false;
  f.primary = true;
  f.native = undefined;
  f.deliveries = 0;
  f.remountedDatabases.clear();
});
function fixture() {
  const events = new EventStore(':memory:');
  cleanups.push(() => events.close());
  const registry = { getActiveSessions: () => [] };
  const runtime = createDeploymentRuntime(
    { eventStore: events, sessionRegistry: registry } as unknown as Parameters<
      typeof createDeploymentRuntime
    >[0],
    {
      commit: () => 'a'.repeat(40),
      healthy: () => true,
      backgroundIdle: () => true,
      authorizeSession() {},
    },
  );
  cleanups.push(runtime.close);
  const auth = { id: 'signed-operator', expiresAt: Date.now() + 60_000 };
  return { events, coordinator: runtime.coordinator, auth };
}
it('blocks a delayed pre-registry bootstrap and its durable uncertain admission', async () => {
  const f = fixture();
  const release = f.events.reserveOrdinaryStartup(['bootstrapping']);
  expect(f.events.deploymentStartupPending()).toBe(true);
  expect(() => f.coordinator.begin('deployment', 'b'.repeat(40), f.auth)).toThrow(/startup/);
  release();
  expect(f.events.deploymentStartupPending()).toBe(false);
  expect(f.coordinator.begin('deployment', 'b'.repeat(40), f.auth).phase).toBe('pausing');
  expect((await f.coordinator.pause('deployment', f.auth)).phase).toBe('paused');
});
it('blocks cold parent effects even with empty registry and no running commands', () => {
  const runtime = fixture();
  f.cold = true;
  expect(() => runtime.coordinator.begin('deployment', 'b'.repeat(40), runtime.auth)).toThrow(
    /Retained parent/,
  );
  expect(runtime.events.deployment.active()?.phase).toBe('capturing');
});

it('requires primary interactive operator authority for the global deployment hold', () => {
  const runtime = fixture();
  f.primary = false;
  expect(() => runtime.coordinator.begin('deployment', 'b'.repeat(40), runtime.auth)).toThrow(
    /signed deployment operator/,
  );
  expect(runtime.events.deployment.active()).toBeUndefined();
});

it('completes only an exact zero-delivery idle handoff while legacy native recovery stays blocked', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'idle-handoff-')));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace'),
    privateRoot = join(root, 'native');
  mkdirSync(join(workspace, '.mitzo'), { recursive: true });
  mkdirSync(join(privateRoot, 'deployment'), { recursive: true, mode: 0o700 });
  vi.stubEnv('REPO_PATH', workspace);
  vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', privateRoot);
  vi.stubEnv('MITZO_MAINTENANCE_PLAN_FILE', undefined);
  cleanups.push(() => vi.unstubAllEnvs());
  const eventsPath = join(workspace, '.mitzo/events.db'),
    nativePath = join(privateRoot, 'conversations.db');
  const events = new EventStore(eventsPath),
    native = new CodexConversationStore(nativePath);
  const prompts = new SessionPromptStore(eventsPath);
  cleanups.push(() => {
    prompts.close();
    native.close();
    events.close();
  });
  f.native = native;
  const db = new Database(eventsPath),
    ledger = new Database(nativePath);
  const journals = [
    ['capabilities.db', 'capability_operations', 'status', 'running'],
    ['openai-key-operations.db', 'openai_key_operations', 'phase', 'keychain_written'],
  ];
  for (const [filename, table, column] of journals) {
    const journal = new Database(join(workspace, '.mitzo', filename));
    journal.exec(`CREATE TABLE ${table} (${column} TEXT NOT NULL)`);
    journal.close();
  }
  cleanups.push(() => {
    ledger.close();
    db.close();
  });
  const account = {
    accountId: 'fixture',
    accountLabel: 'Offline',
    provider: 'openai' as const,
    model: 'fixture',
    profileRevision: 'fixture',
  };
  native.create('legacy', account, workspace);
  native.enqueue('legacy', account, { id: 'old', prompt: 'Original unknown request' });
  ledger.prepare("UPDATE codex_commands SET status='completed' WHERE id='old'").run();
  ledger
    .prepare(
      "INSERT INTO codex_tools(conversation_id,command_id,call_id,tool_name,result_content,result_is_error,result_effect_outcome) VALUES('legacy','old','old-call','TaskExecution','unknown result',0,'unknown')",
    )
    .run();
  native.enqueue('legacy', account, { id: 'saved', prompt: 'Retain this saved input' });
  ledger
    .prepare(
      "INSERT INTO codex_pending_thread_dispatches(conversation_id,parent_thread_id,thread_id,command_id,attempt,parent_generation) VALUES('legacy','parent','unproved-child','old',1,0)",
    )
    .run();
  const pendingOwner = ledger
    .prepare("SELECT * FROM codex_pending_thread_dispatches WHERE conversation_id='legacy'")
    .get();
  expect(native.deploymentRecoveryPending()).toBe(true);
  events.upsertSession({ sessionId: 'quarantined', initialPrompt: 'Original historical input' });
  events.setSessionState('quarantined', 'ENDED', { force: true });
  db.prepare(
    "INSERT INTO send_commands(client_msg_id,session_id,payload,ordinary_admission) VALUES('uncertain','quarantined','original','{\"state\":\"uncertain\"}')",
  ).run();
  const commit = getLocalCommit()!;
  const auth = { id: 'signed-operator', expiresAt: Date.now() + 60000 };
  const source = events.deployment.begin({
    id: randomUUID(),
    sourceCommit: '279e6703dedebaeb130993fd6e2657b2aed73c0a',
    targetCommit: commit,
    auth,
  });
  const selected = (path: string) => {
    const stat = lstatSync(path);
    return { path, identity: { dev: stat.dev, ino: stat.ino } };
  };
  const plan = MaintenancePlan.parse({
    version: 1,
    id: randomUUID(),
    authorityId: randomUUID(),
    sourceOperationId: source.id,
    sourceOperationSha256: maintenanceFingerprint(JSON.stringify(source)),
    sourceCommit: source.sourceCommit,
    targetCommit: commit,
    sourcePid: process.pid,
    sourceGroup: process.pid,
    sourceBirth: 'offline-fixture',
    events: selected(eventsPath),
    native: selected(nativePath),
    helpers: [],
    owners: [],
    expectedCommands: [
      {
        commandId: 'uncertain',
        sha256: maintenanceFingerprint(
          db.prepare("SELECT * FROM send_commands WHERE client_msg_id='uncertain'").get(),
        ),
      },
    ],
    idleSnapshotSha256: maintenanceIdleFingerprint(db, native, eventsPath, ['quarantined'], []),
  });
  const seal = MaintenanceSeal.parse({
    planSha256: maintenanceFingerprint(plan),
    completionSha256: maintenanceFingerprint([]),
    helpers: [],
  });
  const proofSha256 = maintenanceFingerprint({
    planSha256: seal.planSha256,
    completionSha256: seal.completionSha256,
    helpers: seal.helpers,
  });
  const planFile = join(privateRoot, 'deployment/candidate.json');
  publishPrivateOperationFile(planFile, JSON.stringify(plan));
  publishPrivateOperationFile(planFile + '.sealed.json', JSON.stringify(seal));
  persistMaintenanceRequirement(planFile, plan, seal);
  events.deployment.maintenance.adopt(
    { ...plan, expectedRunningSessions: [] },
    {
      authorize: () => auth,
      assertSourceExcluded: () => {}, // OS source exclusion has its own qualified boundary.
      assertDrained: () => ({
        retainedSessionIds: [],
        proofSha256,
        idleSnapshotSha256: plan.idleSnapshotSha256,
        sessions: [],
      }),
    },
  );
  const uuid = '2ef7f6fe-81ae-433a-9fad-64ebfb68481d';
  const otherUuid = '4aa3f190-f86c-48ed-b10d-45d8dd169ba4';
  const volumes = (): [string, string] => [uuid, uuid];
  const migrate = () => migrateCompletedMaintenanceIdentity(seal.planSha256, volumes(), volumes);
  const identityFile = planFile + '.database-identity.json';
  expect(migrate).toThrow(/completed handoff/);
  const runtime = createDeploymentRuntime(
    { eventStore: events, sessionRegistry: { getActiveSessions: () => [] } } as never,
    {
      commit: () => commit,
      healthy: () => true,
      backgroundIdle: () => true,
      authorizeSession() {},
    },
  );
  cleanups.push(runtime.close);
  const resume = () =>
    runtime.coordinator.resume(plan.id, auth, { activationId: plan.authorityId });
  for (const [filename, table, , pending] of journals) {
    const journal = new Database(join(workspace, '.mitzo', filename));
    try {
      journal.prepare(`INSERT INTO ${table} VALUES(?)`).run(pending);
      await expect(resume()).rejects.toThrow(/Background recovery/);
      journal.exec(`DELETE FROM ${table}`); // Remove only this synthetic negative fixture.
    } finally {
      journal.close();
    }
  }
  db.prepare(
    'INSERT INTO session_prompt_deliveries(id,data) VALUES(\'new-prompt\',\'{"state":"pending"}\')',
  ).run();
  await expect(resume()).rejects.toThrow(/pending prompt/);
  db.prepare("DELETE FROM session_prompt_deliveries WHERE id='new-prompt'").run();
  ledger.prepare("UPDATE codex_tools SET result_content='changed' WHERE call_id='old-call'").run();
  await expect(resume()).rejects.toThrow(/snapshot/);
  ledger
    .prepare("UPDATE codex_tools SET result_content='unknown result' WHERE call_id='old-call'")
    .run();
  const saved = native.commands('legacy', account);
  native.recoverAtStartup(); // Real startup recovery changes metadata, never dispatches.
  expect(native.commands('legacy', account)).toEqual(saved);
  expect(
    ledger
      .prepare("SELECT * FROM codex_pending_thread_dispatches WHERE conversation_id='legacy'")
      .get(),
  ).toEqual(pendingOwner);
  expect((await resume()).phase).toBe('completed');
  expect(f.deliveries).toBe(0);
  expect(native.deploymentRecoveryPending()).toBe(true);
  expect(native.commands('legacy', account)).toEqual(saved);
  expect(events.deployment.canDispatch('quarantined')).toBe(false);

  f.remountedDatabases = new Set([eventsPath, nativePath]);
  expect(() => validateMaintenanceBootstrap(volumes)).toThrow(
    /retain original maintenance identity/,
  );
  expect(() =>
    migrateCompletedMaintenanceIdentity(seal.planSha256, [otherUuid, uuid], volumes),
  ).toThrow(/operator’s reviewed volume/);
  expect(migrate).not.toThrow();
  const identity = readFileSync(identityFile);
  expect(migrate).not.toThrow();
  expect(readFileSync(identityFile)).toEqual(identity);
  expect(readFileSync(planFile, 'utf8')).toBe(JSON.stringify(plan));
  expect(readFileSync(planFile + '.sealed.json', 'utf8')).toBe(JSON.stringify(seal));
  expect(validateMaintenanceBootstrap(volumes)).toEqual(plan);
  expect(() => validateMaintenanceBootstrap(() => [uuid, otherUuid])).toThrow(
    /persistent maintenance identity/,
  );

  // Even if macOS later reuses the original dev number, losing the bound
  // record must fail closed. The original requirement bytes remain retained.
  const marker = join(privateRoot, 'deployment/required-handoff.json');
  expect(JSON.parse(readFileSync(marker + '.v1', 'utf8')).version).toBe(1);
  f.remountedDatabases.clear();
  renameSync(identityFile, identityFile + '.absent');
  try {
    expect(() => validateMaintenanceBootstrap(volumes)).toThrow(/ENOENT/);
  } finally {
    renameSync(identityFile + '.absent', identityFile);
  }
  f.remountedDatabases = new Set([eventsPath, nativePath]);

  const savedNative = nativePath + '.original';
  renameSync(nativePath, savedNative);
  try {
    writeFileSync(nativePath, '');
    expect(() => validateMaintenanceBootstrap(volumes)).toThrow(
      /retain original maintenance identity/,
    );
  } finally {
    renameSync(savedNative, nativePath);
  }

  // An in-place restore of pre-adoption data keeps the same filesystem identity.
  // The original adoption/quarantine checks must still refuse it.
  db.prepare('DELETE FROM deployment_operations WHERE id=?').run(plan.id);
  expect(() => validateMaintenanceBootstrap(volumes)).toThrow(/Reviewed maintenance adoption/);
});
