import { describe, expect, it, vi } from 'vitest';
import { SharedAuthorityProof } from '../shared-authority-proof.js';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('SharedAuthorityProof', () => {
  it('shares one in-flight proof between concurrent callers', async () => {
    const shared = new SharedAuthorityProof();
    const gate = deferred();
    const prove = vi.fn(() => gate.promise);
    const callers = Array.from({ length: 12 }, () => shared.run('effect:c1', prove));
    expect(shared.inFlight).toBe(1);
    gate.resolve();
    await Promise.all(callers);
    expect(prove).toHaveBeenCalledTimes(1);
    expect(shared.inFlight).toBe(0);
  });

  it('never reuses a settled success: the next boundary proves again', async () => {
    const shared = new SharedAuthorityProof();
    const prove = vi.fn(async () => {});
    await shared.run('effect:c1', prove);
    await shared.run('effect:c1', prove);
    expect(prove).toHaveBeenCalledTimes(2);
  });

  it('refuses a boundary after a mutable condition changes once the earlier proof settled', async () => {
    const shared = new SharedAuthorityProof();
    let checkoutHead = 'main';
    const prove = async () => {
      if (checkoutHead !== 'main') throw new Error('Workspace checkout changed');
    };
    await shared.run('effect:c1', prove);
    checkoutHead = 'other-branch';
    await expect(shared.run('effect:c1', prove)).rejects.toThrow('Workspace checkout changed');
  });

  it('delivers a failure to every waiter and does not retain it', async () => {
    const shared = new SharedAuthorityProof();
    const gate = deferred();
    const failing = vi.fn(() => gate.promise);
    const waiters = [shared.run('effect:c1', failing), shared.run('effect:c1', failing)];
    gate.reject(new Error('Credential revoked'));
    for (const waiter of waiters) await expect(waiter).rejects.toThrow('Credential revoked');
    expect(failing).toHaveBeenCalledTimes(1);
    const prove = vi.fn(async () => {});
    await shared.run('effect:c1', prove);
    expect(prove).toHaveBeenCalledTimes(1);
  });

  it('lets one cancelled waiter reject promptly while another waiter completes', async () => {
    const shared = new SharedAuthorityProof();
    const gate = deferred();
    const prove = vi.fn(() => gate.promise);
    const cancelled = new AbortController();
    const kept = new AbortController();
    const abandoned = shared.run('api_credentials', prove, cancelled.signal);
    const completed = shared.run('api_credentials', prove, kept.signal);
    cancelled.abort(new Error('Callback cancelled'));
    await expect(abandoned).rejects.toThrow('Callback cancelled');
    expect(shared.inFlight).toBe(1); // the shared proof keeps running for others
    gate.resolve();
    await expect(completed).resolves.toBeUndefined();
    expect(prove).toHaveBeenCalledTimes(1);
  });

  it('does not start a proof for an already cancelled caller', async () => {
    const shared = new SharedAuthorityProof();
    const prove = vi.fn(async () => {});
    const controller = new AbortController();
    controller.abort(new Error('Stopped'));
    await expect(shared.run('effect:c1', prove, controller.signal)).rejects.toThrow('Stopped');
    expect(prove).not.toHaveBeenCalled();
  });

  it('keeps an abandoned shared failure handled', async () => {
    const shared = new SharedAuthorityProof();
    const gate = deferred();
    const controller = new AbortController();
    const waiter = shared.run('effect:c1', () => gate.promise, controller.signal);
    controller.abort(new Error('Callback cancelled'));
    await expect(waiter).rejects.toThrow('Callback cancelled');
    gate.reject(new Error('Workspace unavailable'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(shared.inFlight).toBe(0);
  });

  it('refuses a synchronous throw from the proof without retaining it', async () => {
    const shared = new SharedAuthorityProof();
    await expect(
      shared.run('effect:c1', () => {
        throw new Error('Owner changed');
      }),
    ).rejects.toThrow('Owner changed');
    expect(shared.inFlight).toBe(0);
  });

  it('runs separate proofs for different commands and for effect versus idle authority', async () => {
    const shared = new SharedAuthorityProof();
    const gates = [deferred(), deferred(), deferred()];
    const proofs = gates.map((gate) => vi.fn(() => gate.promise));
    const runs = [
      shared.run('effect:c1', proofs[0]!),
      shared.run('effect:c2', proofs[1]!),
      shared.run('idle:c2', proofs[2]!),
    ];
    expect(shared.inFlight).toBe(3);
    for (const gate of gates) gate.resolve();
    await Promise.all(runs);
    for (const prove of proofs) expect(prove).toHaveBeenCalledTimes(1);
  });
});
