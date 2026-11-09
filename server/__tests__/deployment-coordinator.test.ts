import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../event-store.js';
import { DeploymentCoordinator, type DeploymentPort } from '../deployment-coordinator.js';

const closes: Array<() => void> = [];
afterEach(() => {
  for (const close of closes.splice(0).reverse()) close();
});
function fixture(path = ':memory:') {
  const events = new EventStore(path);
  closes.push(() => events.close());
  let authorized = true,
    settled = false,
    healthy = true,
    commit = 'a'.repeat(40);
  let receipt: 'absent' | 'accepted' | 'uncertain' = 'absent';
  const auth = { id: 'signed-operator', expiresAt: Date.now() + 60_000 };
  const port: DeploymentPort = {
    commit: () => commit,
    authorize: () => {
      if (!authorized) throw Error('Revoked');
    },
    capture: () => [
      { sessionId: 'chat', snapshot: { target: 'original', model: 'original-model' } },
    ],
    validate: () => {},
    pause: vi.fn(async () => {}),
    settled: () => settled,
    quiescent: () => settled,
    healthy: () => healthy,
    receipt: () => receipt,
    resume: vi.fn(async () => {
      receipt = 'accepted';
    }),
  };
  const coordinator = new DeploymentCoordinator(events.deployment, port);
  return {
    events,
    coordinator,
    port,
    auth,
    begin: () => coordinator.begin('operation', 'b'.repeat(40), auth),
    settle: () => {
      settled = true;
    },
    revoke: () => {
      authorized = false;
    },
    receipt: (value: typeof receipt) => {
      receipt = value;
    },
    commit: (value: string) => {
      commit = value;
    },
    unhealthy: () => {
      healthy = false;
    },
  };
}
it('holds ingress and native FIFO while cancellation ACK alone remains unsettled', async () => {
  const f = fixture();
  const operation = f.begin();
  expect(() => f.events.deployment.assertAdmission('chat', 'new')).toThrow(/deployment/);
  expect(f.events.deployment.canDispatch('chat')).toBe(false);
  expect(() =>
    f.events.deployment.begin({
      id: 'competitor',
      sourceCommit: 'a'.repeat(40),
      targetCommit: 'c'.repeat(40),
      auth: f.auth,
    }),
  ).toThrow(/Another/);
  expect((await f.coordinator.pause('operation', f.auth)).phase).toBe('pausing');
  expect(f.port.pause).toHaveBeenCalledOnce();
  await f.coordinator.pause('operation', f.auth);
  expect(f.port.pause).toHaveBeenCalledOnce();
  f.settle();
  expect((await f.coordinator.pause('operation', f.auth)).phase).toBe('paused');
  expect(f.events.deployment.get('operation').sessions[0]!.resumeId).toBe(
    operation.sessions[0]!.resumeId,
  );
});
it('resumes the captured session once through the original owner and records acceptance', async () => {
  const f = fixture();
  const original = f.begin();
  f.settle();
  await f.coordinator.pause('operation', f.auth);
  f.coordinator.activate('operation', f.auth, 'activation-secret');
  f.commit('b'.repeat(40));
  f.port.resume = vi.fn(async (entry, auth, _signal, current) => {
    current();
    expect(auth).toEqual(f.auth);
    expect(entry.snapshot.model).toBe('original-model');
    expect(() => f.events.deployment.assertAdmission('chat', entry.resumeId)).not.toThrow();
    expect(() => f.events.deployment.assertAdmission('chat', 'unrelated')).toThrow();
    expect(f.events.deployment.canDispatch('chat')).toBe(true);
    expect(f.events.deployment.canDispatch('uncaptured')).toBe(false);
    f.receipt('accepted');
  });
  const result = await f.coordinator.resume('operation', f.auth, {
    activationId: 'activation-secret',
  });
  expect(result.phase).toBe('completed');
  expect(result.sessions[0]!.state).toBe('resumed');
  expect(result.sessions[0]!.resumeId).toBe(original.sessions[0]!.resumeId);
  expect(f.events.deployment.active()).toBeUndefined();
  expect(f.port.resume).toHaveBeenCalledOnce();
  await expect(f.coordinator.resume('operation', f.auth)).rejects.toThrow(/hold/);
});
it('retains uncertain delivery without retry and later reconciles the accepted receipt', async () => {
  const f = fixture();
  f.begin();
  f.settle();
  await f.coordinator.pause('operation', f.auth);
  f.port.resume = vi.fn(async () => {
    f.receipt('uncertain');
    throw Error('Lost acknowledgement');
  });
  expect((await f.coordinator.resume('operation', f.auth)).sessions[0]!.state).toBe('uncertain');
  await f.coordinator.resume('operation', f.auth);
  expect(f.port.resume).toHaveBeenCalledOnce();
  f.receipt('accepted');
  expect((await f.coordinator.resume('operation', f.auth)).phase).toBe('completed');
});
it('blocks changed custody, expired authority and unexpected or unhealthy releases', async () => {
  const f = fixture();
  f.begin();
  f.settle();
  await f.coordinator.pause('operation', f.auth);
  f.commit('c'.repeat(40));
  await expect(f.coordinator.resume('operation', f.auth)).rejects.toThrow(/healthy release/);
  f.commit('b'.repeat(40));
  f.unhealthy();
  await expect(f.coordinator.resume('operation', f.auth)).rejects.toThrow(/healthy release/);
  f.revoke();
  await expect(f.coordinator.resume('operation', f.auth)).rejects.toThrow(/Revoked/);
  expect(f.port.resume).not.toHaveBeenCalled();
  expect(f.events.deployment.active()).toBeDefined();
});
it('coalesces identical reconciliation while refusing competing actions', async () => {
  const f = fixture();
  f.begin();
  let release!: () => void;
  f.port.pause = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const first = f.coordinator.pause('operation', f.auth);
  expect(f.coordinator.pause('operation', f.auth)).toBe(first);
  await Promise.resolve();
  await expect(f.coordinator.resume('operation', f.auth)).rejects.toThrow(/already running/);
  expect(() => f.coordinator.cancel('operation', f.auth)).toThrow(/settle/);
  release();
  await first;
});
it('keeps a hold and original identities after reopening the same database', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mitzo-deployment-'));
  closes.push(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'events.db');
  const f = fixture(path);
  const original = f.begin();
  f.events.close();
  closes.pop();
  const reopened = new EventStore(path);
  closes.push(() => reopened.close());
  expect(reopened.deployment.active()).toEqual(original);
  expect(() => reopened.deployment.assertAdmission('chat', 'other')).toThrow(/deployment/);
  reopened.deployment.release('operation', 'cancelled');
  expect(reopened.deployment.get('operation').sessions).toEqual(original.sessions);
  expect(reopened.deployment.active()).toBeUndefined();
});
it('records changed custody as blocked without delivering a continuation', async () => {
  const f = fixture();
  f.begin();
  f.settle();
  await f.coordinator.pause('operation', f.auth);
  f.port.validate = () => {
    throw Error('Workspace changed');
  };
  const result = await f.coordinator.resume('operation', f.auth);
  expect(result.sessions[0]!.state).toBe('blocked');
  expect(f.port.resume).not.toHaveBeenCalled();
  expect(f.events.deployment.active()).toBeDefined();
});

