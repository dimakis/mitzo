import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { writeFile, readFile } from 'node:fs/promises';
import { AccountProfiles } from '../account-profiles.js';
import { credentials } from '../credentials.js';
import { ownedResponsesRuntimeFixture } from './fixtures/owned-local-responses-runtime.js';
import { OrdinaryLocalResponsesOwnedRuntime } from '../ordinary-local-responses-owned-runtime.js';
import { NativeResponsesStore } from '../native-responses-store.js';
import { OrdinaryLocalCodexSelectionOwner } from '../ordinary-local-codex-selection-owner.js';
const manager = vi.hoisted(() => ({
  manages: vi.fn(() => true),
  resolveKey: vi.fn(async () => 'offline-exact-key'),
}));
vi.mock('../connections-runtime.js', () => {
  const runtime = { openAIEnrollmentAuthority: manager };
  return { getConnectionsRuntime: () => runtime };
});
vi.mock('../auth.js', async (original) => ({
  ...(await original<object>()),
  hasPersistentRevocationAuthority: () => true,
}));
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  manager.manages.mockReturnValue(true);
  manager.resolveKey.mockClear();
});
async function fixture() {
  vi.spyOn(AccountProfiles.prototype, 'isEnrolledOpenAIAccount').mockReturnValue(true);
  const f = await ownedResponsesRuntimeFixture(cleanups, {});
  const native = new NativeResponsesStore(join(f.root, 'responses.db'));
  cleanups.push(() => native.close());
  const dispatch = vi.fn<
    (
      input: import('../ordinary-local-responses-owned-runtime.js').OrdinaryLocalResponsesOwnedDispatch,
    ) => Promise<void>
  >(async () => {});
  const create = (
    commandId: string = f.request.clientMsgId,
    operatorConnectionId: string = f.dependencies.operatorConnectionId,
  ) => {
    const owner = new OrdinaryLocalResponsesOwnedRuntime({
      enabled: true,
      eventStore: f.events,
      library: f.library,
      workspace: f.workspace,
      reservation: f.reservation,
      nativeStore: native,
      commandId,
      operatorConnectionId,
      signal: f.signal.signal,
      env: f.dependencies.env,
      dispatch,
      dispatchContinuation: dispatch,
    });
    for (const method of ['admit', 'admitContinuation', 'admitResume'] as const) {
      const original = owner[method].bind(owner);
      owner[method] = async (raw) => {
        const result = await original(raw);
        if (result.dispatched) await owner.claimNextCommand();
        return result;
      };
    }
    cleanups.push(() => owner.close());
    return owner;
  };
  return { f, native, dispatch, create };
}
it('claims independent checkout and freezes future settings while retaining native account and signed custody across cold resume', async () => {
  const { f, native, dispatch, create } = await fixture();
  const first = create();
  await expect(first.admit(f.request)).resolves.toEqual({ dispatched: true });
  const admitted = dispatch.mock.calls[0][0];
  expect(manager.resolveKey).not.toHaveBeenCalled();
  expect(admitted.binding).toEqual(f.reservation.binding);
  first.commandTerminal(f.request.clientMsgId);
  native.save(admitted.sessionId, admitted.binding, {
    status: 'idle',
    history: [{ role: 'user', content: 'first edit' }],
  });
  await writeFile(join(admitted.workspace.directory!, 'retained.txt'), 'task edit');
  const next = {
    ...f.request,
    clientMsgId: 'next',
    selection: { ...f.request.selection, model: 'next-model', thinking: 'high' },
  };
  await expect(first.admitContinuation(next)).resolves.toEqual({ dispatched: true });
  expect(dispatch.mock.calls[1][0].expected.selection).toMatchObject({
    model: 'next-model',
    thinking: 'high',
  });
  expect(dispatch.mock.calls[1][0].binding.model).toBe('fixture-model');
  first.assertStart('next');
  expect(await first.resolveKey('next')).toBe('offline-exact-key');
  first.commandTerminal('next');
  first.close();
  const cold = create('cold');
  await expect(cold.admitResume({ ...next, clientMsgId: 'cold' })).resolves.toEqual({
    dispatched: true,
  });
  expect(await readFile(join(admitted.workspace.directory!, 'retained.txt'), 'utf8')).toBe(
    'task edit',
  );
  expect(native.load(admitted.sessionId, admitted.binding)?.history[0].content).toBe('first edit');
  expect(native.readOrdinaryCustody(admitted.sessionId, admitted.binding)?.authSessionId).toBe(
    f.auth.id,
  );
});

