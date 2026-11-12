import { afterEach, expect, it, vi } from 'vitest';
import { buildPermissionHandler, SessionRegistry } from '@mitzo/harness';
import { NotificationCenter } from '../notification-center.js';
import { NotificationStore } from '../notification-store.js';
import { createCodexNativeApprovalHandler } from '../codex-native-approvals.js';
import {
  getPendingRequestsBySession,
  registerPending,
  removePending,
  resolvePending,
} from '../permissions.js';

const log = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('../logger.js', () => ({ createLogger: () => log }));

afterEach(() => vi.clearAllMocks());

it('retains a failed approval delivery, reports its cause, and continues the batch', async () => {
  vi.useFakeTimers();
  const cause = new Error('Synthetic transport failure');
  const push = vi
    .fn()
    .mockRejectedValueOnce(cause)
    .mockResolvedValue({ status: 'accepted', acceptedDevices: ['private-device-token'] });
  const store = new NotificationStore(':memory:');
  const center = new NotificationCenter(store, {
    push,
    changed() {},
    configured: () => true,
    devices: () => 1,
    sessionTitle: () => 'Private title',
  });
  const ids = ['failed-decision', 'other-decision'];
  try {
    for (const permId of ids)
      registerPending(permId, 'Bash', vi.fn(), {}, 'elevated', 'chat', {
        permId,
        sessionId: 'chat',
        toolName: 'Bash',
        toolInput: 'private-command-value',
        expiresAt: Date.now() + 120_000,
      });
    await expect(center.flush()).resolves.toBeUndefined();
    expect(push).toHaveBeenCalledTimes(2);
    expect(store.attempts('permission:failed-decision')).toBe(1);
    expect(store.deliveredDevices('permission:failed-decision')).toEqual([]);
    expect(store.feed('needs').needsYou).toBe(2);
    expect(log.warn).toHaveBeenCalledWith(
      'Notification transport failed',
      expect.objectContaining({
        stage: 'notification_delivery',
        code: 'notification_transport_failed',
        notificationId: 'permission:failed-decision',
        sessionId: 'chat',
        permId: 'failed-decision',
        channel: 'apns',
        err: cause,
      }),
    );
    expect(JSON.stringify([...log.info.mock.calls, ...log.warn.mock.calls])).not.toMatch(
      /private-command-value|private-device-token|Private title/,
    );
    vi.advanceTimersByTime(60_000);
    await center.flush();
    expect(push).toHaveBeenCalledTimes(3);
    expect(push.mock.lastCall![0].data.notificationId).toBe('permission:failed-decision');
    await center.flush();
    expect(push).toHaveBeenCalledTimes(3);
  } finally {
    ids.forEach((id) => removePending(id));
    center.close();
    store.close();
    vi.useRealTimers();
  }
});

// Claude/Vertex SDK, Responses and controller tools share buildPermissionHandler.
// Local Mac and OpenShell native RPCs first pass through the native adapter.
it.each(['shared-provider', 'native-local', 'native-openshell'] as const)(
  'delivers a new %s approval despite an unread expired alert from earlier in the chat',
  async (route) => {
    const sessionId = 'approval-chat';
    const store = new NotificationStore(':memory:');
    store.record({
      id: 'permission:old',
      permId: 'old',
      kind: 'approval',
      title: 'Earlier decision',
      body: '',
      sessionId,
      expiresAt: Date.now() - 1,
    });
    store.delivery('permission:old', 'accepted', undefined, ['synthetic-device']);
    store.resolvePermission('old', 'expired');
    const push = vi.fn(async () => ({
      status: 'accepted' as const,
      acceptedDevices: ['synthetic-device'],
    }));
    const center = new NotificationCenter(store, {
      push,
      changed() {},
      configured: () => true,
      devices: () => 1,
      sessionTitle: () => 'Approval regression',
    });
    const registry = new SessionRegistry();
    const controller = new AbortController();
    registry.register('client', {
      transport: { send() {}, isOpen: () => true },
      abortController: controller,
      mode: 'agent',
      cwd: '/workspace',
      sessionId,
      sessionAllowList: new Set(),
    });
    const engine = route === 'native-openshell' ? 'openshell' : 'local';
    const pending =
      route === 'shared-provider'
        ? buildPermissionHandler('client', registry)(
            'Bash',
            { command: 'offline-test' },
            { signal: controller.signal, toolUseID: 'new-tool' },
          )
        : createCodexNativeApprovalHandler({
            clientId: 'client',
            registry,
            runtimeId: route,
            environmentId: engine,
            deniedRoots: [],
            writeProtectedRoots: [],
          })(
            'item/commandExecution/requestApproval',
            {
              threadId: 'thread',
              turnId: 'turn',
              itemId: 'item',
              startedAtMs: Date.now(),
              kind: 'command',
              environmentId: engine,
              cwd: '/workspace',
              command: 'offline-test',
            },
            controller.signal,
            {
              requestId: 'new-rpc',
              threadId: 'thread',
              turnId: 'turn',
              commandId: 'command',
              registerResponseFence() {},
              assertCurrentSync() {},
            },
          );
    try {
      await vi.waitFor(() => expect(getPendingRequestsBySession(sessionId)).toHaveLength(1));
      const request = getPendingRequestsBySession(sessionId)[0];
      await center.flush();
      expect(push).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          data: expect.objectContaining({ notificationId: `permission:${request.permId}` }),
        }),
      );
      expect(log.info).toHaveBeenCalledWith(
        'Notification delivery completed',
        expect.objectContaining({
          stage: 'notification_delivery',
          code: 'notification_delivery_accepted',
          notificationId: `permission:${request.permId}`,
          sessionId,
          permId: request.permId,
          channel: 'apns',
          acceptedDeviceCount: 1,
        }),
      );
      expect(store.get('permission:old')).toMatchObject({
        readAt: null,
        resolution: 'expired',
      });
      // Notification delivery must leave the new approval live and undecided.
      expect(getPendingRequestsBySession(sessionId)).toHaveLength(1);
      expect(store.get(`permission:${request.permId}`)).toMatchObject({
        resolvedAt: null,
        resolution: null,
      });
      resolvePending(request.permId, 'once', undefined, sessionId);
      expect(await pending).toMatchObject(
        route === 'shared-provider' ? { behavior: 'allow' } : { decision: 'accept' },
      );
      await center.flush();
      expect(push).toHaveBeenCalledOnce();
    } finally {
      controller.abort();
      await pending;
      registry.dispose();
      center.close();
      store.close();
    }
  },
);
