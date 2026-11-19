import { resetOfflineUserEnvironment } from './fixtures/offline-user-home.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ownedVertexRuntimeFixture } from './fixtures/owned-local-vertex-runtime.js';
import {
  ClaudeSubscriptionCustody,
  claudeSdkInstallation,
} from '../claude-subscription-custody.js';
import {
  OrdinaryLocalVertexOwnedRuntime,
  type OrdinaryLocalVertexOwnedDispatch,
} from '../ordinary-local-vertex-owned-runtime.js';
import { OrdinaryLocalWorkspaceOwner } from '../ordinary-local-workspace-owner.js';

vi.mock('../mcp-config.js', () => ({ loadMcpServers: () => ({}) }));
// Same offline host harness as ordinary-local-vertex-owned-runtime.test.ts.
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

// A deploy installs the SDK binary under a new release path. An idle Personal
// Claude repository chat must continue on that release, while its account,
// plan and config root stay pinned.
async function deployedChat(legacyProof: boolean) {
  const capture = ClaudeSubscriptionCustody.capture;
  vi.spyOn(ClaudeSubscriptionCustody, 'capture').mockImplementation((env) =>
    capture(env, claudeSdkInstallation.executable()!),
  );
  vi.spyOn(ClaudeSubscriptionCustody.prototype, 'verify').mockResolvedValue();
  // Releases before this fix digested the whole snapshot, binary included.
  const legacy = legacyProof
    ? vi.spyOn(ClaudeSubscriptionCustody.prototype, 'accountIdentity').mockImplementation(function (
        this: ClaudeSubscriptionCustody,
      ) {
        return this.snapshot() as ReturnType<ClaudeSubscriptionCustody['accountIdentity']>;
      })
    : undefined;
  const f = await ownedVertexRuntimeFixture(cleanups, {
    personal: true,
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
  legacy?.mockRestore();
  const custody = f.events.getOrdinaryLocalVertexCustody(f.reservation.conversationId)!;
  expect(custody.credentialAuthority).toMatchObject({
    kind: 'claude-host-login',
    executable: { path: f.personalExecutable },
  });
  // Deploy: this release installs its own binary under a new path, and the
  // previous release (whose binary the chat was admitted with) is pruned.
  const release = join(f.root, 'release-2');
  await mkdir(release, { mode: 0o700 });
  const installed = join(release, 'claude');
  await writeFile(installed, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  await rm(f.personalExecutable);
  vi.mocked(claudeSdkInstallation.executable).mockReturnValue(installed);
  return { f, create, dispatch, custody };
}

// Runs first in this file: the legacy proof is matched against the stored
// custody through the server's event store, which binds REPO_PATH on first use.
it('continues a chat whose proof an earlier release digested with that release binary', async () => {
  const { f, create, dispatch, custody } = await deployedChat(true);
  await new OrdinaryLocalWorkspaceOwner(f.workspace, 'repository', f.reservation).revalidate(
    f.signal.signal,
  );
  await expect(create('cold').admitResume({ ...f.request, clientMsgId: 'cold' })).resolves.toEqual({
    dispatched: true,
  });
  expect(dispatch).toHaveBeenCalledTimes(2);
  // Durable custody is unchanged; only this process runs the installed binary.
  expect(f.events.getOrdinaryLocalVertexCustody(f.reservation.conversationId)).toEqual(custody);
});

it('continues an idle chat after a deploy installs the SDK binary at a new path', async () => {
  const { f, create, dispatch } = await deployedChat(false);
  await expect(create('cold').admitResume({ ...f.request, clientMsgId: 'cold' })).resolves.toEqual({
    dispatched: true,
  });
  expect(dispatch).toHaveBeenCalledTimes(2);
});

it('still refuses a replaced Claude config root after a deploy', async () => {
  const { f, create } = await deployedChat(false);
  const config = join(f.root, 'personal-claude');
  // Keep the original directory alive until its replacement exists. Linux
  // filesystems immediately reuse a freed inode number, so delete-then-create
  // can yield an identical dev/ino and not model a replacement at all.
  const original = `${config}.original`;
  await rename(config, original);
  await mkdir(config, { mode: 0o700 });
  await rm(original, { recursive: true });
  await expect(
    create('changed').admitResume({ ...f.request, clientMsgId: 'changed' }),
  ).rejects.toThrow();
  expect(f.events.getSendCommand('changed')).toBeUndefined();
});