it('admits an existing configured API account without re-enrollment and resolves its original credential', async () => {
  const { f, create, dispatch } = await fixture();
  vi.spyOn(AccountProfiles.prototype, 'isEnrolledOpenAIAccount').mockReturnValue(false);
  const read = vi.spyOn(credentials, 'resolve').mockResolvedValue('existing-offline-key');
  const owner = create();
  await expect(owner.admit(f.request)).resolves.toEqual({ dispatched: true });
  expect(dispatch.mock.calls[0][0].binding).toEqual(f.reservation.binding);
  // Admission does not read a key or perform a validation/model request.
  expect(manager.resolveKey).not.toHaveBeenCalled();
  await expect(owner.resolveKey(f.request.clientMsgId)).resolves.toBe('existing-offline-key');
  expect(read).toHaveBeenCalledWith(f.configuration[0].credentialRef);
});

it('claims the next accepted FIFO command when cancellation changes the head during its authority await', async () => {
  const { f, native, create } = await fixture();
  const owner = create();
  await owner.admit(f.request);
  await owner.admitContinuation({ ...f.request, clientMsgId: 'cancelled-head' });
  await owner.admitContinuation({
    ...f.request,
    clientMsgId: 'retained-tail',
    selection: { ...f.request.selection, model: 'next-model', thinking: 'high' },
  });
  owner.commandTerminal(f.request.clientMsgId);
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = OrdinaryLocalCodexSelectionOwner.prototype.assertCurrent;
  vi.spyOn(OrdinaryLocalCodexSelectionOwner.prototype, 'assertCurrent').mockImplementationOnce(
    async function (this: OrdinaryLocalCodexSelectionOwner, expected) {
      entered();
      await gate;
      await original.call(this, expected);
    },
  );
  const claim = owner.claimNextCommand();
  await waiting;
  expect(
    native.cancelQueuedCommand(
      f.reservation.conversationId,
      f.reservation.binding,
      'cancelled-head',
    ),
  ).toBe('cancelled');
  release();
  await expect(claim).resolves.toBe('retained-tail');
  expect(owner.snapshot('retained-tail').expected.selection).toMatchObject({
    model: 'next-model',
    thinking: 'high',
  });
  expect(
    f.events.getExecutionAdmission(f.reservation.conversationId, 'cancelled-head'),
  ).toBeUndefined();
});

it('acknowledges the original consumed receipt at full queue capacity while refusing new unadmitted work', async () => {
  const { f, native, create } = await fixture();
  const owner = create();
  await owner.admit(f.request);
  let last: Omit<typeof f.request, 'clientMsgId'> & { clientMsgId: string } = f.request;
  for (let i = 0; i < 32; i++) {
    last = {
      ...f.request,
      clientMsgId: `full-${i}`,
      payload: { ...f.request.payload, text: `Accepted ${i}` },
    };
    await owner.admitContinuation(last);
  }
  expect(native.queue(f.reservation.conversationId, f.reservation.binding).queued).toHaveLength(32);
  const saved = f.events.getOrdinaryLocalResponsesCommandAdmission(last.clientMsgId);
  await expect(owner.admitContinuation(last)).resolves.toEqual({ dispatched: false });
  expect(f.events.getOrdinaryLocalResponsesCommandAdmission(last.clientMsgId)).toEqual(saved);
  await expect(
    owner.admitContinuation({ ...f.request, clientMsgId: 'overflow' }),
  ).rejects.toThrow();
  expect(f.events.getOrdinaryLocalResponsesCommandAdmission('overflow')).toBeUndefined();
}, 15000);

