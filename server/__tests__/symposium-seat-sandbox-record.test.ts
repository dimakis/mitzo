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
    expect(() =>
      store.rollbackUndispatchedSymposiumSeatCreation({ ...reservation, fenceToken: 'wrong' }),
    ).toThrow('recovery');
    store.claimSymposiumSeatLifecycle('session', 'seat', 'owner');
    expect(() =>
      store.rollbackUndispatchedSymposiumSeatCreation({
        ...reservation,
        runtimeId: 'other',
        fenceToken: 'owner',
      }),
    ).toThrow('recovery');
    store.rollbackUndispatchedSymposiumSeatCreation({ ...reservation, fenceToken: 'owner' });
    expect(store.getSymposiumSeatSandbox('session', 'seat', 1)?.creationStarted).toBe(false);
    store.releaseSymposiumSeatLifecycle('session', 'seat', 'owner');
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
it('persists terminal create identity without granting ready admission or allowing rebinding', () => {
  const root = mkdtempSync(join(tmpdir(), 'terminal-create-'));
  roots.push(root);
  const path = join(root, 'events.db');
  let store = new EventStore(path);
  const raw = new Database(path);
  raw
    .prepare(
      `INSERT INTO symposium_membership
    (session_id,seat_id,generation,state,action,config_revision,binding_key,actor,reason,idempotency_key,occurred_at)
    VALUES ('s','seat',1,'active','restore',1,'binding','director','test','membership',1)`,
    )
    .run();

  raw
    .prepare(
      `INSERT INTO symposium_seat_sandboxes
    (session_id,seat_id,generation,runtime_id,workspace,provider_name,provider_id,provider_type,model,state,creation_started)
    VALUES ('s','seat',1,'runtime','workspace','provider','provider-id','codex','luna','reserved',1)`,
    )
    .run();
  raw.close();
  const receipt = {
    sessionId: 's',
    seatId: 'seat',
    generation: 1,
    runtimeId: 'runtime',
    sandboxName: 'sandbox',
    physicalId: 'physical',
  };
  store.recordSymposiumSeatSandboxTerminalCreate(receipt);
  store.close();
  store = new EventStore(path);
  expect(store.getSymposiumSeatSandbox('s', 'seat', 1)).toMatchObject({
    state: 'reserved',
    physicalId: 'physical',
    creationCompleted: true,
  });
  expect(() =>
    store.recordSymposiumSeatSandboxTerminalCreate({ ...receipt, physicalId: 'replacement' }),
  ).toThrow('changed');
  store.close();
});

