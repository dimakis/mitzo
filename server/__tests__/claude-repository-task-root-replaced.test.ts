import { resetOfflineUserEnvironment } from './fixtures/offline-user-home.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { chmod, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ownedVertexRuntimeFixture } from './fixtures/owned-local-vertex-runtime.js';
import {
  OrdinaryLocalVertexOwnedRuntime,
  type OrdinaryLocalVertexOwnedDispatch,
} from '../ordinary-local-vertex-owned-runtime.js';
import { runtimeFailureDiagnostics } from '../runtime-failure-diagnostics.js';

vi.mock('../mcp-config.js', () => ({ loadMcpServers: () => ({}) }));
// Same offline host harness as claude-repository-deploy-continuity.test.ts.
vi.mock('../claude-account-history.js', () => ({
  readClaudeAccountHistory: vi.fn(async (sessionId: string, cwd: string) => ({
    info: { sessionId, cwd },
    messages: [{ type: 'user', uuid: 'retained' }],
  })),
}));
vi.mock('../auth.js', async (original) => ({
  ...(await original<object>()),
  hasPersistentRevocationAuthority: () => true,
}));
vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({
  ...(await original<object>()),
  getSessionInfo: vi.fn(async (id: string, options: { dir: string }) => ({
    sessionId: id,
    cwd: options.dir,
    summary: 'Offline SDK history',
    lastModified: 1,
  })),
  getSessionMessages: vi.fn(async () => [
    { type: 'user', uuid: 'original-input', message: { role: 'user', content: 'retained input' } },
  ]),
}));
beforeEach(resetOfflineUserEnvironment);
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** A local-repository Claude chat whose first command ran, then went idle. */
async function idleChat() {
  const f = await ownedVertexRuntimeFixture(cleanups, {
    ordinaryPreparation: true,
    localRepository: true,
    chatRoute: true,
  });
  const dispatch = vi.fn<(input: OrdinaryLocalVertexOwnedDispatch) => Promise<void>>(
    async () => {},
  );
  const create = (commandId: string) => {
    const owner = new OrdinaryLocalVertexOwnedRuntime({
      enabled: true,
      eventStore: f.events,
      library: f.library,
      workspace: f.workspace,
      reservation: f.reservation,
      commandId,
      operatorConnectionId: f.dependencies.operatorConnectionId,
      signal: f.signal.signal,
      env: f.dependencies.env,
      dispatch,
      dispatchContinuation: dispatch,
    });
    cleanups.push(() => owner.close());
    return owner;
  };
  const first = create(f.request.clientMsgId);
  await expect(first.admit(f.request)).resolves.toEqual({ dispatched: true });
  first.commandTerminal(f.request.clientMsgId);
  first.close();
  return { f, create, dispatch };
}
async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(Error);
  return runtimeFailureDiagnostics(error);
}

it('resumes an idle repository chat cold when its task root is intact', async () => {
  const { f, create, dispatch } = await idleChat();
  await expect(create('cold').admitResume({ ...f.request, clientMsgId: 'cold' })).resolves.toEqual({
    dispatched: true,
  });
  expect(dispatch).toHaveBeenCalledTimes(2);
});

// Problem B (chat 490201e1): the resume was refused only as
// workspace.root_identity, which cannot distinguish a replaced shared task
// root (`.claude/repository-tasks` was observed recreated on the host) from a
// moved, missing or re-permissioned one. The identity check is not relaxed.
it('names a replaced task root precisely and keeps the conversation readable', async () => {
  const { f, create, dispatch } = await idleChat();
  const taskRoot = f.reservation.taskRoot;
  const previous = `${taskRoot}.previous`;
  await rename(taskRoot, previous);
  await mkdir(taskRoot, { mode: 0o700 });
  for (const entry of await readdir(previous))
    await rename(join(previous, entry), join(taskRoot, entry));
  await rm(previous, { recursive: true });
  const diagnostics = await refusal(
    create('replaced').admitResume({ ...f.request, clientMsgId: 'replaced' }),
  );
  expect(diagnostics.failedCheck).toBe('workspace.root_identity.replaced');
  expect(diagnostics.authorityChecks).toContain('workspace.root_identity');
  expect(dispatch).toHaveBeenCalledTimes(1);
  // Refused before admission: nothing to replay, and saved history stays readable.
  expect(f.events.getSendCommand('replaced')).toBeUndefined();
  expect(f.events.getSession(f.reservation.conversationId)).toBeDefined();
  expect(f.events.getOrdinaryLocalVertexCustody(f.reservation.conversationId)).toBeDefined();
});

it('names a missing task root precisely', async () => {
  const { f, create } = await idleChat();
  await rename(f.reservation.taskRoot, `${f.reservation.taskRoot}.moved`);
  cleanups.push(() => rm(`${f.reservation.taskRoot}.moved`, { recursive: true, force: true }));
  const diagnostics = await refusal(
    create('missing').admitResume({ ...f.request, clientMsgId: 'missing' }),
  );
  expect(diagnostics.failedCheck).toBe('workspace.root_identity.missing');
  expect(diagnostics.causeCode).toBe('ENOENT');
});

it('keeps refusing a task root replaced by a symlink to the original directory', async () => {
  const { f, create } = await idleChat();
  const { symlink } = await import('node:fs/promises');
  const original = `${f.reservation.taskRoot}.original`;
  await rename(f.reservation.taskRoot, original);
  await symlink(original, f.reservation.taskRoot);
  cleanups.push(async () => {
    await rm(f.reservation.taskRoot, { force: true });
    await rename(original, f.reservation.taskRoot);
  });
  const diagnostics = await refusal(
    create('link').admitResume({ ...f.request, clientMsgId: 'link' }),
  );
  expect(diagnostics.failedCheck).toBe('workspace.root_identity.symlink');
  await chmod(original, 0o700);
});
