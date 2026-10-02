import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import {
  subscriptionIdentityFrame,
  subscriptionIdentityRequired,
  assertSubscriptionRoutingIdentity,
  createSubscriptionIdentityClient,
} from '../symposium-subscription-identity.js';
import {
  REVIEWED_SYMPOSIUM_CODEX_01591_RUNTIME,
  REVIEWED_SYMPOSIUM_CODEX_01591_IDENTITY_RUNTIME,
} from '../symposium-owned-runtime-contract.js';

const claim = 'a'.repeat(64);
function capability() {
  let current = true;
  return {
    accountId: 'synthetic-actual-account',
    assertCurrent() {
      if (!current) throw new Error('Receipt changed');
    },
    invalidate() {
      current = false;
    },
  };
}
function processFixture(writeError = false, holdWrite = false, onRpc?: (method: string) => void) {
  const process = new EventEmitter() as ChildProcessWithoutNullStreams;
  process.stdout = new PassThrough() as never;
  process.stderr = new PassThrough() as never;
  process.kill = vi.fn(() => true);
  const frames: string[] = [];
  let release!: () => void;
  process.stdin = new Writable({
    write(chunk, _encoding, done) {
      expect(process.stdout.listenerCount('data')).toBeGreaterThan(0);
      expect(process.stdin.listenerCount('error')).toBeGreaterThan(0);
      frames.push(chunk.toString());
      const frame = JSON.parse(chunk.toString());
      if (frame.version === 1) {
        release = () => done(writeError ? new Error('synthetic sensitive error') : undefined);
        if (!holdWrite) release();
      } else {
        onRpc?.(frame.method);
        if (frame.method === 'initialize')
          queueMicrotask(() =>
            (process.stdout as PassThrough).write(
              JSON.stringify({ id: frame.id, result: {} }) + '\n',
            ),
          );
        done();
      }
    },
  });
  return { process, frames, release: () => release() };
}

