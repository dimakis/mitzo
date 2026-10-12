import { expect, it } from 'vitest';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import {
  assertCanonicalNativeInvocation,
  assertNativeReplicaSourceProtocol,
  runContainedNativeCanonicalLauncher,
} from '../../scripts/lib/staging-contained-native-controller.mjs';
it('requires the real native feature/enrollment/per-call source implementation before authorizing allocation', () => {
  for (const main of [
    {},
    { STAGING_NATIVE_FEATURE_BOOTSTRAP_PROTOCOL_VERSION: 1 },
    { STAGING_NATIVE_FEATURE_BOOTSTRAP_PROTOCOL_VERSION: 0, runSymposiumCustodian() {} },
  ])
    expect(() => assertNativeReplicaSourceProtocol(main)).toThrow('bootstrap unavailable');
  try {
    assertNativeReplicaSourceProtocol({});
  } catch (error) {
    expect(error.nativeDiagnostic).toContain('model-call implementation');
  }
  expect(() =>
    assertNativeReplicaSourceProtocol({
      STAGING_NATIVE_FEATURE_BOOTSTRAP_PROTOCOL_VERSION: 1,
      runSymposiumCustodian() {},
    }),
  ).not.toThrow();
});
it('refuses arbitrary bootstrap/private production paths and a nonprepared checkout before private reads', async () => {
  const root = join(userInfo().homedir, '.local/share/mitzo-staging'),
    sourceRoot = join(root, 'releases', 'a'.repeat(12));
  const invocation = {
    sourceRoot,
    bootstrapPath: join(
      root,
      'service/native-dispositions',
      '22222222-2222-4222-8222-222222222222',
      'bootstrap.json',
    ),
    expectedBootstrap: 'b'.repeat(64),
  };
  expect(assertCanonicalNativeInvocation(invocation, sourceRoot)).toBe(root);
  for (const changed of [
    { ...invocation, bootstrapPath: '/production/private/credentials.json' },
    { ...invocation, sourceRoot: '/ordinary/checkout' },
    {
      ...invocation,
      bootstrapPath: invocation.bootstrapPath.replace('/bootstrap.json', '/../other.json'),
    },
  ])
    expect(() => assertCanonicalNativeInvocation(changed, sourceRoot)).toThrow(
      'bootstrap unavailable',
    );
  await expect(
    runContainedNativeCanonicalLauncher({
      sourceRoot: '/ordinary/checkout',
      bootstrapPath: '/production/private/credentials.json',
      expectedBootstrap: 'b'.repeat(64),
    }),
  ).rejects.toThrow('bootstrap unavailable');
});