it('closes parallel MCP startup peers without publishing when enrolled account authority changes during listTools', async () => {
  const { f, native, create, dispatch } = await fixture();
  const { SessionRegistry } = await import('@mitzo/harness');
  const { AsyncQueue } = await import('../async-queue.js');
  const { openResponsesChat } = await import('../responses-chat-session.js');
  const mcp = await import('../codex-mcp-tools.js');
  const actual = mcp.connectCodexMcpTools;
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const peers = [0, 1].map(() => ({
    listTools: async () => {
      entered();
      await gate;
      return { tools: [] };
    },
    callTool: vi.fn(),
    close: vi.fn(async () => {}),
  }));
  let nextPeer = 0;
  const connects = vi.fn(async () => peers[nextPeer++]);
  const published = vi.fn();
  vi.spyOn(mcp, 'connectCodexMcpTools').mockImplementation((configs, options) =>
    actual(configs, { ...options, connect: connects }),
  );
  const registry = new SessionRegistry();
  const input = new AsyncQueue<{ message: { content: string } }>();
  const owner = create();
  dispatch.mockImplementation(async (selected) => {
    registry.register('startup', {
      transport: { send() {}, isOpen: () => true },
      abortController: new AbortController(),
      mode: 'ask',
      sessionId: selected.sessionId,
      cwd: selected.expected.workspace.cwd,
      sessionAllowList: new Set(),
    });
    const query = await openResponsesChat({
      commandAuthority: owner,
      assertStartupCurrent: () => owner.assertSetupSync(selected.commandId),
      conversationId: selected.sessionId,
      binding: selected.binding,
      session: registry.get('startup')!,
      registry,
      input,
      store: native,
      systemPrompt: selected.payload.systemPrompt,
      env: {},
      mcpServers: {
        first: { command: 'offline-first', args: [] },
        second: { command: 'offline-second', args: [] },
      },
    });
    cleanups.push(() => query.close());
    published(query);
  });
  const result = owner.admit(f.request);
  await waiting;
  expect(connects).toHaveBeenCalledTimes(2);
  manager.manages.mockReturnValue(false);
  release();
  await expect(result).rejects.toThrow();
  expect(connects).toHaveBeenCalledTimes(2);
  for (const peer of peers) {
    expect(peer.close).toHaveBeenCalledOnce();
    expect(peer.callTool).not.toHaveBeenCalled();
  }
  expect(published).not.toHaveBeenCalled();
  expect(f.events.getOrdinaryLocalResponsesCommandAdmission(f.request.clientMsgId)?.state).toBe(
    'uncertain',
  );
  expect(manager.resolveKey).not.toHaveBeenCalled();
});
it('retains uncertainty and forbids provider preparation/credentials when dispatch fails', async () => {
  const { f, create, dispatch } = await fixture();
  dispatch.mockRejectedValueOnce(Error('offline enqueue failure'));
  const owner = create();
  await expect(owner.admit(f.request)).rejects.toThrow();
  expect(f.events.getOrdinaryLocalResponsesCommandAdmission(f.request.clientMsgId)?.state).toBe(
    'uncertain',
  );
  expect(() => owner.assertStart(f.request.clientMsgId)).toThrow();
  expect(manager.resolveKey).not.toHaveBeenCalled();
});
it('refuses controller loss and legacy cold history without credential fallback', async () => {
  const { f, native, create } = await fixture();
  manager.manages.mockReturnValue(false);
  await expect(create().admit(f.request)).rejects.toThrow();
  expect(f.events.getOrdinaryLocalResponsesCommandAdmission(f.request.clientMsgId)).toBeUndefined();
  manager.manages.mockReturnValue(true);
  native.begin(f.reservation.conversationId, f.reservation.binding);
  await expect(create('cold').admitResume({ ...f.request, clientMsgId: 'cold' })).rejects.toThrow();
  expect(manager.resolveKey).not.toHaveBeenCalled();
});

