import { afterEach, expect, it, vi } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentLibraryStore } from '../agent-library-store.js';
import { EventStore } from '../event-store.js';
import { AccountProfiles } from '../account-profiles.js';
import { createOutputContributors } from '../output-contributors.js';
import { createOutputContributorRouter } from '../output-contributor-routes.js';
import { outputContextPackageDigest } from '../session-output-routes.js';
import { login, authenticateToken, operatorAuthMiddleware, revokeAuthSession } from '../auth.js';
import {
  readAgentLibraryProfile,
  bindAgentLibraryTransport,
  captureAgentLibraryAuthorization,
} from '../agent-library-transport.js';

const owner = vi.hoisted(() => ({
  client: null as null | {
    request: ReturnType<typeof vi.fn>;
    invalidate: ReturnType<typeof vi.fn>;
  },
}));
vi.mock('../symposium-custodian-mode.js', async (original) => ({
  ...(await original<typeof import('../symposium-custodian-mode.js')>()),
  get custodianControllerClient() {
    return owner.client;
  },
}));
let library: AgentLibraryStore;
vi.mock('../agent-library-runtime.js', () => ({ getAgentLibrary: () => library }));
const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup.splice(0).forEach((fn) => fn());
  owner.client = null;
  vi.restoreAllMocks();
});

