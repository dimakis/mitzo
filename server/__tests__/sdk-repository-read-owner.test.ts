import { resetOfflineUserEnvironment } from './fixtures/offline-user-home.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { ownedVertexRuntimeFixture } from './fixtures/owned-local-vertex-runtime.js';
import {
  OrdinaryLocalVertexOwnedRuntime,
  type OrdinaryLocalVertexOwnedDispatch,
} from '../ordinary-local-vertex-owned-runtime.js';
import { OrdinaryLocalVertexSdkAuthority } from '../ordinary-local-vertex-sdk-authority.js';
import { OrdinarySdkTurnEvidence } from '../ordinary-sdk-turn-evidence.js';
import { createSdkRepositoryCallbacks } from '../sdk-repository-callback.js';
import { credentialSdkBoundary } from '../credential-sdk-boundary.js';
import { registerSdkLocalRepositoryTools } from '../sdk-local-repository-tools.js';
import { join } from 'node:path';

const mocked = vi.hoisted(() => ({
  spawn: vi.fn(),
  reader: undefined as undefined | ((...args: unknown[]) => unknown),
}));
vi.mock('node:child_process', async (original) => ({
  ...(await original<object>()),
  spawn: mocked.spawn,
}));
vi.mock('../local-repository-native-reader.js', async (original) => {
  const actual = await original<typeof import('../local-repository-native-reader.js')>();
  return {
    ...actual,
    captureLocalRepositoryReader: (
      ...args: Parameters<typeof actual.captureLocalRepositoryReader>
    ) => (mocked.reader ? mocked.reader(...args) : actual.captureLocalRepositoryReader(...args)),
  };
});
vi.mock('@anthropic-ai/sandbox-runtime', () => ({
  SandboxManager: { checkDependencies: () => ({ errors: [], warnings: [] }) },
}));
vi.mock('../auth.js', async (original) => ({
  ...(await original<object>()),
  hasPersistentRevocationAuthority: () => true,
}));
const cleanups: Array<() => void | Promise<void>> = [];
beforeEach(resetOfflineUserEnvironment);
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  mocked.reader = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** Actual owned runtime, SDK authority and spawned-boundary projection. */
async function sdkRepositoryReadFixture() {
  const f = await ownedVertexRuntimeFixture(cleanups);
  let selected!: OrdinaryLocalVertexOwnedDispatch;
  const owner = new OrdinaryLocalVertexOwnedRuntime({
    enabled: true,
    eventStore: f.events,
    library: f.library,
    workspace: f.workspace,
    reservation: f.reservation,
    commandId: f.request.clientMsgId,
    operatorConnectionId: f.dependencies.operatorConnectionId,
    signal: f.signal.signal,
    env: f.dependencies.env,
    dispatch: async (input) => {
      selected = input;
    },
  });
  cleanups.push(() => owner.close());
  await owner.admit(f.request);
  const custody = f.events.getOrdinaryLocalVertexCustody(selected.sessionId)!;
  const authority = new OrdinaryLocalVertexSdkAuthority({
    store: f.events,
    custody,
    commandId: selected.commandId,
    signal: f.signal.signal,
    environment: () => owner.environment(),
    sourceWriteRoots: [],
    assertCurrent: () => owner.assertEffect(selected.commandId),
    assertCurrentSync: () => owner.assertStart(selected.commandId),
  });
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  mocked.spawn.mockReturnValue(child);
  const boundary = credentialSdkBoundary('darwin', [f.root], undefined, authority)!;
  boundary.spawnClaudeCodeProcess({
    command: '/usr/bin/true',
    args: [],
    env: {},
    cwd: custody.cwd,
    signal: f.signal.signal,
  });
  cleanups.push(() => {
    child.emit('close', 0, null);
  });
  const projection = boundary.captureRepositoryReadProjection();
  const state = { current: true };
  const callbacks = createSdkRepositoryCallbacks({
    commandId: () => selected.commandId,
    checkTool: () => 'allow',
    assertCurrent() {
      if (!state.current) throw Error('Query retired');
    },
  });
  return { f, selected, custody, authority, projection, callbacks, state };
}

