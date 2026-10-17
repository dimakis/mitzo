import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { ConnectionRegistry, getPendingSessionId } from '@mitzo/harness';
import { createTelosSourceApprovalData } from './fixtures/telos-source-approval-data.js';
import { createTelosSourcePermissionRecovery } from '../telos-source-recovery.js';
import {
  configureTelosSourcePermissionRecovery,
  getPendingRequestsBySession,
} from '../permissions.js';
import { handlePermissionResponseV2 } from '../ws-handler-v2.js';
import { NativeCommandRegistry } from '../native-commands.js';
import {
  claimTransportConnection,
  releaseTransportConnection,
} from '../transport-auth-ownership.js';

// Exclude unrelated application/provider bootstrap. Permission dispatch, auth
// ownership, registries and all retained/canonical fixture owners remain real.
vi.mock('../app.js', () => ({
  buildSkillRegistry: vi.fn().mockReturnValue(new Map()),
  isAllowedPath: vi.fn().mockReturnValue(true),
  NATIVE_COMMAND_NAMES: new Set(),
}));
vi.mock('../chat.js', () => ({
  startChat: vi.fn(),
  sendToChat: vi.fn(),
  interruptChat: vi.fn(),
  preflightChatCommand: vi.fn(),
  preflightStartupProviderCommand: vi.fn(),
  nativeStartupSessionId: vi.fn(),
  stopChat: vi.fn(),
  isActive: vi.fn(),
  reattachChat: vi.fn(),
  rekeyChat: vi.fn(),
  importSdkConversation: vi.fn(),
  BASE_REPO: '/tmp/offline-reviewed-save',
}));

const cleanup: Array<() => void> = [];
afterEach(() => {
  configureTelosSourcePermissionRecovery(undefined);
  cleanup
    .splice(0)
    .reverse()
    .forEach((close) => close());
});

it('dismisses authenticated uncertain recovery before restart without replaying or timing out its original live provider request', async () => {
  const f = createTelosSourceApprovalData();
  cleanup.push(() => f.close());
  const permission = await f.request({ kind: 'create', marker: 'native' });
  const permId = String(permission.permId);
  const review = await f.service.review(permId, 'planning', f.actor);
  const message = review.messages[1];
  const input = {
    sessionId: 'planning',
    requestId: randomUUID(),
    proposalSha256: review.proposalSha256,
    selection: {
      mode: 'selected' as const,
      boundary: { sequence: message.sequence, messageId: message.messageId },
      messageIds: [message.messageId],
      artifacts: [],
    },
  };
  const preview = await f.service.preview(permId, input, f.actor);
  f.loseNextSaveResponse();
  await expect(
    f.service.approve(permId, { ...input, previewSha256: preview.preview.sha256 }, f.actor),
  ).rejects.toThrow(/uncertain/);
  configureTelosSourcePermissionRecovery(createTelosSourcePermissionRecovery(() => f.dbPath));
  expect(getPendingSessionId(permId)).toBe('planning');
  expect(getPendingRequestsBySession('planning', f.actor.id)).toMatchObject([
    { permId, recoveryOnly: true },
  ]);
  const retained = () => {
    const db = new Database(f.dbPath, { readonly: true });
    try {
      return {
        approvals: db
          .prepare(
            'SELECT id,data,data_sha256,receipt,canonical_receipt FROM telos_work_source_approvals ORDER BY id',
          )
          .all(),
        items: db.prepare('SELECT * FROM items ORDER BY id').all(),
        sources: db.prepare('SELECT * FROM telos_work_sources ORDER BY seq').all(),
        artifacts: db.prepare('SELECT * FROM telos_artifact_revisions ORDER BY id,revision').all(),
        creations: db
          .prepare('SELECT * FROM telos_work_source_creations ORDER BY request_id')
          .all(),
      };
    } finally {
      db.close();
    }
  };
  const before = retained();
  const connRegistry = new ConnectionRegistry();
  const connectionId = randomUUID();
  const sent: Record<string, unknown>[] = [];
  connRegistry.register(connectionId, { send: (data) => sent.push(data), isOpen: () => true });
  connRegistry.watch(connectionId, 'planning');
  claimTransportConnection(connectionId, f.actor.id);
  cleanup.push(() => releaseTransportConnection(connectionId, f.actor.id));
  const context = {
    connRegistry,
    sessionRegistry: f.registry,
    eventStore: f.events,
    nativeCommands: new NativeCommandRegistry(),
  };
  const response = {
    type: 'permission_response' as const,
    permId,
    sessionId: 'planning',
    decision: 'deny' as const,
  };
  expect(handlePermissionResponseV2(connectionId, response, context, 'another-operator')).toBe(
    false,
  );
  expect(getPendingSessionId(permId)).toBe('planning');
  let settled = false;
  void f.settled().then(() => {
    settled = true;
  });
  expect(handlePermissionResponseV2(connectionId, response, context, f.actor.id)).toBe(true);
  expect.soft(getPendingSessionId(permId)).toBeUndefined();
  expect.soft(getPendingRequestsBySession('planning', f.actor.id)).toEqual([]);
  await vi.waitFor(() => expect(settled).toBe(true), { timeout: 100, interval: 5 }).catch(() => {});
  expect.soft(settled).toBe(true);
  expect.soft(f.drainEvents().filter((event) => event.type === 'permission_timeout')).toEqual([]);
  expect(sent).toContainEqual({ type: 'permission_resolved', permId, sessionId: 'planning' });
  expect(retained()).toEqual(before);
  expect((await f.service.review(permId, 'planning', f.actor)).recovery?.preview).toEqual(
    preview.preview,
  );
  expect(f.counts()).toMatchObject({ canonicalCreates: 1, sources: { total: 1 } });
});
