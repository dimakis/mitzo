import { expect, it } from 'vitest';
import {
  assertQualifiedNativeMacExecutionArtifact,
  NATIVE_MAC_ARTIFACT_UNAVAILABLE,
} from '../codex-native-artifact-qualification.js';

it('enables only the exact official Mac artifact exercised by the pinned kernel fixtures', () => {
  expect(() =>
    assertQualifiedNativeMacExecutionArtifact(
      '112fae7a5a1223e673c8a1791d32338f37df8b527ff1159bb8adac6c4dbf1b4b',
    ),
  ).not.toThrow();
});
it.each([
  '',
  '0.160.0',
  '0'.repeat(64),
  '112fae7a5a1223e673c8a1791d32338f37df8b527ff1159bb8adac6c4dbf1b4c',
])('rejects unqualified artifacts without downgrading the route: %s', (digest) => {
  expect(() => assertQualifiedNativeMacExecutionArtifact(digest)).toThrow(
    NATIVE_MAC_ARTIFACT_UNAVAILABLE,
  );
});