async function verifiedLogin() {
  const token = await login(process.env.AUTH_PASSPHRASE!);
  if (!token) throw Error('Offline login fixture failed');
  const auth = await authenticateToken(token);
  if (!auth) throw Error('Offline authentication fixture failed');
  return { token, auth };
}
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'contributor-profile-auth-'));
  const store = new EventStore(join(root, 'events.db'));
  library = new AgentLibraryStore(join(root, 'library.db'));
  const localLibrary = library;
  cleanup.push(() => {
    localLibrary.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  store.upsertSession({ sessionId: 'source', conversationSource: 'mitzo', cwd: root });
  for (const event of [
    { type: 'message_start', messageId: 'draft' },
    { type: 'block_start', messageId: 'draft', blockId: 'text', blockType: 'text' },
    { type: 'block_delta', messageId: 'draft', blockId: 'text', delta: 'Selected draft' },
    { type: 'block_end', messageId: 'draft', blockId: 'text', blockType: 'text' },
    { type: 'message_end', messageId: 'draft' },
  ])
    store.append('source', event.type, event);
  const output = store.registerSessionOutput('source', {
    requestId: 'keep',
    title: 'Draft',
    source: store.listSessionOutputCandidates('source')[0].source,
  });
  const accounts = new AccountProfiles(
    [
      {
        id: 'personal',
        label: 'Personal',
        provider: 'openai-codex',
        credentialRef: join(root, 'synthetic-account'),
        email: 'offline@example.invalid',
        planType: 'plus',
        models: [{ id: 'offline-model', label: 'Offline' }],
      },
    ],
    { codexEnabled: true },
  );
  const definition = {
    name: 'Saved writer',
    role: 'coder',
    instructions: 'Use saved writer guidance.',
    expectedOutput: 'Draft',
    acceptanceCriteria: ['Use the selected output'],
    modelPolicyRole: 'coder',
  };
  function publish(profileId: string, selected = definition, catalogOwner = 'user') {
    library.saveDraft(catalogOwner, {
      profileId,
      expectedVersion: 0,
      expectedRevision: 0,
      idempotencyKey: `draft-${profileId}`,
      definition: selected,
    });
    return library.publish(catalogOwner, {
      profileId,
      expectedVersion: 1,
      idempotencyKey: `publish-${profileId}`,
    });
  }
  const profile = publish('writer');
  const port = {
    startChat: vi.fn(async () => {
      throw Error('No provider calls in profile admission');
    }),
    stopChat: vi.fn(),
  };
  const selectors: Array<string | undefined> = [];
  const service = createOutputContributors({
    store,
    databasePath: join(root, 'events.db'),
    currentAccounts: () => accounts,
    port,
    workspaceForSession: () => ({ cwd: root }),
    resolveProfile: (selection, connectionId) => {
      selectors.push(connectionId);
      return readAgentLibraryProfile(selection, connectionId);
    },
  });
  cleanup.unshift(() => service.close());
  const allocate = vi.spyOn(store, 'createSymposiumSession');
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(
    '/api/sessions/:id/contributors',
    operatorAuthMiddleware,
    createOutputContributorRouter({ service, hasSession: (id) => id === 'source' }),
  );
  const { token, auth } = await verifiedLogin();
  const input = {
    requestId: 'add',
    outputId: output.outputId,
    outputRevision: 1,
    contextPackageDigest: outputContextPackageDigest('source', output),
    accountId: 'personal',
    model: 'offline-model',
    label: 'Writer',
    instructions: '',
    mode: 'ask',
    profileSelection: { profileId: profile.profileId, revision: profile.revision },
  };
  // apiFetch's UI shape: ordinary interactive cookie and Content-Type; no connection header.
  const post = (body: Record<string, unknown> = input) =>
    request(app)
      .post('/api/sessions/source/contributors')
      .set('Cookie', `cc_auth=${token}`)
      .set('Content-Type', 'application/json')
      .send(body);
  return { app, store, profile, publish, input, post, auth, allocate, port, selectors };
}

it('creates saved guidance through the actual cookie-authenticated UI shape and real profile resolver', async () => {
  const f = await fixture();
  const response = await f.post();
  expect(response.status).toBe(200);
  expect(response.body.contributor.status).toBe('idle');
  const config = JSON.parse(f.store.getSession(response.body.contributor.id)!.symposiumConfig!);
  expect(config.seats[0].systemPrompt).toBe('Use saved writer guidance.');
  expect(f.allocate).toHaveBeenCalledOnce();
  expect(f.port.startChat).not.toHaveBeenCalled();
  expect(() => captureAgentLibraryAuthorization(f.selectors[0])).toThrow(/authentication/);
});

it('preserves Default Mitzo creation on the existing source/account without a transport header', async () => {
  const f = await fixture();
  const input: Record<string, unknown> = { ...f.input };
  delete input.profileSelection;
  const response = await f.post(input);
  expect(response.status).toBe(200);
  expect(f.selectors).toEqual([]);
  expect(f.port.startChat).not.toHaveBeenCalled();
});

it('does not let an authenticated caller borrow another operator through its connection header', async () => {
  const f = await fixture();
  const foreign = await verifiedLogin();
  cleanup.unshift(bindAgentLibraryTransport('foreign-connection', foreign.auth));
  const privateProfile = f.publish('private-writer', undefined, 'foreign-owner');
  owner.client = {
    invalidate: vi.fn(),
    request: vi.fn(async (command) =>
      command.authorization.id === foreign.auth.id
        ? { status: 200, body: privateProfile }
        : { status: 403, body: {} },
    ),
  };
  const response = await f
    .post({
      ...f.input,
      profileSelection: { profileId: privateProfile.profileId, revision: privateProfile.revision },
    })
    .set('x-connection-id', 'foreign-connection');
  expect(response.status).toBe(409);
  expect(owner.client.request).toHaveBeenCalledWith(
    expect.objectContaining({ authorization: f.auth }),
    undefined,
    expect.any(AbortSignal),
  );
  expect(f.allocate).not.toHaveBeenCalled();
  expect(f.port.startChat).not.toHaveBeenCalled();
});

it('refuses an unverified caller even when it supplies a live operator connection selector', async () => {
  const f = await fixture();
  cleanup.unshift(bindAgentLibraryTransport('verified-connection', f.auth));
  const response = await request(f.app)
    .post('/api/sessions/source/contributors')
    .set('x-connection-id', 'verified-connection')
    .set('x-internal-token', 'unverified')
    .send(f.input);
  expect(response.status).toBe(403);
  expect(f.selectors).toEqual([]);
  expect(f.allocate).not.toHaveBeenCalled();
});

it.each(['revoked', 'expired'] as const)(
  'rejects %s authority during a retained-owner profile read before allocation',
  async (reason) => {
    const f = await fixture();
    owner.client = {
      invalidate: vi.fn(),
      request: vi.fn(async () => {
        if (reason === 'revoked') revokeAuthSession(f.auth);
        else vi.spyOn(Date, 'now').mockReturnValue(f.auth.expiresAt + 1);
        return { status: 200, body: f.profile };
      }),
    };
    const response = await f.post();
    expect(response.status).toBe(409);
    expect(owner.client.request).toHaveBeenCalledOnce();
    expect(f.allocate).not.toHaveBeenCalled();
    expect(f.port.startChat).not.toHaveBeenCalled();
    expect(() => captureAgentLibraryAuthorization(f.selectors[0])).toThrow(/authentication/);
  },
);

it('keeps unsupported saved recipes refused after the authenticated real resolver succeeds', async () => {
  const f = await fixture();
  const definition = {
    ...f.profile.definition,
    contextRecipe: { version: 1, source: 'contexgin', agentName: 'writer' },
  };
  library.saveDraft('user', {
    profileId: 'compiled',
    expectedVersion: 0,
    expectedRevision: 0,
    idempotencyKey: 'draft-compiled',
    definition,
  });
  const profile = library.publish('user', {
    profileId: 'compiled',
    expectedVersion: 1,
    idempotencyKey: 'publish-compiled',
  });
  const response = await f.post({
    ...f.input,
    profileSelection: { profileId: profile.profileId, revision: profile.revision },
  });
  expect(response.status).toBe(409);
  expect(response.body.error).toContain('do not support saved profile context recipes');
  expect(f.allocate).not.toHaveBeenCalled();
  expect(f.port.startChat).not.toHaveBeenCalled();
});
