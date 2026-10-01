import { afterEach, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
const effects = vi.hoisted(() => ({
  dotenv: vi.fn(),
  fork: vi.fn(),
  host: Object.freeze({ identity: 'original-constructor-host' }),
  dependencies: Object.freeze({ facts: 'synthetic-entry-test-only' }),
  bootstrap: vi.fn(),
  install: vi.fn(),
}));
vi.mock('../app.js', () => ({
  getSymposiumBootstrapDependencies: () => effects.dependencies,
  installSymposiumProductionHost: effects.install,
}));
vi.mock('../symposium-owned-config.js', () => ({
  bootstrapConfiguredSymposiumHost: effects.bootstrap,
}));
vi.mock('../auth.js', () => ({ revokeAuthSession: vi.fn(), registerAuthSession: vi.fn() }));
vi.mock('dotenv/config', () => {
  effects.dotenv();
  return {};
});
vi.mock('node:child_process', async (original) => ({
  ...(await original<object>()),
  fork: effects.fork,
}));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  process.exitCode = undefined;
});
it('exports the fresh custodian constructor without startup, dotenv, process or app side effects on import', async () => {
  vi.stubEnv('MITZO_SYMPOSIUM_CUSTODIAN_CONTROLLER', '1');
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  const entry = await import('../symposium-custodian-main.js');
  await Promise.resolve();
  expect(typeof entry.runSymposiumCustodian).toBe('function');
  expect(effects.dotenv).not.toHaveBeenCalled();
  expect(effects.fork).not.toHaveBeenCalled();
  expect(stderr).not.toHaveBeenCalled();
});
it('requires the exact entry path rather than basename or substring for direct execution', async () => {
  const entry = await import('../symposium-custodian-main.js');
  const exact = fileURLToPath(new URL('../symposium-custodian-main.ts', import.meta.url));
  expect(entry.isDirectSymposiumCustodianEntry(exact)).toBe(true);
  expect(entry.isDirectSymposiumCustodianEntry('/elsewhere/symposium-custodian-main.ts')).toBe(
    false,
  );
  expect(entry.isDirectSymposiumCustodianEntry(exact + '.other')).toBe(false);
  expect(entry.isDirectSymposiumCustodianEntry(undefined)).toBe(false);
});

it('passes constructor hooks and installs the exact bootstrap host once before any child spawn', async () => {
  vi.stubEnv('MITZO_SYMPOSIUM_CUSTODIAN_CONTROLLER', '');
  vi.stubEnv('MITZO_SYMPOSIUM_OWNED_HOST_CONFIG', '/synthetic-entry-only.json');
  vi.stubEnv('MITZO_SYMPOSIUM_CUSTODIAN_OWNER', '');
  effects.bootstrap.mockResolvedValue(effects.host);
  effects.install.mockImplementation(() => {
    throw Error('stop-before-any-child');
  });
  const observer = vi.fn();
  const startup = vi.fn();
  const entry = await import('../symposium-custodian-main.js');
  // Vitest workers themselves have IPC; remove only this synthetic process marker.
  const descriptor = Object.getOwnPropertyDescriptor(process, 'send');
  Object.defineProperty(process, 'send', { configurable: true, value: undefined });
  try {
    await expect(
      entry.runSymposiumCustodian({
        observeDurableReviewToolResult: observer,
        observeStartupConfig: startup,
      }),
    ).rejects.toThrow('stop-before-any-child');
  } finally {
    if (descriptor) Object.defineProperty(process, 'send', descriptor);
    else delete process.send;
  }
  expect(effects.bootstrap).toHaveBeenCalledExactlyOnceWith(
    '/synthetic-entry-only.json',
    {
      ...effects.dependencies,
      observeDurableReviewToolResult: observer,
      observeStartupConfig: startup,
    },
    undefined,
  );
  expect(effects.install).toHaveBeenCalledExactlyOnceWith(effects.host);
  expect(effects.fork).not.toHaveBeenCalled();
});

it('rejects a nonfunction startup observer before bootstrap or child creation', async () => {
  const entry = await import('../symposium-custodian-main.js');
  const calls = effects.bootstrap.mock.calls.length;
  await expect(
    entry.runSymposiumCustodian({ observeStartupConfig: 'invalid' } as never),
  ).rejects.toThrow('Startup observer must be a trusted constructor callback');
  expect(effects.bootstrap.mock.calls).toHaveLength(calls);
  expect(effects.fork).not.toHaveBeenCalled();
});
