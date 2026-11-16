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

const mocked = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async (original) => ({
  ...(await original<object>()),
  spawn: mocked.spawn,
}));
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
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it('binds repository reads to actual SDK ACK, immutable workspace/account, query and complete OS projection', async () => {
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
  let current = true;
  const callbacks = createSdkRepositoryCallbacks({
    commandId: () => selected.commandId,
    checkTool: () => 'allow',
    assertCurrent() {
      if (!current) throw Error('Query retired');
    },
  });
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
  current = false;
  expect(() => reader.assertCurrentSync()).toThrow(/retired/i);
  current = true;
  f.signal.abort();
  await expect(reader.assertCurrent()).rejects.toThrow();
});
