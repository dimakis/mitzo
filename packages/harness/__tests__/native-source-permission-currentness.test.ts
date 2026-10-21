import { afterEach, expect, it, vi } from 'vitest';
import { SessionRegistry } from '../src/session-registry.js';
import { buildPermissionHandler } from '../src/permission-handler.js';
import {
  capturePendingTelosSourceReviewCurrent,
  getPendingTelosSourceReview,
  registerPending,
  resolvePending,
  resolveReviewedTelosSourcePermission,
} from '../src/permissions.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close();
});

async function fixture(assertion?: () => unknown, legacy = false) {
  const registry = new SessionRegistry();
  const abort = new AbortController();
  const sent: Record<string, unknown>[] = [];
  registry.register('native-client', {
    sessionId: 'native-source',
    mode: 'agent',
    sessionAllowList: new Set(),
    abortController: new AbortController(),
    transport: {
      isOpen: () => true,
      send: (event) => {
        sent.push(event);
      },
    },
  });
  cleanups.push(() => registry.dispose());
  cleanups.push(() => abort.abort());
  let current = true;
  const result = buildPermissionHandler('native-client', registry)(
    'TelosAdoptSource',
    { itemId: 'original-item' },
    {
      signal: abort.signal,
      toolUseID: 'native:original-claimed-call',
      ...(legacy
        ? {}
        : {
            nativeSourceScope: {
              operatorId: 'original-operator',
              assertCurrentSync() {
                if (!current) throw Error('Original component native scope retired');
                return assertion?.();
              },
            },
          }),
    },
  );
  return {
    registry,
    sent,
    result,
    abort,
    retire: () => {
      current = false;
    },
  };
}
async function proofFor(f: Awaited<ReturnType<typeof fixture>>) {
  await vi.waitFor(() =>
    expect(f.sent.some((event) => event.type === 'permission_request')).toBe(true),
  );
  const card = f.sent.find((event) => event.type === 'permission_request')!;
  return getPendingTelosSourceReview(card.permId as string, 'native-source')!;
}

it('binds private renewal to the original native permission while public proof and one-use receipt stay unchanged', async () => {
  const f = await fixture();
  const proof = await proofFor(f);
  const assertCurrent = capturePendingTelosSourceReviewCurrent(proof, 'original-operator')!;
  expect(assertCurrent()).toBeUndefined();
  expect(Object.isFrozen(assertCurrent)).toBe(true);
  expect(assertCurrent.requiresLiveNativeCall).toBe(true);
  expect(JSON.stringify(proof)).not.toMatch(/operatorId|assertCurrent|nativeSourceScope/);
  expect(resolvePending(proof.permId, 'once', undefined, proof.sessionId)).toBe(false);
  expect(resolveReviewedTelosSourcePermission(proof, 'original-retained-receipt')).toBe(true);
  expect(await f.result).toMatchObject({
    behavior: 'allow',
    updatedInput: { itemId: 'original-item', __mitzoTelosApproval: 'original-retained-receipt' },
  });
  expect(() => assertCurrent()).toThrow('no longer current');
});

it('refuses a different signed operator and expires the captured fence when the original native scope retires', async () => {
  const f = await fixture();
  const proof = await proofFor(f);
  expect(capturePendingTelosSourceReviewCurrent(proof, 'different-operator')).toBeUndefined();
  const current = capturePendingTelosSourceReviewCurrent(proof, 'original-operator')!;
  f.retire();
  expect(() => current()).toThrow();
  expect(getPendingTelosSourceReview(proof.permId, proof.sessionId)).toBeUndefined();
  expect(resolveReviewedTelosSourcePermission(proof, 'not-authority')).toBe(false);
  // Retirement never blocks denial or requires another source operation.
  expect(resolvePending(proof.permId, 'deny', undefined, proof.sessionId)).toBe(true);
  expect((await f.result).behavior).toBe('deny');
});

it('does not inherit a successor pending entry even when every public proof byte is identical', async () => {
  const f = await fixture();
  const proof = await proofFor(f);
  const current = capturePendingTelosSourceReviewCurrent(proof, 'original-operator')!;
  resolvePending(proof.permId, 'deny', undefined, proof.sessionId);
  await f.result;
  registerPending(
    proof.permId,
    proof.toolName,
    () => {},
    proof.toolInput,
    undefined,
    proof.sessionId,
    {
      permId: proof.permId,
      toolName: proof.toolName,
      toolInput: '{}',
      reviewKind: 'telos_source',
      sessionId: proof.sessionId,
      expiresAt: proof.expiresAt,
    },
    { toolUseId: proof.toolUseId, operatorId: 'original-operator', canApprove: () => true },
  );
  cleanups.push(() => {
    resolvePending(proof.permId, 'deny');
  });
  expect(getPendingTelosSourceReview(proof.permId, proof.sessionId)).toEqual(proof);
  expect(() => current()).toThrow();
});

it('retains a private proof snapshot and refuses substituted capture fields', async () => {
  const f = await fixture();
  const proof = await proofFor(f);
  const current = capturePendingTelosSourceReviewCurrent(proof, 'original-operator')!;
  proof.toolInput.itemId = 'substituted-item';
  expect(capturePendingTelosSourceReviewCurrent(proof, 'original-operator')).toBeUndefined();
  expect(current()).toBeUndefined();
  f.abort.abort();
  await f.result;
  expect(() => current()).toThrow();
});

it.each(['resolved-async', 'rejected-async', 'nonvoid'] as const)(
  'denies %s native assertions before creating a permission entry and drains rejection',
  async (kind) => {
    const f = await fixture(() =>
      kind === 'nonvoid'
        ? true
        : kind === 'rejected-async'
          ? Promise.reject(Error('Synthetic invalid assertion'))
          : Promise.resolve(),
    );
    expect((await f.result).behavior).toBe('deny');
    await Promise.resolve();
    expect(f.sent).toHaveLength(0);
  },
);

it('preserves the existing legitimate non-native source permission and its pending policy renewal', async () => {
  const f = await fixture(undefined, true);
  const proof = await proofFor(f);
  const current = capturePendingTelosSourceReviewCurrent(proof, 'current-interactive-operator')!;
  expect(current()).toBeUndefined();
  expect(current.requiresLiveNativeCall).toBe(false);
  resolvePending(proof.permId, 'deny', undefined, proof.sessionId);
  await f.result;
  expect(() => current()).toThrow();
});