it('never treats failed or crash-interrupted capture as an empty paused deployment', async () => {
  const f = fixture();
  f.port.capture = () => {
    throw Error('Unsupported active runtime');
  };
  expect(f.begin).toThrow(/Unsupported/);
  expect(f.events.deployment.active()?.phase).toBe('capturing');
  f.settle();
  await expect(f.coordinator.pause('operation', f.auth)).rejects.toThrow(/not pausing/);
  expect(f.port.pause).not.toHaveBeenCalled();
});

it('claims activation before restart and refuses cancellation or stale source continuation', async () => {
  const f = fixture();
  f.begin();
  f.settle();
  await f.coordinator.pause('operation', f.auth);
  expect(f.coordinator.activate('operation', f.auth, 'activation-secret').phase).toBe('activating');
  expect(() => f.coordinator.cancel('operation', f.auth)).toThrow(/Activation owner/);
  expect(() => f.events.deployment.assertAdmission('new-chat', 'new-command')).toThrow();
  await expect(f.coordinator.resume('operation', f.auth)).rejects.toThrow(/activation owner/);
  await expect(
    f.coordinator.resume('operation', f.auth, { activationId: 'activation-secret' }),
  ).rejects.toThrow(/healthy release/);
  expect(
    (
      await f.coordinator.resume('operation', f.auth, {
        activationId: 'activation-secret',
        rollback: true,
      })
    ).phase,
  ).toBe('completed');
});
