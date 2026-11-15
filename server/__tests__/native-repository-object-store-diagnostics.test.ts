import { expect, it } from 'vitest';
import * as store from '../native-repository-object-store.js';
import { codexToolFailureResult, withCodexToolCleanup } from '../codex-tool-failure.js';

const target = { rootPath: '/private/owned', identity: { dev: '1', ino: '2' } };
const secret = 'PRIVATE_SENTINEL /private/credentials request stdout stderr';
function diagnostic(error: unknown) {
  return JSON.parse(
    codexToolFailureResult(error, false, undefined, 'repository_preparation').content,
  );
}
function caught(action: () => unknown) {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw Error('Expected refusal');
}
it.each(['capture', 'verify'] as const)(
  'retains only fixed %s refusal labels, including exit zero',
  (operation) => {
    const parse = (result: { stdout: string; isError?: boolean }) =>
      operation === 'capture'
        ? store.parsePreparationObjectStoreCaptureOutput(result, target)
        : store.parsePreparationObjectStoreVerificationOutput(result);
    for (const isError of [false, true]) {
      const error = caught(() =>
        parse({ stdout: JSON.stringify({ error: 'unavailable', check: 'copy' }), isError }),
      );
      const result = diagnostic(error);
      expect(result.diagnostic).toMatchObject({
        stage: 'repository_preparation',
        reason: 'unknown',
        effectStatus: 'unknown',
        check: `object_store_${operation}_copy`,
      });
      expect(result.failure).toMatchObject({ recovery: 'inspect_operation' });
      expect(result.retry).toBe('after_reconciliation');
    }
  },
);
it.each(['capture', 'verify'] as const)(
  'rejects malformed/mixed/oversized %s replies without reflecting payloads',
  (operation) => {
    const parse = (result: { stdout: string; isError?: boolean }) =>
      operation === 'capture'
        ? store.parsePreparationObjectStoreCaptureOutput(result, target)
        : store.parsePreparationObjectStoreVerificationOutput(result);
    for (const stdout of [
      secret,
      JSON.stringify({ error: 'unavailable', check: secret }),
      JSON.stringify({ error: 'unavailable', check: 'copy', secret }),
      JSON.stringify({ error: 'unavailable', check: 'copy', verified: true }),
      JSON.stringify({ error: 'unavailable', check: 'copy', files: [], digest: 'a'.repeat(64) }),
      ' '.repeat(4 * 1024 * 1024 + 1),
    ]) {
      const value = diagnostic(caught(() => parse({ stdout, isError: false })));
      expect(value.diagnostic.check).toMatch(
        new RegExp(`^object_store_${operation}_(json|schema|transport)$`),
      );
      expect(JSON.stringify(value)).not.toContain(secret);
      expect(value.diagnostic.effectStatus).toBe('unknown');
    }
  },
);
it('retains the primary check and independent cleanup checks without changing cancellation precedence', async () => {
  const primary = caught(() =>
    store.parsePreparationObjectStoreCaptureOutput(
      { stdout: '{"error":"unavailable","check":"inventory"}' },
      target,
    ),
  );
  const cleanup = caught(() =>
    store.parsePreparationObjectStoreVerificationOutput({
      stdout: '{"error":"unavailable","check":"consistency"}',
    }),
  );
  let failure: unknown;
  try {
    await withCodexToolCleanup(async () => {
      throw primary;
    }, [
      () => {
        throw cleanup;
      },
      () => {
        throw new DOMException(secret, 'AbortError');
      },
    ]);
  } catch (error) {
    failure = error;
  }
  const result = diagnostic(failure);
  expect(result.error).toBe('cancelled');
  expect(result.diagnostic.primary.check).toBe('object_store_capture_inventory');
  expect(result.diagnostic.cleanup[0].check).toBe('object_store_verify_consistency');
  expect(result.diagnostic.effectStatus).toBe('unknown');
  expect(JSON.stringify(result)).not.toContain(secret);
});