it('keeps real edit/test/build results and the same mocked draft publication through cold resume with an independent second checkout', async () => {
  const { f, native, dispatch, create } = await fixture();
  const first = create();
  await first.admit(f.request);
  const selected = dispatch.mock.calls[0][0],
    cwd = selected.workspace.directory!;
  first.assertStart(f.request.clientMsgId);
  const source = join(cwd, 'labels.ts'),
    test = join(cwd, 'labels.test.mjs');
  await writeFile(source, 'export const countLabels = (items: string[]) => items.length;');
  await writeFile(
    test,
    "import { countLabels } from './labels.mjs'; import assert from 'node:assert/strict'; import test from 'node:test'; test('counts distinct nonblank labels', () => assert.equal(countLabels(['one',' one ','','two']),2));",
  );
  const build = () =>
    execFileSync(
      join(process.cwd(), 'node_modules/esbuild/bin/esbuild'),
      [
        source,
        '--bundle',
        '--platform=node',
        '--format=esm',
        `--outfile=${join(cwd, 'labels.mjs')}`,
      ],
      { cwd, stdio: 'pipe' },
    );
  const verify = () => execFileSync(process.execPath, ['--test', test], { cwd, stdio: 'pipe' });
  build();
  expect(verify).toThrow();
  await first.assertEffect(f.request.clientMsgId);
  await writeFile(
    source,
    'export const countLabels = (items: string[]) => new Set(items.map(item => item.trim()).filter(Boolean)).size;',
  );
  build();
  expect(verify).not.toThrow();
  const publish = vi.fn(async (branch: string, contents: string) => ({
    draftPr: 'offline-draft-17',
    branch,
    contents,
  }));
  const initialPublication = await publish(
    selected.workspace.featureBranch,
    await readFile(source, 'utf8'),
  );
  native.save(selected.sessionId, selected.binding, {
    status: 'idle',
    history: [{ role: 'user', content: 'implemented first edit/test/build' }],
  });
  first.commandTerminal(f.request.clientMsgId);
  first.close();
  const cold = create('cold-development');
  const request = {
    ...f.request,
    clientMsgId: 'cold-development',
    selection: { ...f.request.selection, model: 'next-model', thinking: 'high' },
  };
  await cold.admitResume(request);
  cold.assertStart(request.clientMsgId);
  await cold.assertEffect(request.clientMsgId);
  const contents = (await readFile(source, 'utf8')).replace(
    'item.trim()',
    'item.trim().toLowerCase()',
  );
  await writeFile(source, contents);
  await writeFile(
    test,
    "import { countLabels } from './labels.mjs'; import assert from 'node:assert/strict'; import test from 'node:test'; test('counts case insensitive distinct nonblank labels', () => assert.equal(countLabels(['one',' ONE ','','two']),2));",
  );
  build();
  expect(verify).not.toThrow();
  const secondPublication = await publish(
    dispatch.mock.calls[1][0].workspace.featureBranch,
    contents,
  );
  expect(secondPublication.draftPr).toBe(initialPublication.draftPr);
  expect(secondPublication.branch).toBe(initialPublication.branch);
  expect(secondPublication.contents).not.toBe(initialPublication.contents);
  cold.commandTerminal(request.clientMsgId);
  cold.close();
  const separate = await fixture(),
    other = separate.create();
  await other.admit(separate.f.request);
  const otherCwd = separate.dispatch.mock.calls[0][0].workspace.directory!;
  expect(otherCwd).not.toBe(cwd);
  expect(await readFile(join(otherCwd, 'task.txt'), 'utf8')).toBe('accepted source');
  await expect(readFile(join(otherCwd, 'labels.ts'), 'utf8')).rejects.toThrow();
  expect(separate.f.reservation.binding).toEqual(f.reservation.binding);
  expect(native.load(selected.sessionId, selected.binding)?.history[0].content).toBe(
    'implemented first edit/test/build',
  );
});
it('refuses another signed login and preserves unresolved prior provider execution before any new receipt', async () => {
  const { f, native, create, dispatch } = await fixture();
  const first = create();
  await first.admit(f.request);
  const admitted = dispatch.mock.calls[0][0];
  native.save(admitted.sessionId, admitted.binding, {
    status: 'interrupted',
    history: [{ role: 'user', content: 'pending action outcome unknown' }],
  });
  first.commandTerminal(f.request.clientMsgId);
  first.close();
  const { bindAgentLibraryTransport } = await import('../agent-library-transport.js');
  const release = bindAgentLibraryTransport('foreign-login', {
    id: 'different-signed-login',
    expiresAt: Date.now() + 60000,
  });
  cleanups.push(release);
  await expect(
    create('foreign-command', 'foreign-login').admitResume({
      ...f.request,
      clientMsgId: 'foreign-command',
    }),
  ).rejects.toThrow();
  expect(f.events.getOrdinaryLocalResponsesCommandAdmission('foreign-command')).toBeUndefined();
  const old = f.events.beginExecution(
    admitted.sessionId,
    undefined,
    'pending-api-command',
    'offline-pending-fingerprint',
  );
  await expect(
    create('cold-unresolved').admitResume({ ...f.request, clientMsgId: 'cold-unresolved' }),
  ).rejects.toThrow();
  expect(f.events.getOrdinaryLocalResponsesCommandAdmission('cold-unresolved')).toBeUndefined();
  expect(f.events.getExecutionAdmission(admitted.sessionId, 'pending-api-command')?.token).toEqual(
    old.token,
  );
  expect(f.events.getExecutionTerminalReason(old.token)).toBeUndefined();
  expect(native.load(admitted.sessionId, admitted.binding)?.history[0].content).toBe(
    'pending action outcome unknown',
  );
  expect(manager.resolveKey).not.toHaveBeenCalled();
});

it('admits the canonical builtin under its own namespace with the actual Responses owner', async () => {
  const { f, dispatch, create } = await fixture();
  const builtin = (await import('../ordinary-codex-agent-profile.js')).ordinaryCodexAgentProfiles(
    [],
  )[0];
  await expect(
    create().admit({
      ...f.request,
      selection: {
        ...f.request.selection,
        agent: { kind: 'builtin', profileId: builtin.profileId, revision: builtin.revision },
      },
    }),
  ).resolves.toEqual({ dispatched: true });
  expect(dispatch.mock.calls[0][0].expected.agentProfile).toEqual(builtin);
  expect(
    f.events.getOrdinaryLocalResponsesCommandAdmission(f.request.clientMsgId)?.selection.agent.kind,
  ).toBe('builtin');
});
