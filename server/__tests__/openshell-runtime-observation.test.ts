import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const child = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: child.execFile }));
import {
  OpenShellRuntimeManager,
  observeMountJson,
  type OpenShellRuntimeObservation,
  type BoundOpenShellRuntimeConfig,
} from '../openshell-runtime.js';
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'runtime-observation-'));
  vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', root);
  child.execFile.mockReset();
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});
const base = {
  cli: '/synthetic/no-command',
  image: 'synthetic-image',
  policy: '/synthetic/policy',
  seed: '/synthetic/seed',
  serviceProviders: [],
  grantableServiceProviders: [],
  workspace: 'synthetic',
  gateway: 'synthetic',
  gatewayInsecure: false,
  createDetached: true,
  sandboxIdLength: 13,
  workdir: '/sandbox/workspaces/mgmt',
  webSearch: 'disabled',
  account: { kind: 'api', provider: 'work', model: 'synthetic' },
} as BoundOpenShellRuntimeConfig;
it('actual default execFile callback emits finite terminal metadata without exposing argv or streams', async () => {
  const events: OpenShellRuntimeObservation[] = [];
  const error = Object.assign(Error('PRIVATE_COMMAND_MESSAGE'), {
    code: 7,
    signal: null,
    killed: false,
  });
  child.execFile.mockImplementation((_binary, _args, options, callback) => {
    expect(options.timeout).toBe(120000);
    expect(options.maxBuffer).toBe(1024 * 1024);
    callback(error, 'PRIVATE_STDOUT', 'PRIVATE_STDERR');
    return {} as never;
  });
  const manager = new OpenShellRuntimeManager({
    ...base,
    observeRuntime: (e: OpenShellRuntimeObservation) => events.push(e),
  } as BoundOpenShellRuntimeConfig);
  await expect(manager.ensure('synthetic-conversation', new AbortController().signal)).rejects.toBe(
    error,
  );
  const cli = events.filter((e) => e.kind === 'cli-command');
  expect(cli.map((e) => e.stage)).toEqual(['start', 'terminal']);
  expect(cli[1]).toMatchObject({
    operation: 'sandbox-get',
    exitCode: 7,
    signal: null,
    error: 'nonzero',
    stdoutAvailable: true,
    stdoutBytes: 14,
    stderrAvailable: true,
    stderrBytes: 14,
  });
  expect(JSON.stringify(events)).not.toMatch(
    /PRIVATE|synthetic-conversation|synthetic\/no-command/,
  );
  expect(events.every(Object.isFrozen)).toBe(true);
});
it('actual ensure phases locate pre-dispatch connections refusal without marking create', async () => {
  const events: OpenShellRuntimeObservation[] = [];
  const original = Error('original connections refusal');
  const run = vi.fn(async (args: readonly string[]) => {
    if (args[0] === 'provider')
      return JSON.stringify({
        providers: [{ name: 'work', id: 'exact', type: 'openai', workspace: 'synthetic' }],
        next_page_token: '',
      });
    throw Error('not found');
  });
  const manager = new OpenShellRuntimeManager(
    {
      ...base,
      cliContract: 'v0.1',
      accountProviderBindings: [{ name: 'work', id: 'exact', type: 'openai' }],
      verifyAccountProviderUnion: () => {},
      verifyConnections: async () => {
        throw original;
      },
      observeRuntime: (e: OpenShellRuntimeObservation) => events.push(e),
    } as BoundOpenShellRuntimeConfig,
    run,
  );
  await expect(manager.ensure('synthetic-conversation', new AbortController().signal)).rejects.toBe(
    original,
  );
  expect(
    events
      .filter((e) => e.kind === 'ensure-phase')
      .filter((e) => e.stage === 'start')
      .map((e) => e.phase),
  ).toEqual([
    'provider-union',
    'account-provider-check',
    'provider-union',
    'sandbox-current',
    'sandbox-legacy',
    'connections',
  ]);
  expect(events.at(-1)).toMatchObject({
    kind: 'ensure-phase',
    phase: 'connections',
    stage: 'rejected',
  });
  expect(run).toHaveBeenCalledTimes(3);
});
it.each(['throw', 'reject'])(
  'observer %s cannot alter original command rejection',
  async (mode) => {
    const original = Error('original command rejection');
    child.execFile.mockImplementation((_b, _a, _o, cb) => {
      cb(original, null, undefined);
      return {} as never;
    });
    const observeRuntime = () => {
      if (mode === 'throw') throw Error('observer refusal');
      return Promise.reject(Error('observer refusal'));
    };
    const manager = new OpenShellRuntimeManager({
      ...base,
      observeRuntime,
    } as BoundOpenShellRuntimeConfig);
    await expect(
      manager.ensure('synthetic-conversation', new AbortController().signal),
    ).rejects.toBe(original);
    await new Promise((r) => setImmediate(r));
    expect(child.execFile).toHaveBeenCalledOnce();
  },
);
it('missing streams are unavailable and original abort stays original', async () => {
  const events: OpenShellRuntimeObservation[] = [];
  const original = Object.assign(Error('original abort'), {
    name: 'AbortError',
    code: 'ABORT_ERR',
  });
  const abort = new AbortController();
  child.execFile.mockImplementation((_b, _a, _o, cb) => {
    abort.abort();
    cb(original, null, undefined);
    return {} as never;
  });
  await expect(
    new OpenShellRuntimeManager({
      ...base,
      observeRuntime: (e: OpenShellRuntimeObservation) => events.push(e),
    } as BoundOpenShellRuntimeConfig).ensure('synthetic-conversation', abort.signal),
  ).rejects.toBe(original);
  expect(events.find((e) => e.kind === 'cli-command' && e.stage === 'terminal')).toMatchObject({
    error: 'aborted',
    stdoutAvailable: false,
    stdoutBytes: null,
    stderrAvailable: false,
    stderrBytes: null,
  });
});
it('no observer retains original default callback error and options', async () => {
  const original = Error('original');
  const signal = new AbortController().signal;
  child.execFile.mockImplementation((_b, _a, o, cb) => {
    expect(o.signal).toBe(signal);
    expect(o.timeout).toBe(120000);
    cb(original, '', '');
    return {} as never;
  });
  await expect(
    new OpenShellRuntimeManager(base).ensure('synthetic-conversation', signal),
  ).rejects.toBe(original);
});
it('observer failure cannot alter fulfilled original CLI read', async () => {
  const value = {
    name: 'original',
    workspace: 'synthetic',
    phase: 'Ready',
    id: 'original-id',
    labels: {},
  };
  child.execFile.mockImplementation((_b, _a, _o, cb) => {
    cb(null, JSON.stringify(value), '');
    return {} as never;
  });
  const manager = new OpenShellRuntimeManager({
    ...base,
    observeRuntime: () => Promise.reject(Error('private observer failure')),
  });
  const get = manager as unknown as { get(name: string, signal: AbortSignal): Promise<unknown> };
  expect(await get.get('original', new AbortController().signal)).toMatchObject(value);
  await new Promise((r) => setImmediate(r));
});
it('synchronous original execFile refusal retains terminal metadata and original error', async () => {
  const events: unknown[] = [];
  const original = Object.assign(Error('private synchronous refusal'), { code: 'EACCES' });
  child.execFile.mockImplementation(() => {
    throw original;
  });
  await expect(
    new OpenShellRuntimeManager({ ...base, observeRuntime: (e) => events.push(e) }).ensure(
      'synthetic-conversation',
      new AbortController().signal,
    ),
  ).rejects.toBe(original);
  expect(events).toContainEqual(
    expect.objectContaining({
      kind: 'cli-command',
      stage: 'terminal',
      error: 'spawn',
      stdoutAvailable: false,
      stderrAvailable: false,
    }),
  );
});

