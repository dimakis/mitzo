import { materializePreparedRepositoryFixture } from './materialized-prepared-repository.js';
import { createHash } from 'node:crypto';
import { nativeToolDefinitions } from '../../native-tool-executor.js';
import { localEfficiencyToolDefinitions } from '../../local-agent-efficiency.js';
import { bindAgentLibraryTransport } from '../../agent-library-transport.js';
import { codexDynamicToolsOption } from '../../codex-ordinary-packet.js';
import { afterAll, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { ownedRuntimeFixture } from './owned-local-codex-runtime.js';
import { fixtureReadAnchor, fixtureReadDescriptor } from './local-repository-read-owner.js';
import { OrdinaryLocalCodexOwnedRuntime } from '../../ordinary-local-codex-owned-runtime.js';
import { CodexConversationStore } from '../../codex-conversation-store.js';
import { codexNativeExecutionPolicy } from '../../codex-native-execution-policy.js';
import { withPreparedRepositoryBarrierReadScope } from '../../prepared-repository-barrier-read.js';

vi.mock('../../auth.js', async (original) => ({
  ...(await original<typeof import('../../auth.js')>()),
  hasPersistentRevocationAuthority: () => true,
}));
const physical = vi.hoisted(() => ({ reader: vi.fn(), creation: vi.fn() }));
// Explicit facade exports avoid loading cyclic consumers via importActual before
// Vitest installs the controlled reader. No real native/SRT read may escape.
vi.mock('../../local-repository-native-read.js', () => ({
  captureNativeReaderPathAuthorization: () => undefined,
  preparedRepositoryValidationReadMs: 60000,
  capturePreparedRepositoryReader: physical.reader,
  captureNativeLocalRepositoryReader: physical.reader,
}));
vi.mock('../../mcp-config.js', () => ({ loadMcpServers: () => ({}) }));
vi.mock('../../openai-account-key-authority.js', () => ({
  openAIAccountKeyAuthority: () => ({
    assertReady: async () => {},
    resolveKey: async (accountId: string) => {
      if (accountId !== 'work') throw Error('Offline API account mismatch');
      return 'synthetic-api-key';
    },
  }),
}));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => {
    throw Error('Offline fixture forbids SDK/model calls');
  },
  listSessions: () => [],
}));
// Synthetic frozen executable classification only; real artifact and SRT
// qualification remain separate. All native provider RPC is controlled below.
vi.mock('../../codex-native-artifact-qualification.js', async (original) => ({
  ...(await original<typeof import('../../codex-native-artifact-qualification.js')>()),
  assertQualifiedNativeMacExecutionArtifact: vi.fn(),
}));
vi.mock('../../qualified-local-repository-task.js', async (original) => ({
  ...(await original<typeof import('../../qualified-local-repository-task.js')>()),
  captureQualifiedLocalRepositoryTask: physical.creation,
}));
const cleanups: Array<() => void | Promise<void>> = [];
// Authentication retains ONE immutable persistent store. Keep the real public
// chat store AND its owning scratch fixture alive until the file finishes;
// later cases must not inherit a closed store or replace its genuine owner.
const publicAuthCleanups: Array<() => void | Promise<void>> = [];
const publicNativeStores = new Set<CodexConversationStore>();
let publicEventPath: string | undefined;
afterAll(async () => {
  for (const store of publicNativeStores) store.close();
  for (const close of publicAuthCleanups.splice(0).reverse()) await close();
});
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
vi.setConfig({ testTimeout: 90000 }); // Default focused-case bound; compound journeys map their full phases below.
const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    '/usr/bin/git',
    ['-C', cwd, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args],
    {
      encoding: 'utf8',
      env: {
        PATH: '/usr/bin:/bin',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
      },
    },
  ).trim();

async function materializePreparation(
  f: Awaited<ReturnType<typeof ownedRuntimeFixture>>,
  first: import('../../ordinary-local-codex-owned-runtime.js').OrdinaryLocalCodexOwnedDispatch,
  source: import('../../codex-conversation-store.js').CodexNativeTurnTarget,
) {
  return materializePreparedRepositoryFixture(cleanups, f, first, source);
}

