import { expect, it } from 'vitest';
import { nativeCiFailure } from '../ci-native-failure.mjs';

it('reports only the stage, error class and repository source location', () => {
  const error = Object.assign(new Error('Bearer synthetic-private-payload'), {
    stack:
      'AssertionError: Bearer synthetic-private-payload\n    at /private/runner/mitzo/scripts/qualify-codex-native-permissions.mjs:449:10',
  });
  const result = nativeCiFailure('kernel-permissions', error);
  expect(result.diagnostic).toEqual({
    code: 'ci_native_verification_failed',
    stage: 'kernel-permissions',
    errorClass: 'AssertionError',
    source: 'scripts/qualify-codex-native-permissions.mjs:449:10',
  });
  expect(result.annotation).toContain('::error title=Native CI verification failed::');
  expect(JSON.stringify(result)).not.toMatch(/Bearer|synthetic-private-payload|private\/runner/);
});

it('handles colored serialized failures and refuses annotation injection', () => {
  const result = nativeCiFailure('bad\n::warning::payload', {
    stack:
      '\u001b[31mError: private text\u001b[0m\n at /runner/mitzo/server/ordinary-local-codex-host-runtime.ts:23:27',
  });
  expect(result.diagnostic.stage).toBe('unknown');
  expect(result.diagnostic.source).toBe('server/ordinary-local-codex-host-runtime.ts:23:27');
  expect(result.annotation).not.toMatch(/private text|\n|payload/);
  expect(result.annotation).not.toContain('\u001b');
  expect(nativeCiFailure('native-case', null).diagnostic.source).toBe('unavailable');
});
