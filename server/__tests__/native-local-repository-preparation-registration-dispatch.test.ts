import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as workspaceRuntime from '../repository-workspace-runtime.js';
import { EventStore } from '../event-store.js';
import { setAuthRevocationStore } from '../auth.js';
import {
  captureNativeHostReadOwner,
  type NativeHostToolContext,
} from '../native-host-tool-context.js';
import { inputSchema } from '../local-repository-preparation-authorization.js';
import { executeLocalRepositoryPreparation } from '../local-repository-preparation-operation.js';
import { executeNativeLocalRepositoryPreparation } from '../native-local-repository-preparation.js';
import { captureNativeLocalRepositoryPreparationSource } from '../local-repository-preparation-source.js';
import { retainTelosWorkRoleContext } from '../telos-work-role-context.js';
import { localRepositoryNativeToolFixture } from './fixtures/local-repository-native-tools.js';
import { localPreparationNativeFixture } from './fixtures/local-preparation-native.js';

// Candidate registration + genuine signed callback/current ownership. Operation,
// qualifier and executable classification are CONTROLLED, not actor/approval/SRT.
// Real forced one-use permission behavior is tested separately with actual auth.
vi.mock('../local-repository-preparation-operation.js', async (original) => ({
  ...(await original<typeof import('../local-repository-preparation-operation.js')>()),
  executeLocalRepositoryPreparation: vi.fn(),
}));
vi.mock('../local-repository-preparation-source.js', async (original) => ({
  ...(await original<typeof import('../local-repository-preparation-source.js')>()),
  captureNativeLocalRepositoryPreparationSource: vi.fn(),
}));
vi.mock('../codex-native-artifact-qualification.js', async (original) => ({
  ...(await original<typeof import('../codex-native-artifact-qualification.js')>()),
  assertQualifiedNativeMacExecutionArtifact: vi.fn(),
}));
vi.mock('../openai-account-key-authority.js', () => ({
  openAIAccountKeyAuthority: () => ({
    assertReady: async () => {},
    resolveKey: async () => 'synthetic-api-key',
  }),
}));
const cleanup: Array<() => void | Promise<void>> = [];
const revocations = new EventStore(':memory:');
setAuthRevocationStore(revocations);
afterAll(() => revocations.close());
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
vi.setConfig({ testTimeout: 30000 });
function controlledReceipt(context: NativeHostToolContext, events: EventStore, taskRoot: string) {
  const id = randomUUID(),
    directory = join(taskRoot, `candidate-${id}`);
  return {
    version: 1,
    request: {
      id,
      binding: context.session.accountBinding,
      runtimeBinding: events.getSessionRuntimeBinding(context.conversationId),
      conversationId: context.conversationId,
      runtimeId: context.runtimeId,
      nativeTarget: context.nativeTarget,
      prepareCallId: context.callId,
      requestHash: context.requestHash,
      taskRoot,
    },
    rootIdentity: { dev: 1, ino: 1 },
    directory,
    sourceDigest: 'a'.repeat(64),
    state: 'materialized',
    taskIdentity: {
      directory,
      featureBranch: 'mitzo/controlled',
      root: { dev: 1, ino: 2 },
      git: { dev: 1, ino: 3 },
    },
  };
}
it.runIf(process.platform === 'darwin')(
  'registers and dispatches API Prepare after cold resume by a new login and viewer detach without accepting JSON owners',
  async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw Error('No network/model calls');
      }),
    );
    const artifacts = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-prepare-registration-')));
    cleanup.push(() => rm(artifacts, { recursive: true, force: true }));
    const executable = join(artifacts, 'codex');
    const synthetic = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 1, 2, 3]);
    await writeFile(executable, synthetic, { mode: 0o755 });
    await writeFile(join(artifacts, 'codex-code-mode-host'), synthetic, { mode: 0o755 });
    const f = await localRepositoryNativeToolFixture(
      cleanup,
      async () => {
        throw Error('Public registration must own dispatch');
      },
      {
        registeredExecutablePath: executable,
        api: true,
        separateViewer: true,
        resumeFromPreviousLogin: true,
      },
    );
    // Existing fixture owns a separate real SQLite service. Bind the server
    // lookup to that EXACT original runtime owner; no product injection option.
    vi.spyOn(workspaceRuntime, 'getRepositoryWorkspaces').mockReturnValue(f.f.workspace);
    const tools = f.a.requests.find((request) => request.method === 'thread/start')!.params
      .dynamicTools as Array<{ name: string }>;
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        'PrepareLocalRepository',
        'DiscoverLocalRepository',
        'InspectLocalRepository',
      ]),
    );
    let original!: NativeHostToolContext;
    const witness = Object.freeze({ kind: 'absent' });
    const qualified = Object.freeze({ publicationPackedRefs: witness });
    vi.mocked(captureNativeLocalRepositoryPreparationSource).mockResolvedValue(qualified as never);
    vi.mocked(executeLocalRepositoryPreparation).mockImplementation(
      async (owners, raw, envelope) => {
        inputSchema.parse(raw); // Same existing decoder: JSON cannot supply owner ports.
        original = owners.context;
        expect(original.toolName).toBe('PrepareLocalRepository');
        expect(Object.isFrozen(original)).toBe(true);
        expect(original.session).toBe(f.a.session);
        const owner = captureNativeHostReadOwner(original)!;
        expect(owner.context).toBe(original);
        expect(owner.scope).toBe(original.nativeBaseReadScope);
        expect(owner.signal).toBe(original.signal);
        expect(original.signal).not.toBe(envelope.signal);
        expect(original.nativeBaseReadScope?.nativeTarget).toEqual(original.nativeTarget);
        const intent = Object.freeze({
          workspaceId: randomUUID(),
          sourcePath: (raw as { path: string }).path,
          taskRoot: f.f.reservation.taskRoot,
        });
        const options = Object.freeze({ deadline: envelope.deadline });
        expect(await owners.qualifySource(intent.sourcePath, original, intent, options)).toBe(
          qualified,
        );
        expect(captureNativeLocalRepositoryPreparationSource).toHaveBeenCalledWith(
          original,
          intent,
          options,
        );
        return controlledReceipt(original, f.f.events, f.f.reservation.taskRoot) as never;
      },
    );
    const bad = await f.a.call(
      {
        path: join(f.f.root, 'source'),
        context: { assertCurrentSync: 'forged' },
        deadline: Date.now() + 300000,
      },
      { tool: 'PrepareLocalRepository' },
    );
    expect(bad.response.success).toBe(false);
    expect(captureNativeLocalRepositoryPreparationSource).not.toHaveBeenCalled();
    // The HTTP startup operator and the phone's event connection are distinct.
    // Detaching the phone must not end an admitted native tool operation.
    f.detachViewer();
    const good = await f.a.call(
      { path: join(f.f.root, 'source') },
      { tool: 'PrepareLocalRepository' },
    );
    expect(
      good.response.success,
      JSON.stringify({
        value: good.value,
        operationCalls: vi.mocked(executeLocalRepositoryPreparation).mock.calls.length,
        sourceCalls: vi.mocked(captureNativeLocalRepositoryPreparationSource).mock.calls.length,
      }),
    ).toBe(true);
    expect(good.value).toMatchObject({
      state: 'materialized',
      directory: expect.stringContaining(f.f.reservation.taskRoot),
    });
    expect(Object.keys(good.value)).toEqual(['preparationId', 'directory', 'state']);
    expect(() => original.assertCurrentSync()).toThrow();
    expect(f.a.requests.filter((request) => request.method === 'turn/start')).toHaveLength(1);
    expect(f.permissions).toHaveLength(0); // Controlled operation: NOT permission acceptance.
  },
);
it.each(['mode', 'policy', 'role'] as const)(
  'withholds private adapter completion after genuine original %s changes during the operation',
  async (kind) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw Error('No network/model calls');
      }),
    );
    const f = await localPreparationNativeFixture(
      cleanup,
      async () => {
        throw Error('Original raw capture required');
      },
      {
        nativeBaseReads: true,
        executeOriginalCapture: (capture, input, signal) =>
          executeNativeLocalRepositoryPreparation(
            { capture, events: f.f.events, registry: f.registry, workspaces: f.f.workspace },
            input,
            signal,
          ),
      },
    );
    vi.mocked(executeLocalRepositoryPreparation).mockImplementation(async (owners) => {
      const original = owners.context;
      original.assertCurrentSync();
      if (kind === 'mode') f.a.session.mode = 'ask';
      else if (kind === 'policy') f.a.session.cwd = join(f.f.root, 'different-task');
      else
        retainTelosWorkRoleContext(f.f.events, f.a.sessionId, f.a.initial.lease.binding, {
          version: 1,
          itemId: 'retained-item',
          role: 'advisor',
          brief: {
            revision: 'r1',
            text: 'Current role',
            sha256: (await import('node:crypto'))
              .createHash('sha256')
              .update('Current role')
              .digest('hex'),
          },
          parentCriteria: [],
          overallGoal: { itemId: 'retained-item', revision: 'r1', text: 'Review' },
          sources: [],
          artifacts: [],
        });
      expect(() => original.assertCurrentSync()).toThrow();
      return controlledReceipt(original, f.f.events, f.f.reservation.taskRoot) as never;
    });
    const reply = await f.a.call({ path: join(f.f.root, 'source') });
    expect(reply.response.success).toBe(false);
    expect(f.a.requests.filter((request) => request.method === 'turn/start')).toHaveLength(1);
    expect(captureNativeLocalRepositoryPreparationSource).not.toHaveBeenCalled();
  },
);
