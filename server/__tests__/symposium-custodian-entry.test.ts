import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
const effects = vi.hoisted(() => ({
  dotenv: vi.fn(),
  fork: vi.fn(),
  host: Object.freeze({
    identity: 'original-constructor-host',
    currentProfiles: vi.fn(() => []),
    resumeController: vi.fn(),
    pauseController: vi.fn(),
    quiesceController: vi.fn(async () => {}),
    markShutdownUncertain: vi.fn(),
  }),
  dependencies: Object.freeze({ facts: 'synthetic-entry-test-only' }),
  bootstrap: vi.fn(),
  install: vi.fn(),
}));
vi.mock('../app.js', () => ({
  getSymposiumBootstrapDependencies: () => effects.dependencies,
  installSymposiumProductionHost: effects.install,
  pauseSymposiumController: vi.fn(),
  resumeSymposiumController: vi.fn(),
  drainSymposiumController: vi.fn(async () => {}),
  setSymposiumCustodianBroadcast: vi.fn(),
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

it.each([undefined, 'local-854b-b20-v1'] as const)(
  'passes constructor hooks and optional trusted build %s before any child spawn',
  async (admissionBuildSelection) => {
    effects.bootstrap.mockClear();
    effects.install.mockClear();
    vi.stubEnv('MITZO_SYMPOSIUM_CUSTODIAN_CONTROLLER', '');
    vi.stubEnv('MITZO_SYMPOSIUM_OWNED_HOST_CONFIG', '/synthetic-entry-only.json');
    vi.stubEnv('MITZO_SYMPOSIUM_CUSTODIAN_OWNER', '');
    effects.bootstrap.mockResolvedValue(effects.host);
    effects.install.mockImplementation(() => {
      throw Error('stop-before-any-child');
    });
    const observer = vi.fn();
    const startup = vi.fn();
    const prelaunch = vi.fn();
    const runtime = vi.fn();
    const entry = await import('../symposium-custodian-main.js');
    // Vitest workers themselves have IPC; remove only this synthetic process marker.
    const descriptor = Object.getOwnPropertyDescriptor(process, 'send');
    Object.defineProperty(process, 'send', { configurable: true, value: undefined });
    try {
      await expect(
        entry.runSymposiumCustodian({
          observeDurableReviewToolResult: observer,
          observeStartupConfig: startup,
          observePrelaunch: prelaunch,
          observeRuntime: runtime,
          ...(admissionBuildSelection === undefined ? {} : { admissionBuildSelection }),
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
        observePrelaunch: prelaunch,
        observeRuntime: runtime,
        ...(admissionBuildSelection === undefined ? {} : { admissionBuildSelection }),
      },
      undefined,
    );
    expect(effects.install).toHaveBeenCalledExactlyOnceWith(effects.host);
    expect(effects.fork).not.toHaveBeenCalled();
  },
);

it('rejects a nonfunction startup observer before bootstrap or child creation', async () => {
  const entry = await import('../symposium-custodian-main.js');
  const calls = effects.bootstrap.mock.calls.length;
  await expect(
    entry.runSymposiumCustodian({ observeStartupConfig: 'invalid' } as never),
  ).rejects.toThrow('Startup observer must be a trusted constructor callback');
  expect(effects.bootstrap.mock.calls).toHaveLength(calls);
  expect(effects.fork).not.toHaveBeenCalled();
});

it('rejects a serialized prelaunch callback before bootstrap effects', async () => {
  const entry = await import('../symposium-custodian-main.js');
  const calls = effects.bootstrap.mock.calls.length;
  await expect(
    entry.runSymposiumCustodian({ observePrelaunch: 'serialized' } as never),
  ).rejects.toThrow('Prelaunch observer must be a trusted constructor callback');
  expect(effects.bootstrap.mock.calls).toHaveLength(calls);
});

it.each(['sync', 'async'] as const)(
  'observes immutable identity from the exact original fork and refuses %s callback failure',
  async (mode) => {
    vi.stubEnv('MITZO_SYMPOSIUM_CUSTODIAN_CONTROLLER', '');
    vi.stubEnv('MITZO_SYMPOSIUM_OWNED_HOST_CONFIG', '/synthetic-entry-only.json');
    const entry = await import('../symposium-custodian-main.js');
    const child = Object.assign(new EventEmitter(), {
      pid: 43210,
      connected: true,
      exitCode: null,
      signalCode: null,
      send: vi.fn(),
      kill: vi.fn(function () {
        queueMicrotask(() => child.emit('exit'));
        return true;
      }),
    });
    effects.bootstrap.mockResolvedValue(effects.host);
    effects.install.mockImplementation(() => {});
    effects.fork.mockClear();
    effects.fork.mockImplementation(() => {
      queueMicrotask(() => child.emit('message', { kind: 'hello' }));
      return child;
    });
    const observe = vi.fn(
      (
        identity: Readonly<
          import('../symposium-custodian-main.js').OriginalSymposiumControllerIdentity
        >,
        current: () => void,
      ) => {
        expect(Object.isFrozen(identity)).toBe(true);
        expect(identity.custodianPid).toBe(process.pid);
        expect(identity.controllerPid).toBe(child.pid);
        expect(identity.epoch).toBe(1);
        expect(identity.state).toBe('active');
        current();
        if (mode === 'async') return Promise.reject(Error('synthetic unexpected async rejection'));
        throw Error('synthetic stop after readonly observation');
      },
    );
    const descriptor = Object.getOwnPropertyDescriptor(process, 'send');
    Object.defineProperty(process, 'send', { configurable: true, value: undefined });
    const oldTerm = new Set(process.listeners('SIGTERM')),
      oldInt = new Set(process.listeners('SIGINT'));
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      await entry.runSymposiumCustodian({ observeController: observe });
    } finally {
      if (descriptor) Object.defineProperty(process, 'send', descriptor);
      else delete process.send;
      for (const listener of process.listeners('SIGTERM'))
        if (!oldTerm.has(listener)) process.off('SIGTERM', listener);
      for (const listener of process.listeners('SIGINT'))
        if (!oldInt.has(listener)) process.off('SIGINT', listener);
    }
    expect(observe).toHaveBeenCalledOnce();
    expect(effects.fork).toHaveBeenCalledOnce();
    expect(child.send).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(() => observe.mock.calls[0][1]()).toThrow('unavailable');
  },
);

it('refuses unknown serialized build selection before app bootstrap or child launch', async () => {
  const entry = await import('../symposium-custodian-main.js');
  const before = effects.bootstrap.mock.calls.length;
  await expect(
    entry.runSymposiumCustodian({ admissionBuildSelection: 'unknown' } as never),
  ).rejects.toThrow('not reviewed');
  expect(effects.bootstrap.mock.calls).toHaveLength(before);
});
