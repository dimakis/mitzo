import { expect, it } from 'vitest';
import {
  assertQualifiedNativeMacExecutionArtifact,
  NATIVE_MAC_ARTIFACT_UNAVAILABLE,
} from '../codex-native-artifact-qualification.js';

it('enables only the exact official Mac artifact exercised by the pinned kernel fixtures', () => {
  expect(() =>
    assertQualifiedNativeMacExecutionArtifact(
      'fc8d77cf7585aded2b9bc487dad29c4ee2f066123e4e76dd3b17653a8322ce42',
    ),
  ).not.toThrow();
});
it.each([
  '',
  '0.171.0',
  '112fae7a5a1223e673c8a1791d32338f37df8b527ff1159bb8adac6c4dbf1b4b',
  '0'.repeat(64),
  'fc8d77cf7585aded2b9bc487dad29c4ee2f066123e4e76dd3b17653a8322ce43',
])('rejects unqualified artifacts without downgrading the route: %s', (digest) => {
  expect(() => assertQualifiedNativeMacExecutionArtifact(digest)).toThrow(
    NATIVE_MAC_ARTIFACT_UNAVAILABLE,
  );
});