describe('receipt-bound subscription identity (synthetic only)', () => {
  it('requires the preface only for the separately measured identity successor', () => {
    expect(
      subscriptionIdentityRequired(REVIEWED_SYMPOSIUM_CODEX_01591_IDENTITY_RUNTIME.build.image),
    ).toBe(true);
  });
  it('gates unknown and legacy images without changing their transport', () => {
    expect(subscriptionIdentityRequired(REVIEWED_SYMPOSIUM_CODEX_01591_RUNTIME.build.image)).toBe(
      false,
    );
    expect(() => subscriptionIdentityRequired('sha256:' + 'a'.repeat(64))).toThrow('not reviewed');
  });
  it('bounds and validates the exact private frame without reflecting identity in errors', () => {
    const identity = capability();
    const frame = subscriptionIdentityFrame(identity, claim);
    expect(frame.toString()).toBe(
      JSON.stringify({ version: 1, claim, accountId: identity.accountId }) + '\n',
    );
    expect(frame.length).toBeLessThanOrEqual(512);
    for (const accountId of ['', 'bad\nID', 'é', 'a'.repeat(129)]) {
      try {
        subscriptionIdentityFrame({ ...identity, accountId }, claim);
        throw new Error('accepted');
      } catch (error) {
        expect(String(error)).toBe('Error: Subscription launch identity is unavailable');
      }
    }
    identity.invalidate();
    expect(() => subscriptionIdentityFrame(identity, claim)).toThrow('Receipt changed');
  });
  it.each([
    undefined,
    null,
    {},
    { workspaceRouting: null },
    { workspaceRouting: { chatgptAccountId: 'different' } },
  ])('rejects missing or mismatched native routing (%j)', (result) => {
    expect(() => assertSubscriptionRoutingIdentity(result, capability())).toThrow('differs');
  });
  it('accepts only the current receipt routing identity', () => {
    const identity = capability();
    const result = { workspaceRouting: { chatgptAccountId: identity.accountId } };
    expect(() => assertSubscriptionRoutingIdentity(result, identity)).not.toThrow();
    identity.invalidate();
    expect(() => assertSubscriptionRoutingIdentity(result, identity)).toThrow('Receipt changed');
  });
  it('installs readers before writing and blocks RPC until the preface write succeeds', async () => {
    const f = processFixture(false, true);
    const stop = vi.fn(async () => {});
    const client = createSubscriptionIdentityClient(f.process, capability(), claim, stop);
    const initialized = client.initialize();
    await Promise.resolve();
    expect(f.frames).toHaveLength(1);
    expect(JSON.parse(f.frames[0])).toEqual({
      version: 1,
      claim,
      accountId: 'synthetic-actual-account',
    });
    f.release();
    await initialized;
    expect(f.frames.map((frame) => JSON.parse(frame).method)).toEqual([
      undefined,
      'initialize',
      'initialized',
    ]);
    expect(stop).not.toHaveBeenCalled();
    client.close();
  });
  it('stops the exact controlled attempt once on a write error without sending RPC', async () => {
    const f = processFixture(true);
    const stop = vi.fn(async () => {});
    const client = createSubscriptionIdentityClient(f.process, capability(), claim, stop);
    await expect(client.initialize()).rejects.toMatchObject({
      name: 'CodexTransportError',
      category: 'connection',
    });
    expect(stop).toHaveBeenCalledOnce();
    expect(f.process.kill).toHaveBeenCalledOnce();
    expect(f.frames).toHaveLength(1);
  });
  it('keeps an abort during initialize generic even when closing RPC reports connection loss', async () => {
    const controller = new AbortController();
    const f = processFixture(false, false, (method) => {
      if (method === 'initialize') controller.abort(new Error('PRIVATE abort reason'));
    });
    const stop = vi.fn<() => Promise<void>>(async () => {});
    const client = createSubscriptionIdentityClient(f.process, capability(), claim, stop, {
      signal: controller.signal,
    });
    await expect(client.initialize()).rejects.toThrow(
      'Subscription identity initialization failed',
    );
    expect(stop).toHaveBeenCalledOnce();
    expect(f.frames.map((frame) => JSON.parse(frame).method)).toEqual([undefined, 'initialize']);
  });
  it('preserves cleanup uncertainty after a failed preface', async () => {
    const f = processFixture(true);
    const stop = vi.fn(async () => {
      throw new Error('uncertain');
    });
    const client = createSubscriptionIdentityClient(f.process, capability(), claim, stop);
    await expect(client.initialize()).rejects.toThrow('cleanup is unconfirmed');
    expect(stop).toHaveBeenCalledOnce();
  });
  it('rejects a receipt replaced while its preface write is pending and cleans up', async () => {
    const f = processFixture(false, true);
    const identity = capability();
    const stop = vi.fn(async () => {});
    const client = createSubscriptionIdentityClient(f.process, identity, claim, stop);
    identity.invalidate();
    f.release();
    await expect(client.initialize()).rejects.toThrow('initialization failed');
    expect(stop).toHaveBeenCalledOnce();
    expect(f.frames).toHaveLength(1);
  });
  it.each(['invalidated', 'invalid-account', 'invalid-claim', 'aborted'] as const)(
    'sanitizes synchronous setup failure after spawning: %s',
    async (failure) => {
      const f = processFixture();
      const identity = capability();
      const stop = vi.fn(async () => {});
      const controller = new AbortController();
      if (failure === 'invalidated') identity.invalidate();
      if (failure === 'invalid-account') identity.accountId = 'PRIVATE invalid account';
      if (failure === 'aborted') controller.abort(new Error('PRIVATE abort token'));
      expect(() =>
        createSubscriptionIdentityClient(
          f.process,
          identity,
          failure === 'invalid-claim' ? 'PRIVATE claim' : claim,
          stop,
          { signal: controller.signal },
        ),
      ).toThrow('Subscription identity transport failed');
      expect(f.frames).toHaveLength(0);
      await Promise.resolve();
      expect(stop).toHaveBeenCalledOnce();
      expect(f.process.kill).toHaveBeenCalledOnce();
    },
  );
});
