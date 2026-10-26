import { expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { reviewedHandlerSourceArtifacts } from '../connections/reviewed-handler-artifacts.js';

const require = createRequire(import.meta.url);
const sandboxRequire = createRequire(require.resolve('@anthropic-ai/sandbox-runtime'));
type V3 = typeof import('zod/v3');
const commonjs = sandboxRequire('zod') as V3;
const esm = (await import(
  pathToFileURL(join(dirname(sandboxRequire.resolve('zod/package.json')), 'index.js')).href
)) as V3;

it.each([
  ['CommonJS', commonjs],
  ['ESM', esm],
] as const)(
  '%s rejects oversized bounded collections before parsing their elements',
  async (_, z) => {
    const visit = vi.fn((value: unknown) => value);
    const element = z.unknown().transform(visit);
    for (const schema of [z.array(element).max(2), z.array(element).length(2)]) {
      const result = schema.safeParse(Array(1_024).fill(null));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toHaveLength(1);
        expect(result.error.issues).toMatchObject([{ code: 'too_big' }]);
      }
      expect(visit).not.toHaveBeenCalled();
      expect((await schema.safeParseAsync(Array(1_024).fill(null))).success).toBe(false);
      expect(visit).not.toHaveBeenCalled();
    }
    const result = z
      .set(element)
      .max(2)
      .safeParse(new Set([1, 2, 3]));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues).toMatchObject([{ code: 'too_big' }]);
    expect(visit).not.toHaveBeenCalled();
    expect(
      (
        await z
          .set(element)
          .max(2)
          .safeParseAsync(new Set([1, 2, 3]))
      ).success,
    ).toBe(false);
    expect(visit).not.toHaveBeenCalled();
    expect(z.array(element).max(2).parse([1, 2])).toEqual([1, 2]);
    expect(visit).toHaveBeenCalledTimes(2);
    expect(z.array(z.string()).length(2).safeParse(['one']).success).toBe(false);
    expect(
      z
        .set(z.string())
        .max(2)
        .parse(new Set(['one'])),
    ).toEqual(new Set(['one']));
    visit.mockClear();
    expect(z.array(element).parse(Array(1_025).fill(null))).toHaveLength(1_025);
    expect(visit).toHaveBeenCalledTimes(1_025);
  },
);

it('preserves the actual pinned sandbox configuration parser and invalid-policy rejection', async () => {
  const { SandboxRuntimeConfigSchema } = await import('@anthropic-ai/sandbox-runtime');
  const config = {
    filesystem: {
      denyRead: ['/private'],
      allowRead: [],
      allowWrite: ['/workspace'],
      denyWrite: [],
    },
    network: { allowedDomains: ['example.com'], deniedDomains: ['localhost'] },
    enableWeakerNestedSandbox: false,
    allowAppleEvents: false,
  };
  expect(SandboxRuntimeConfigSchema.parse(config)).toEqual(config);
  expect(
    SandboxRuntimeConfigSchema.safeParse({
      ...config,
      filesystem: { ...config.filesystem, denyRead: [42] },
    }).success,
  ).toBe(false);
  expect(require('@anthropic-ai/sandbox-runtime/package.json').version).toBe('0.0.75');
});

it('resolves the explicit v3 backport only for the sandbox and reproduces its archive', () => {
  expect(sandboxRequire('zod/package.json').name).toBe('@mitzo/zod3-sandbox-security');
  expect(require('zod/package.json').version).toBe('4.6.6');
  execFileSync(process.execPath, [
    fileURLToPath(new URL('../../scripts/build-zod3-security-backport.mjs', import.meta.url)),
    '--verify',
  ]);
  expect(() => sandboxRequire.resolve('zod/v4')).toThrow();
  for (const source of [
    '../../package.json',
    '../../package-lock.json',
    '../../packages/harness/package.json',
    '../../scripts/build-zod3-security-backport.mjs',
    '../../scripts/security-backport-archive.mjs',
    '../../vendor/security/zod3-collection-bounds.patch',
    '../../vendor/security/README.md',
    '../__tests__/sandbox-zod-security.test.ts',
  ])
    expect(Object.hasOwn(reviewedHandlerSourceArtifacts, source), source).toBe(true);
});