it.each(['podman-ps', 'podman-inspect'] as const)(
  'observes actual JSON boundary %s without leaking bytes',
  async (operation) => {
    const events: OpenShellRuntimeObservation[] = [];
    const read = vi.fn(async () => '');
    await expect(observeMountJson((event) => events.push(event), operation, read)).rejects.toThrow(
      'Unexpected end of JSON input',
    );
    expect(read).toHaveBeenCalledTimes(1);
    expect(events.map((event) => event.stage)).toEqual(['start', 'terminal', 'parse-rejected']);
    expect(events[2]).toMatchObject({
      kind: 'mount-json',
      operation,
      error: 'parse',
      outputAvailable: true,
      outputBytes: 0,
    });
  },
);
it('observer throws and rejects cannot change original JSON result or original transport error', async () => {
  const original = Error('PRIVATE_ORIGINAL_TRANSPORT');
  for (const observer of [
    undefined,
    () => {
      throw Error('PRIVATE_OBSERVER');
    },
    () => Promise.reject(Error('PRIVATE_ASYNC_OBSERVER')),
  ]) {
    await expect(
      observeMountJson(observer, 'podman-ps', async () => '{"ok":true}'),
    ).resolves.toEqual({ ok: true });
    await expect(
      observeMountJson(observer, 'native-ssh-probe', async () => {
        throw original;
      }),
    ).rejects.toBe(original);
  }
});
it('successful JSON observation contains metadata only and frozen payloads', async () => {
  const events: OpenShellRuntimeObservation[] = [];
  await expect(
    observeMountJson(
      (event) => events.push(event),
      'podman-inspect',
      async () => '{"secret":"PRIVATE_VALUE"}',
    ),
  ).resolves.toEqual({ secret: 'PRIVATE_VALUE' });
  expect(events.map((event) => event.stage)).toEqual(['start', 'terminal', 'parsed']);
  expect(events.every(Object.isFrozen)).toBe(true);
  expect(JSON.stringify(events)).not.toContain('PRIVATE_VALUE');
});