/** Real runtime/bootstrap/login/selection/admission, SQLite producer+CAS+FIFO.
 * Creation actor is synthetic and physical read transport is the controlled
 * descriptor fixture, NOT SRT/native actor qualification or a real model call. */
async function fixture(
  chatRoute = false,
  operatorLifetimeMs?: number,
  images?: Array<{ data: string; mediaType: string }>,
  publicationFlow = false,
  api = false,
) {
  let operatorToken: string | undefined;
  const f = await ownedRuntimeFixture(chatRoute ? publicAuthCleanups : cleanups, {
    localRepository: true,
    api,
    chatRoute,
    ...(chatRoute && publicEventPath ? { eventStorePath: publicEventPath } : {}),
    operatorLifetimeMs,
    ...(publicationFlow
      ? {
          additionalModels: [
            { id: 'publication-model', label: 'Publication model', reasoningEfforts: ['high'] },
          ],
        }
      : {}),
    ...(chatRoute
      ? {
          tools: [
            'Bash',
            'Read',
            'Write',
            'Edit',
            ...(publicationFlow ? ['GitCommit', 'RequestGithubPublish'] : []),
          ].map((name) => ({
            id: `mitzo:${name}`,
            version: 1,
          })),
        }
      : {}),
  });
  const initialRequest = {
    ...f.request,
    payload: { ...f.request.payload, ...(images ? { images } : {}) },
  };
  if (chatRoute) {
    publicEventPath ??= join(f.root, '.mitzo', 'events.db');
    vi.stubEnv('MITZO_INTERNAL_TOKEN_PATH', join(f.root, 'internal-token'));
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw Error('No network/model calls in qualified cold fixture');
      }),
    );
    const chat = await import('../../chat.js');
    const { login, authenticateToken, setAuthRevocationStore } = await import('../../auth.js');
    setAuthRevocationStore(chat.eventStore);
    f.detach();
    operatorToken = (await login(process.env.AUTH_PASSPHRASE!))!;
    const auth = (await authenticateToken(operatorToken))!;
    cleanups.push(bindAgentLibraryTransport(f.dependencies.operatorConnectionId, auth));
    f.auth = auth;
    publicAuthCleanups.push(() => chat.eventStore.close());
  }
  const native = chatRoute
    ? (await import('../../codex-chat-session.js')).getCodexConversationStore()
    : new CodexConversationStore(join(f.root, 'native-transition.db'));
  if (chatRoute) publicNativeStores.add(native);
  else cleanups.push(() => native.close());
  native.create(f.reservation.conversationId, f.reservation.binding, f.reserved.directory!);
  const runtime = new OrdinaryLocalCodexOwnedRuntime({
    ...f.dependencies,
    nativeStore: native,
    dispatchContinuation: async (value) => {
      const input = {
        id: value.commandId,
        prompt: value.payload.text,
        intent: value.payload.intent,
        images: value.payload.images,
        model: value.expected.selection.model,
        reasoningEffort: value.expected.selection.thinking,
      };
      value.admission.assertBeforeEnqueue(input);
      native.enqueue(value.sessionId, value.lease.binding, input);
    },
    dispatch: async (value) => {
      await f.dispatch(value);
      value.admission.persistCustody(native);
      const input = {
        id: value.commandId,
        prompt: value.payload.text,
        intent: value.payload.intent,
        images: value.payload.images,
        model: value.expected.selection.model,
        reasoningEffort: value.expected.selection.thinking,
      };
      value.admission.assertBeforeEnqueue(input);
      native.enqueue(value.sessionId, value.lease.binding, input);
    },
  });
  cleanups.push(() => runtime.close());
  await runtime.admit(initialRequest);
  const first = f.dispatch.mock.calls[0][0],
    admission = first.admission;
  native.bindThread(
    first.sessionId,
    first.lease.binding,
    'thread',
    createHash('sha256')
      .update(
        JSON.stringify(
          codexDynamicToolsOption(
            chatRoute
              ? [
                  ...nativeToolDefinitions.filter(
                    (tool) =>
                      tool.name === 'AskUserQuestion' ||
                      (publicationFlow && tool.name === 'GitCommit'),
                  ),
                  ...(publicationFlow
                    ? [(await import('../../github-publishing-tool.js')).githubPublishingDefinition]
                    : []),
                  ...localEfficiencyToolDefinitions.filter((tool) => tool.name === 'SearchSkills'),
                ]
              : [],
          ),
        ),
      )
      .digest('hex'),
  );
  const command = native.claimNext(first.sessionId, first.lease.binding)!;
  admission.assertBeforeDispatch(command.id);
  const policy = () =>
    codexNativeExecutionPolicy({
      bindingRevision: first.lease.binding.profileRevision!,
      mode: 'agent',
      cwd: first.expected.workspace.cwd,
      readableRoots: ['/'],
      writableRoots: [first.expected.workspace.cwd],
      deniedRoots: [join(f.root, 'login'), join(f.root, 'custody')],
      writeProtectedRoots: [],
    });
  native.prepareNativeExecution(first.sessionId, first.lease.binding, command, 'thread', policy());
  native.recordNativeTurnAck(first.sessionId, first.lease.binding, command, 'thread', 'turn');
  native.acceptNativeExecution(first.sessionId, first.lease.binding, command, 'thread', 'turn');
  const source = Object.freeze({
    commandId: command.id,
    attempt: command.attempt,
    threadId: 'thread',
    turnId: 'turn',
    generation: 0,
  });
  const { record, request, taskIdentity } = await materializePreparation(f, first, source);
  physical.creation.mockImplementation(async () => {
    const task = structuredClone(taskIdentity);
    delete task.localSource;
    return task;
  });
  const disposals = vi.fn(async () => {});
  physical.reader.mockImplementation(async (readScope, options) => {
    await readScope.revalidate();
    return {
      deadline: options.deadline,
      signal: readScope.signal,
      deniedRoots: readScope.deniedRoots,
      assertReadable: async () => readScope.assertCurrentSync(),
      assertCurrentSync: () => readScope.assertCurrentSync(),
      revalidate: () => readScope.revalidate(),
      captureReadAnchor: fixtureReadAnchor,
      executeReadOperation: fixtureReadDescriptor,
      executeDirectoryVerification: (
        requests: Parameters<typeof fixtureReadDescriptor>[0][],
        signal: AbortSignal,
      ) => Promise.all(requests.map((request) => fixtureReadDescriptor(request, signal))),
      dispose: disposals,
    };
  });
  const identity = {
    ...source,
    callId: request.prepareCallId,
    toolName: 'PrepareLocalRepository' as const,
    requestHash: request.requestHash,
  };
  native.claimTool(
    first.sessionId,
    first.lease.binding,
    command.id,
    request.prepareCallId,
    identity,
  );
  native.recordToolResult(
    first.sessionId,
    first.lease.binding,
    command.id,
    request.prepareCallId,
    identity,
    { content: JSON.stringify({ preparationId: record.id }), isError: false },
  );
  native.finish(first.sessionId, first.lease.binding, command.id, 'completed', 'turn');
  let cwd = first.expected.workspace.cwd;
  const currentPolicy = () =>
    codexNativeExecutionPolicy({
      bindingRevision: first.lease.binding.profileRevision!,
      mode: 'agent',
      cwd,
      readableRoots: ['/'],
      writableRoots: [cwd],
      deniedRoots: [join(f.root, 'login'), join(f.root, 'custody')],
      writeProtectedRoots: [],
    });
  const owner = Object.freeze({
    signal: f.signal.signal,
    selectedPolicy: currentPolicy,
    assertCurrentSync: () => admission.assertCurrentSync(),
  });
  const conversation = vi.fn();
  const adopt = async () =>
    withPreparedRepositoryBarrierReadScope(
      currentPolicy(),
      source.commandId,
      {
        signal: f.signal.signal,
        selectedPolicy: currentPolicy,
        assertCurrentSync: () => admission.assertPreparedRepositoryBoundaryCurrentSync(),
        revalidate: () => admission.assertCurrent(),
      },
      (scope) => admission.adoptPreparedRepositoryAtBoundary(scope, source, conversation, owner),
    );
  return {
    ...f,
    request: initialRequest,
    operatorToken,
    runtime,
    native,
    first,
    admission,
    record,
    source,
    adopt,
    disposals,
    conversation,
    setCwd: (next: string) => {
      cwd = next;
    },
  };
}
export { fixture, physical, cleanups, git, materializePreparation };
