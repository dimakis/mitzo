import { mkdtempSync, mkdirSync, chmodSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPrivateOriginalProcessJournal } from '../symposium-original-process-retention.js';
import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
const effects = vi.hoisted(() => ({
  dotenv: vi.fn(),
  fork: vi.fn(),
  serve: vi.fn(),
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
  beginSymposiumShutdown: vi.fn(),
  retireRetainedSymposiumRuntimes: vi.fn(async () => {}),
}));
vi.mock('../symposium-owned-config.js', () => ({
  bootstrapConfiguredSymposiumHost: effects.bootstrap,
}));
vi.mock('../symposium-custodian-ipc.js', async (original) => {
  const actual = await original<typeof import('../symposium-custodian-ipc.js')>();
  return {
    ...actual,
    serveCustodianController: (...args: Parameters<typeof actual.serveCustodianController>) =>
      effects.serve.getMockImplementation()
        ? effects.serve(...args)
        : actual.serveCustodianController(...args),
  };
});
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

it.each([
  { admissionBuildSelection: undefined, observeNativeTurnInput: undefined },
  { admissionBuildSelection: undefined, observeNativeTurnInput: false },
  { admissionBuildSelection: 'local-854b-b20-v1' as const, observeNativeTurnInput: true },
])(
  'passes constructor hooks and optional trusted diagnostic %j before any child spawn',
  async ({ admissionBuildSelection, observeNativeTurnInput }) => {
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
          ...(observeNativeTurnInput === undefined ? {} : { observeNativeTurnInput }),
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
        ...(observeNativeTurnInput === undefined ? {} : { observeNativeTurnInput }),
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

it('journals original controller fork before readiness and retains gateway constructor callback', async () => {
  vi.stubEnv('MITZO_SYMPOSIUM_CUSTODIAN_CONTROLLER', '');
  vi.stubEnv('MITZO_SYMPOSIUM_OWNED_HOST_CONFIG', '/synthetic-entry-only.json');
  effects.bootstrap.mockResolvedValue(effects.host);
  effects.install.mockReset();
  effects.serve.mockReset();
  const child = Object.assign(new EventEmitter(), {
    pid: 9876,
    connected: true,
    exitCode: 0,
    signalCode: null,
    kill: vi.fn(),
  });
  // Creation callback sees a live child; terminal transport stub sets exit before cleanup.
  child.exitCode = null as unknown as number;
  effects.fork.mockReturnValue(child);
  effects.serve.mockImplementation(async () => {
    child.exitCode = 0;
    throw Error('stop-before-controller-readiness');
  });
  const observe = vi.fn((role, original, current) => {
    expect(role).toBe('controller');
    expect(original).toBe(child);
    expect(effects.serve).not.toHaveBeenCalled();
    current();
  });
  const entry = await import('../symposium-custodian-main.js');
  const descriptor = Object.getOwnPropertyDescriptor(process, 'send');
  Object.defineProperty(process, 'send', { configurable: true, value: undefined });
  try {
    await entry.runSymposiumCustodian({ observeOriginalProcess: observe });
  } finally {
    if (descriptor) Object.defineProperty(process, 'send', descriptor);
    else delete process.send;
  }
  expect(observe).toHaveBeenCalledTimes(1);
  expect(effects.bootstrap.mock.calls.at(-1)?.[3]).toBe(observe);
});

it('permanent creation journal failure fences after the sole original fork without readiness or retry', async () => {
  vi.stubEnv('MITZO_SYMPOSIUM_CUSTODIAN_CONTROLLER', '');
  vi.stubEnv('MITZO_SYMPOSIUM_OWNED_HOST_CONFIG', '/synthetic-entry-only.json');
  effects.bootstrap.mockResolvedValue(effects.host);
  effects.install.mockReset();
  effects.serve.mockReset();
  effects.fork.mockReset();
  effects.host.markShutdownUncertain.mockClear();
  const child = Object.assign(new EventEmitter(), {
    pid: 9876,
    connected: true,
    exitCode: null,
    signalCode: null,
    kill: vi.fn((signal: string) => {
      queueMicrotask(() => {
        Object.assign(child, { signalCode: signal });
        child.emit('exit');
      });
      return true;
    }),
  });
  effects.fork.mockReturnValue(child);
  const dir = mkdtempSync(join(tmpdir(), 'entry-journal-loss-'));
  chmodSync(dir, 0o700);
  const journal = createPrivateOriginalProcessJournal(dir, (pid) => ({
    pid,
    parentPid: pid === process.pid ? process.ppid : process.pid,
    uid: process.getuid!(),
    domain: 'a'.repeat(64),
    birth: '100:1',
  }));
  let before = Buffer.alloc(0);
  const observe = vi.fn((role, original, current) => {
    let calls = 0;
    try {
      journal(role, original, () => {
        if (++calls === 4) throw Error('postwrite original guard lost');
        current();
      });
    } catch (error) {
      before = readFileSync(join(dir, readdirSync(dir)[0]));
      throw error;
    }
  });
  const entry = await import('../symposium-custodian-main.js');
  const descriptor = Object.getOwnPropertyDescriptor(process, 'send');
  Object.defineProperty(process, 'send', { configurable: true, value: undefined });
  const oldTerm = new Set(process.listeners('SIGTERM')),
    oldInt = new Set(process.listeners('SIGINT'));
  const output = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  try {
    await entry.runSymposiumCustodian({ observeOriginalProcess: observe });
  } finally {
    if (descriptor) Object.defineProperty(process, 'send', descriptor);
    else delete process.send;
    for (const listener of process.listeners('SIGTERM'))
      if (!oldTerm.has(listener)) process.off('SIGTERM', listener);
    for (const listener of process.listeners('SIGINT'))
      if (!oldInt.has(listener)) process.off('SIGINT', listener);
  }
  expect(effects.fork).toHaveBeenCalledTimes(1);
  expect(observe).toHaveBeenCalledExactlyOnceWith('controller', child, expect.any(Function));
  expect(effects.serve).not.toHaveBeenCalled();
  expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
  expect(effects.host.markShutdownUncertain).toHaveBeenCalledTimes(1);
  expect(process.exitCode).toBe(1);
  expect(before.length).toBeGreaterThan(0);
  expect(readFileSync(join(dir, readdirSync(dir)[0]))).toEqual(before);
  expect(() =>
    journal(
      'controller',
      Object.assign(new EventEmitter(), {
        pid: 9877,
        exitCode: null,
        signalCode: null,
        killed: false,
      }) as never,
      () => {},
    ),
  ).toThrow('fenced');
  journal.close();
  rmSync(dir, { recursive: true });
  expect(output).toHaveBeenCalledWith(expect.stringContaining('resources remain quarantined'));
});

it.each(['true', 1, null, {}, () => true])(
  'rejects nonboolean diagnostic before constructor effects: %j',
  async (value) => {
    const entry = await import('../symposium-custodian-main.js');
    const calls = effects.bootstrap.mock.calls.length;
    const installs = effects.install.mock.calls.length;
    const forks = effects.fork.mock.calls.length;
    await expect(
      entry.runSymposiumCustodian({ observeNativeTurnInput: value } as never),
    ).rejects.toThrow('Native input diagnostic must be a trusted constructor boolean');
    expect(effects.bootstrap.mock.calls).toHaveLength(calls);
    expect(effects.install.mock.calls).toHaveLength(installs);
    expect(effects.fork.mock.calls).toHaveLength(forks);
  },
);

it('reports original attached generation at terminal retirement even before child hello', async () => {
  vi.stubEnv('MITZO_SYMPOSIUM_CUSTODIAN_CONTROLLER', '');
  vi.stubEnv('MITZO_SYMPOSIUM_OWNED_HOST_CONFIG', '/synthetic-entry-only.json');
  const root = mkdtempSync(join(tmpdir(), 'custodian-prehello-'));
  chmodSync(root, 0o700);
  mkdirSync(join(root, 'gateway'), { mode: 0o700 });
  const child = Object.assign(new EventEmitter(), {
    pid: 9876,
    connected: true,
    exitCode: null as number | null,
    signalCode: null,
    kill: vi.fn(),
    disconnect() {
      this.connected = false;
    },
  });
  effects.bootstrap.mockResolvedValue({
    ...effects.host,
    gateway: { stateDirectory: join(root, 'gateway') },
    beginShutdown() {},
    async drain() {},
    async closeAfterDrain() {},
  });
  effects.install.mockReset();
  effects.fork.mockReturnValue(child);
  effects.serve.mockImplementation(async (_channel, controller) => {
    controller.attach();
    child.exitCode = 0;
    process.emit('SIGTERM');
  });
  const entry = await import('../symposium-custodian-main.js');
  const observe = vi.fn();
  const descriptor = Object.getOwnPropertyDescriptor(process, 'send');
  Object.defineProperty(process, 'send', { configurable: true, value: undefined });
  const oldTerm = new Set(process.listeners('SIGTERM')),
    oldInt = new Set(process.listeners('SIGINT'));
  try {
    await entry.runSymposiumCustodian({ observeRetirement: observe });
    expect(observe.mock.calls[0]).toEqual([
      'retiring',
      root,
      expect.objectContaining({ instanceId: expect.any(String), controllerGeneration: 1 }),
    ]);
    expect(observe.mock.calls.at(-1)).toEqual(['retired', root, observe.mock.calls[0][2]]);
  } finally {
    if (descriptor) Object.defineProperty(process, 'send', descriptor);
    else delete process.send;
    for (const listener of process.listeners('SIGTERM'))
      if (!oldTerm.has(listener)) process.off('SIGTERM', listener);
    for (const listener of process.listeners('SIGINT'))
      if (!oldInt.has(listener)) process.off('SIGINT', listener);
    rmSync(root, { recursive: true, force: true });
    effects.serve.mockReset();
  }
});