function terminalFixture() {
  const root = mkdtempSync(join(tmpdir(), 'terminal-receipt-'));
  roots.push(root);
  const path = join(root, 'events.db');
  const store = new EventStore(path);
  const raw = new Database(path);
  raw
    .prepare(
      `INSERT INTO symposium_membership
    (session_id,seat_id,generation,state,action,config_revision,binding_key,actor,reason,idempotency_key,occurred_at)
    VALUES ('s','seat',1,'active','restore',1,'binding','director','test','membership',1)`,
    )
    .run();
  raw
    .prepare(
      `INSERT INTO symposium_seat_sandboxes
    (session_id,seat_id,generation,runtime_id,workspace,provider_name,provider_id,provider_type,model,state,creation_started)
    VALUES ('s','seat',1,'runtime','workspace','provider','provider-id','openai','synthetic-model','reserved',1)`,
    )
    .run();
  return {
    store,
    raw,
    path,
    input: {
      sessionId: 's',
      seatId: 'seat',
      generation: 1,
      runtimeId: 'runtime',
      sandboxName: 'sandbox',
      physicalId: 'original-uuid',
      settlementReceiptV1: {
        physicalProof: 'unavailable' as const,
        leaseTokenSha256: 'b'.repeat(64),
        leaseRequestSha256: 'a'.repeat(64),
        leaseRevision: 'revision-1',
      },
    },
  };
}
it('atomically retains immutable original terminal settlement without granting cleanup authority', () => {
  const f = terminalFixture();
  try {
    f.store.recordSymposiumSeatSandboxTerminalCreate(f.input);
    const receipt = f.store.getSymposiumSeatTerminalCreateReceipt('s', 'seat', 1);
    expect(receipt).toMatchObject({
      version: 1,
      sessionId: 's',
      seatId: 'seat',
      generation: 1,
      runtimeId: 'runtime',
      sandboxName: 'sandbox',
      physicalId: 'original-uuid',
      workspace: 'workspace',
      providerId: 'provider-id',
      physicalProof: 'unavailable',
      custodyProof: 'unavailable',
      leaseProof: {
        tokenSha256: 'b'.repeat(64),
        requestSha256: 'a'.repeat(64),
        revision: 'revision-1',
      },
    });
    f.store.recordSymposiumSeatSandboxTerminalCreate(f.input);
    expect(() =>
      f.store.recordSymposiumSeatSandboxTerminalCreate({ ...f.input, physicalId: 'replacement' }),
    ).toThrow();
    expect(() =>
      f.store.recordSymposiumSeatSandboxTerminalCreate({
        ...f.input,
        settlementReceiptV1: { ...f.input.settlementReceiptV1, leaseRevision: 'replacement' },
      }),
    ).toThrow();
    f.store.close();
    const reopened = new EventStore(f.path);
    try {
      expect(reopened.getSymposiumSeatTerminalCreateReceipt('s', 'seat', 1)).toEqual(receipt);
      expect(reopened.getSymposiumSeatSandbox('s', 'seat', 1)?.state).toBe('reserved');
    } finally {
      reopened.close();
    }
  } finally {
    f.store.close();
    f.raw.close();
  }
});
it('does not backfill legacy completed creates and rolls settlement back on receipt write failure', () => {
  const f = terminalFixture();
  try {
    f.raw
      .prepare(
        `UPDATE symposium_seat_sandboxes SET sandbox_name='sandbox',physical_id='original-uuid',creation_completed=1`,
      )
      .run();
    expect(f.store.getSymposiumSeatTerminalCreateReceipt('s', 'seat', 1)).toBeNull();
    expect(() => f.store.recordSymposiumSeatSandboxTerminalCreate(f.input)).toThrow();
    f.raw
      .prepare(
        `UPDATE symposium_seat_sandboxes SET sandbox_name=NULL,physical_id=NULL,creation_completed=0`,
      )
      .run();
    f.raw.exec(
      `CREATE TRIGGER refuse_terminal_receipt BEFORE UPDATE OF terminal_create_receipt_json ON symposium_seat_sandboxes WHEN NEW.terminal_create_receipt_json IS NOT NULL BEGIN SELECT RAISE(ABORT,'receipt write refused'); END;`,
    );
    expect(() => f.store.recordSymposiumSeatSandboxTerminalCreate(f.input)).toThrow(
      'receipt write refused',
    );
    expect(f.store.getSymposiumSeatSandbox('s', 'seat', 1)).toMatchObject({
      physicalId: null,
      creationCompleted: false,
      state: 'reserved',
    });
    expect(f.store.getSymposiumSeatTerminalCreateReceipt('s', 'seat', 1)).toBeNull();
  } finally {
    f.store.close();
    f.raw.close();
  }
});
it('refuses incomplete lease proof and malformed private receipt', () => {
  const f = terminalFixture();
  try {
    expect(() =>
      f.store.recordSymposiumSeatSandboxTerminalCreate({
        ...f.input,
        settlementReceiptV1: { physicalProof: 'unavailable', leaseRevision: 'revision-1' },
      }),
    ).toThrow();
    expect(f.store.getSymposiumSeatSandbox('s', 'seat', 1)?.creationCompleted).toBe(false);
    f.store.recordSymposiumSeatSandboxTerminalCreate(f.input);
    f.raw
      .prepare(
        `UPDATE symposium_seat_sandboxes SET terminal_create_receipt_json='{"version":1,"physicalProof":"available"}'`,
      )
      .run();
    expect(() => f.store.getSymposiumSeatTerminalCreateReceipt('s', 'seat', 1)).toThrow();
  } finally {
    f.store.close();
    f.raw.close();
  }
});

it('records no-lease settlement truthfully and refuses changed row binding on read', () => {
  const f = terminalFixture();
  try {
    const input = { ...f.input, settlementReceiptV1: undefined };
    f.store.recordSymposiumSeatSandboxTerminalCreate(input);
    expect(f.store.getSymposiumSeatTerminalCreateReceipt('s', 'seat', 1)?.leaseProof).toBeNull();
    f.raw.prepare(`UPDATE symposium_seat_sandboxes SET provider_id='replacement'`).run();
    expect(() => f.store.getSymposiumSeatTerminalCreateReceipt('s', 'seat', 1)).toThrow(
      'binding changed',
    );
  } finally {
    f.store.close();
    f.raw.close();
  }
});
