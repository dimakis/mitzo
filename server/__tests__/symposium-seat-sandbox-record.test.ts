import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../event-store.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('durable Symposium seat sandbox identity', () => {
  it('fences lifecycle operations across independent store connections and retains an orphan', () => {
    const root = mkdtempSync(join(tmpdir(), 'mitzo-seat-fence-'));
    roots.push(root);
    const path = join(root, 'events.db');
    const first = new EventStore(path);
    const second = new EventStore(path);
    expect(first.claimSymposiumSeatLifecycle('session', 'seat', 'worker-a')).toBe(true);
    expect(second.claimSymposiumSeatLifecycle('session', 'seat', 'worker-b')).toBe(false);
    first.close();
    const reopened = new EventStore(path);
    expect(reopened.claimSymposiumSeatLifecycle('session', 'seat', 'worker-c')).toBe(false);
    expect(() => second.releaseSymposiumSeatLifecycle('session', 'seat', 'worker-b')).toThrow(
      /fence changed/,
    );
    reopened.releaseSymposiumSeatLifecycle('session', 'seat', 'worker-a');
    expect(second.claimSymposiumSeatLifecycle('session', 'seat', 'worker-b')).toBe(true);
    second.releaseSymposiumSeatLifecycle('session', 'seat', 'worker-b');
    second.close();
    reopened.close();
  });

  it('retains the original runtime and physical ID across reopen and rejects reassignment', () => {
    const root = mkdtempSync(join(tmpdir(), 'mitzo-seat-sandbox-'));
    roots.push(root);
    const path = join(root, 'events.db');
    let store = new EventStore(path);
    const raw = new Database(path);
    raw
      .prepare(
        `INSERT INTO symposium_membership
      (session_id,seat_id,generation,state,action,config_revision,binding_key,actor,reason,idempotency_key,occurred_at)
      VALUES ('session','seat',1,'active','restore',1,'binding','director','test','membership-1',1)`,
      )
      .run();
    raw
      .prepare(
        `INSERT INTO symposium_membership_reconciliation VALUES ('session','seat',1,'confirmed')`,
      )
      .run();
    raw.close();
    const reservation = {
      sessionId: 'session',
      seatId: 'seat',
      generation: 1,
      runtimeId: 'runtime-1',
      workspace: 'workspace',
      providerName: 'vertex',
      providerId: 'provider-1',
      providerType: 'google-vertex-ai',
      model: 'haiku',
    };
    expect(store.reserveSymposiumSeatSandbox(reservation).state).toBe('reserved');
    store.markSymposiumSeatSandboxCreationStarted(reservation);
    store.close();
    store = new EventStore(path);
    expect(store.getSymposiumSeatSandbox('session', 'seat', 1)).toMatchObject({
      creationStarted: true,
      creationCompleted: false,
    });
    expect(() => store.confirmAbsentSymposiumSeatSandboxStopped(reservation)).toThrow(
      /absence identity changed/,
    );
    expect(() => store.reserveSymposiumSeatSandbox(reservation)).toThrow(/reservation changed/);
    store.confirmSymposiumSeatSandbox({
      sessionId: 'session',
      seatId: 'seat',
      generation: 1,
      runtimeId: 'runtime-1',
      sandboxName: 'sandbox-1',
      physicalId: 'physical-1',
    });
    store.close();
    store = new EventStore(path);
    expect(store.getSymposiumSeatSandbox('session', 'seat', 1)).toMatchObject({
      runtimeId: 'runtime-1',
      providerName: 'vertex',
      physicalId: 'physical-1',
      state: 'ready',
    });
    expect(() =>
      store.reserveSymposiumSeatSandbox({ ...reservation, runtimeId: 'runtime-2' }),
    ).toThrow(/reservation changed/);
    expect(() =>
      store.confirmSymposiumSeatSandbox({
        sessionId: 'session',
        seatId: 'seat',
        generation: 1,
        runtimeId: 'runtime-1',
        sandboxName: 'sandbox-1',
        physicalId: 'physical-2',
      }),
    ).toThrow(/physical identity changed/);
    expect(() =>
      store.confirmSymposiumSeatSandboxStopped({
        sessionId: 'session',
        seatId: 'seat',
        generation: 1,
        runtimeId: 'runtime-1',
        physicalId: 'physical-1',
      }),
    ).toThrow(/stop identity changed/);
    store.markSymposiumSeatSandboxCreationCompleted({
      sessionId: 'session',
      seatId: 'seat',
      generation: 1,
      runtimeId: 'runtime-1',
      physicalId: 'physical-1',
    });
    store.confirmSymposiumSeatSandboxStopped({
      sessionId: 'session',
      seatId: 'seat',
      generation: 1,
      runtimeId: 'runtime-1',
      physicalId: 'physical-1',
    });
    expect(store.listUnstoppedSymposiumSeatSandboxes('session', 'seat')).toEqual([]);
    store.close();
  });
});