it('binds repository reads to actual SDK ACK, immutable workspace/account, query and complete OS projection', async () => {
  const { f, selected, custody, authority, projection, callbacks, state } =
    await sdkRepositoryReadFixture();
  const name = 'mcp__mitzo-connections__DiscoverLocalRepository';
  callbacks.observe({
    hook_event_name: 'PreToolUse',
    tool_name: name,
    tool_use_id: 'sdk-tool-use',
    tool_input: { path: f.root },
    session_id: custody.sdkSessionId,
    cwd: custody.cwd,
  });
  const callback = callbacks.capture(name, { path: f.root }, 7, f.signal.signal);
  expect(() => authority.captureRepositoryReadOwner(callback, projection)).toThrow(/acknowledg/i);
  new OrdinarySdkTurnEvidence(f.events, selected.sessionId, custody.sdkSessionId).accepted(
    selected.commandId,
    'actual-input-uuid',
  );
  const reader = authority.captureRepositoryReadOwner(callback, projection);
  expect(reader).toMatchObject({
    conversationId: selected.sessionId,
    commandId: selected.commandId,
    sdkSessionId: custody.sdkSessionId,
    inputUuid: 'actual-input-uuid',
    cwd: custody.cwd,
    workspaceId: custody.repositoryWorkspaceId,
    projection,
  });
  expect(() => authority.captureRepositoryReadOwner({ ...callback }, projection)).toThrow(
    /original SDK repository callback/i,
  );
  expect(() => authority.captureRepositoryReadOwner(callback, { ...projection })).toThrow(
    /original SDK read projection/i,
  );
  const foreignBoundary = credentialSdkBoundary('darwin', [f.root])!;
  foreignBoundary.spawnClaudeCodeProcess({
    command: '/usr/bin/true',
    args: [],
    env: {},
    cwd: custody.cwd,
    signal: f.signal.signal,
  });
  expect(() =>
    authority.captureRepositoryReadOwner(
      callback,
      foreignBoundary.captureRepositoryReadProjection(),
    ),
  ).toThrow(/original SDK read projection/i);
  await reader.assertCurrent();
  state.current = false;
  expect(() => reader.assertCurrentSync()).toThrow(/retired/i);
  state.current = true;
  f.signal.abort();
  await expect(reader.assertCurrent()).rejects.toThrow();
});

it('returns DiscoverLocalRepository and InspectLocalRepository results through the registered SDK handlers', async () => {
  const { f, selected, custody, authority, projection, callbacks } =
    await sdkRepositoryReadFixture();
  new OrdinarySdkTurnEvidence(f.events, selected.sessionId, custody.sdkSessionId).accepted(
    selected.commandId,
    'actual-input-uuid',
  );
  const missing = Object.assign(Error('missing'), { code: 'ENOENT' });
  const fake = (
    _projection: unknown,
    signal: AbortSignal,
    _current: unknown,
    _full: unknown,
    options: { deadline: number },
  ) =>
    Object.freeze({
      deadline: options.deadline,
      signal,
      deniedRoots: Object.freeze([join(f.root, 'denied')]),
      assertCurrentSync: () => undefined,
      revalidate: async () => undefined,
      executeReadOperation: async () => {
        throw missing;
      },
      executeDirectoryVerification: async () => {
        throw missing;
      },
      captureReadAnchor: vi.fn(async () => {
        throw missing;
      }),
      dispose: async () => undefined,
    });
  mocked.reader = fake as never;
  const handlers = new Map<
    string,
    (
      input: Record<string, unknown>,
      extra: { signal: AbortSignal; requestId?: number },
    ) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>
  >();
  const server = {
    registerTool: (name: string, _definition: unknown, handler: never) =>
      handlers.set(name, handler),
  };
  const session = {
    abortController: new AbortController(),
    cwd: custody.cwd,
    worktreePaths: new Map(),
  };
  const registry = {
    findBySessionId: (id: string) =>
      id === selected.sessionId ? { session, clientId: 'client' } : undefined,
    get: () => undefined,
  };
  let requestId = 0;
  registerSdkLocalRepositoryTools(
    server as never,
    () => selected.sessionId,
    session as never,
    registry as never,
    {
      events: f.events,
      captureRepositoryReadOwner: (wire, input, id, signal) =>
        authority.captureRepositoryReadOwner(
          callbacks.capture(wire, input, id, signal),
          projection,
        ),
    },
  );
  const call = async (name: string, input: Record<string, unknown>) => {
    const id = ++requestId;
    callbacks.observe({
      hook_event_name: 'PreToolUse',
      tool_name: `mcp__mitzo-connections__${name}`,
      tool_use_id: `sdk-tool-use-${id}`,
      tool_input: input,
      session_id: custody.sdkSessionId,
      cwd: custody.cwd,
    });
    const result = await handlers.get(name)!(input, { signal: f.signal.signal, requestId: id });
    return { isError: result.isError, value: JSON.parse(result.content[0]!.text) };
  };
  const path = join(f.root, 'absent');
  const discovered = await call('DiscoverLocalRepository', { path });
  // Real discovery classifies the path; before the shared hooks it threw
  // read-anchor-required and surfaced as an opaque internal failure.
  expect(discovered).toMatchObject({
    isError: false,
    value: { state: 'access-required', diagnostics: [{ path, reason: 'read-access-required' }] },
  });
  expect(JSON.stringify(discovered)).not.toContain('read-anchor-required');
  const inspected = await call('InspectLocalRepository', { path });
  expect(JSON.stringify(inspected)).not.toContain('read-anchor-required');
  expect(inspected).toEqual({
    isError: true,
    value: { state: 'access-required', reason: 'read-access-required', needed: ['read-access'] },
  });
});
