import { afterAll, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Express } from 'express';
import type { EventStore } from '../../server/event-store.js';
import { createApplicationHttpTransport } from '../../server/__tests__/fixtures/symposium-application-http.js';
import { CollaborationApiClient, MitzoApiClient } from '@mitzo/client';
import {
  CollaborationSnapshotSchema,
  CollaborationSettingsSchema,
  type CollaborationSettings,
  type CollaborationSnapshot,
} from '@mitzo/protocol';

// External tool configuration only. Keep actual app/chat, stores, routing,
// internal-token implementation and interactive login/cookie authentication.
vi.mock('../../server/mcp-config.js', () => ({
  loadMcpServers: () => ({}),
  getMcpConfigPaths: () => [],
}));

// External GitHub source acquisition only; actual canonical selection, account,
// connection authorization, ordinary capture and workspace owner remain real.
vi.mock('../../server/github-repository-source.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/github-repository-source.js')>();
  const boundary = await import('../../server/__tests__/fixtures/symposium-application-target.js');
  return {
    ...actual,
    inspectGithubRepositorySource: boundary.inspectSyntheticGithub,
    prepareGithubRepositorySource: boundary.prepareSyntheticGithub,
  };
});

let root: string | undefined;
let app: Express;
let events: EventStore;
let close: (() => Promise<void>) | undefined;
let cookie: string;
let http: Awaited<ReturnType<typeof createApplicationHttpTransport>> | undefined;
let connections:
  | Awaited<
      ReturnType<
        typeof import('../../server/__tests__/fixtures/symposium-application-target.js').installApplicationReviewConnections
      >
    >
  | undefined;
let releaseTransport: (() => void) | undefined;
const group = crypto.randomUUID();
let reviewedSnapshot: CollaborationSnapshot | undefined;
let reviewedSettings: CollaborationSettings | undefined;
let api: CollaborationApiClient;
async function loadApplication() {
  // Do not touch host credentials while the core-owned safe import seam is absent.
  // This is a BLOCKED prerequisite, not application behavior acceptance.
  const tokens = readFileSync(new URL('../../server/internal-token.ts', import.meta.url), 'utf8');
  const application = readFileSync(new URL('../../server/app.ts', import.meta.url), 'utf8');
  if (
    !tokens.includes('MITZO_INTERNAL_TOKEN_PATH') ||
    !application.includes('closeIdleApplicationResources') ||
    !application.includes('closeIdleRepositoryWorkspaces')
  )
    throw Error(
      'BLOCKED: core safe app/workspace idle teardown seam unavailable; actual app was not imported',
    );
  const fresh = root === undefined;
  root ??= realpathSync(mkdtempSync(join(tmpdir(), 'symposium-actual-app-')));
  for (const key of Object.keys(process.env)) {
    if (
      /^(MITZO_|OPENAI_|ANTHROPIC_|GOOGLE_|VERTEX_|CLOUD_ML_|NTFY_|PUSHOVER_|APNS_|CONTEXT|CONTEXGIN|LOKI_|OTEL_|MCP_|GH_TOKEN$|GITHUB_TOKEN$)/.test(
        key,
      )
    )
      vi.stubEnv(key, undefined);
  }
  const profiles = join(root, 'accounts.json');
  const limits = join(root, 'model-limits.json');
  if (fresh) {
    writeFileSync(profiles, '[]', { mode: 0o600 });
    writeFileSync(limits, '{}');
  }
  for (const [key, value] of Object.entries({
    REPO_PATH: root,
    TELOS_DB_PATH: join(root, 'telos.db'),
    MITZO_INTERNAL_TOKEN_PATH: join(root, 'internal-token'),
    MITZO_CODEX_PRIVATE_DIR: join(root, 'private'),
    MITZO_ACCOUNT_PROFILES_FILE: profiles,
    MITZO_MODEL_LIMITS_CATALOG_FILE: limits,
    CLAUDE_CODE_USE_VERTEX: '0',
    WORKTREE_ENABLED: 'false',
    LOGGER_SYNC: '1',
    LOG_FILE_PATH: join(root, 'app.log'),
    AUTH_PASSPHRASE: 'offline-symposium-acceptance-passphrase',
    AUTH_SECRET: 'offline-symposium-acceptance-secret-at-least-32-bytes',
    COOKIE_MAX_AGE_HOURS: '1',
  }))
    vi.stubEnv(key, value);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw Error('External network forbidden in application fixture');
    }),
  );
  const targetFixture =
    await import('../../server/__tests__/fixtures/symposium-application-target.js');
  await targetFixture.configureApplicationReviewTarget(root, fresh);
  const loaded = await import('../../server/app.js');
  app = loaded.app;
  close = Reflect.get(loaded, 'closeIdleApplicationResources');
  if (typeof close !== 'function')
    throw Error('Core idle application resource teardown unavailable');
  connections = await targetFixture.installApplicationReviewConnections(
    root,
    loaded.setConnectionsRuntime,
  );
  const idleClose = close;
  close = async () => {
    releaseTransport?.();
    releaseTransport = undefined;
    await connections?.close();
    connections = undefined;
    await idleClose();
  };
  events = (await import('../../server/chat.js')).eventStore;
  http = await createApplicationHttpTransport(app);
  if (!cookie) {
    const login = await http.request('POST', '/api/auth/login', {
      body: { passphrase: process.env.AUTH_PASSPHRASE },
    });
    expect(login.status).toBe(200);
    const raw = login.headers['set-cookie'];
    cookie = String(Array.isArray(raw) ? raw[0] : raw).split(';')[0];
    expect(cookie).toMatch(/^cc_auth=.+/);
  }
}
async function restartApplication() {
  if (!close || !http || !root) throw Error('Application fixture is not initialized');
  await close();
  await http.close();
  // Never let an interrupted fresh import reuse the prior owner's successful
  // close receipt as permission to remove its possibly open new resources.
  close = undefined;
  http = undefined;
  vi.resetModules();
  await loadApplication();
}
afterAll(async () => {
  let released = root === undefined;
  try {
    if (close) {
      await close();
      released = true;
      if (http) {
        const fenced = await http.request('GET', '/api/session-collaborations');
        expect(fenced).toMatchObject({
          status: 503,
          body: { error: 'Application resources are unavailable' },
        });
      }
    }
  } finally {
    await http?.close();
    // A failed idle release remains fenced; retain its root/logs and synthetic
    // environment rather than deleting files under possibly open resources or
    // restoring host configuration to unfinished callbacks.
    if (released) {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      if (root) rmSync(root, { recursive: true, force: true });
    }
  }
});

it('reviews an actual prepared unused Local workspace through real app auth and survives the same-session restart without capacity', async () => {
  await loadApplication();
  events.upsertSession({ sessionId: 'existing-chat', conversationSource: 'mitzo' });
  const sourceBoundary = events.append('existing-chat', 'user_message', {
    messageId: 'selected-source',
    text: 'Synthetic design requirement',
    privateProviderIdentity: 'DO_NOT_LEAK',
  });
  const path = `/api/session-collaborations/${group}`;
  expect((await http!.request('GET', path + '/conversation')).status).toBe(401);
  const beginInput = { requestId: crypto.randomUUID(), sessionId: 'existing-chat' };
  expect((await http!.request('POST', path + '/begin', { body: beginInput })).status).toBe(401);
  expect(
    (
      await http!.request('POST', path + '/begin', {
        headers: { cookie, origin: 'https://untrusted.invalid' },
        body: beginInput,
      })
    ).status,
  ).toBe(403);
  expect(events.getSessionCollaboration(group)).toBeNull();
  const sessionsBeforeBegin = events
    .listSessions()
    .map((row) => row.sessionId)
    .sort();
  let lostBeginResponses = 0;
  const associationRequests: string[] = [];
  api = new CollaborationApiClient(async (url, init) => {
    if (url.startsWith('/api/session-collaborations?')) associationRequests.push(url);
    const result = await http!.request(init?.method ?? 'GET', url, {
      headers: { cookie },
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    // Lose only the first successful begin response after the actual server
    // commits. No route, store, authorization or receipt is substituted.
    if (url === path + '/begin' && result.status === 200 && lostBeginResponses === 0) {
      lostBeginResponses++;
      throw Error('Simulated committed begin response loss');
    }
    return new Response(JSON.stringify(result.body), { status: result.status });
  });
  // Keep compilation valid on accepted source without this new client method;
  // missing actual source/route/client dependencies remain required failures.
  const beginMethod = Reflect.get(api, 'begin');
  expect(typeof beginMethod).toBe('function');
  const begin = () => Reflect.apply(beginMethod, api, [group, beginInput]);
  await expect(begin()).rejects.toThrow('Simulated committed begin response loss');
  expect(lostBeginResponses).toBe(1);
  const [beginReceipt, concurrentRetry] = await Promise.all([begin(), begin()]);
  expect(beginReceipt).toEqual({
    version: 1,
    collaborationId: group,
    revision: 1,
    participantSessionIds: ['existing-chat'],
  });
  expect(concurrentRetry).toEqual(beginReceipt);
  expect(events.getSessionCollaboration(group)).toEqual(beginReceipt);
  expect(
    events
      .listSessions()
      .map((row) => row.sessionId)
      .sort(),
  ).toEqual(sessionsBeforeBegin);
  expect(events.getOrdinaryInitialCommandId('existing-chat')).toBeUndefined();
  // Read the existing association through the typed client and actual app mount;
  // this is metadata discovery, with no context read, allocation or command.
  const listMethod = Reflect.get(api, 'listForSession');
  expect(typeof listMethod).toBe('function');
  const listForSession = (after?: string) =>
    Reflect.apply(listMethod, api, ['existing-chat', after]);
  const sourceEventsBeforeList = events.getSessionEvents('existing-chat');
  expect(
    (await http!.request('GET', '/api/session-collaborations?sessionId=existing-chat')).status,
  ).toBe(401);
  const associations = { collaborations: [beginReceipt], nextCursor: null };
  expect(await listForSession()).toEqual(associations);
  expect(associationRequests).toEqual(['/api/session-collaborations?sessionId=existing-chat']);
  expect(await listForSession(group)).toEqual({ collaborations: [], nextCursor: null });
  expect(associationRequests).toHaveLength(2);
  expect(associationRequests[1]).toBe(
    `/api/session-collaborations?sessionId=existing-chat&after=${group}`,
  );
  expect(events.getSessionEvents('existing-chat')).toEqual(sourceEventsBeforeList);
  expect(events.getOrdinaryInitialCommandId('existing-chat')).toBeUndefined();
  expect(events.listSessions()).toHaveLength(sessionsBeforeBegin.length);
  const view = await api.view(group);
  expect(view.joins).toEqual([]);
  expect(view.messages).toEqual([]);
  expect(view.participantSessionIds).toEqual(['existing-chat']);
  await api.setPolicy(group, {
    requestId: crypto.randomUUID(),
    expectedMembershipRevision: view.membershipRevision,
    expectedRevision: view.policies.find((row) => row.sessionId === 'existing-chat')?.revision ?? 0,
    sessionId: 'existing-chat',
    readsFutureDiscussion: true,
    repliesByDefault: true,
  });
  const retained = await api.view(group);
  const token = decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1));
  const identity = await (await import('../../server/auth.js')).authenticateToken(token);
  expect(identity).toBeTruthy();
  const internalToken = readFileSync(join(root!, 'internal-token'), 'utf8');
  const commandBefore = events.getOrdinaryInitialCommandId('existing-chat');
  const sessionsBefore = events.listSessions().length;
  await restartApplication();
  expect(await begin()).toEqual(beginReceipt);
  expect(await listForSession()).toEqual(associations);
  expect(associationRequests).toHaveLength(3);
  expect(events.getSessionEvents('existing-chat')).toEqual(sourceEventsBeforeList);
  expect(lostBeginResponses).toBe(1);
  expect(await api.view(group)).toEqual(retained);
  expect(await (await import('../../server/auth.js')).authenticateToken(token)).toEqual(identity);
  expect(readFileSync(join(root!, 'internal-token'), 'utf8')).toBe(internalToken);
  expect(events.getOrdinaryInitialCommandId('existing-chat')).toBe(commandBefore);
  expect(events.listSessions()).toHaveLength(sessionsBefore);
  // Source acquisition goes through the actual app HTTP mounts and workspace
  // singleton. The prepared target is unused and distinct from existing-chat.
  const { ordinaryRepositoryRuntimeInventory } =
    await import('../../server/ordinary-local-codex-entry.js');
  const inventory = ordinaryRepositoryRuntimeInventory('local', 'codex');
  const account = inventory.result.accounts.find(
    (row) => row.account.accountId === 'offline-personal',
  )!.account;
  const preview = await http!.request('POST', '/api/repository-workspaces/preview', {
    headers: { cookie },
    body: {
      accountId: 'offline-personal',
      model: 'fixture-model',
      connectionId: connections!.connectionId,
      repository: 'example/acceptance',
      ordinaryRuntime: {
        runOn: 'local',
        runtime: { account, harness: 'codex', targetId: 'offline-observation' },
      },
    },
  });
  expect(preview.status, JSON.stringify(preview.body)).toBe(200);
  const previewId = z.object({ id: z.uuid() }).parse(preview.body).id;
  const prepared = await http!.request('POST', `/api/repository-workspaces/${previewId}/prepare`, {
    headers: { cookie },
    body: { accountId: 'offline-personal', model: 'fixture-model' },
  });
  expect(prepared.status, JSON.stringify(prepared.body)).toBe(200);
  expect(prepared.body).toMatchObject({ id: previewId, state: 'ready' });
  const { getRepositoryWorkspaces } = await import('../../server/repository-workspace-runtime.js');
  const targetBefore = getRepositoryWorkspaces(true).get(previewId);
  expect(targetBefore.conversationId).toBeUndefined();
  expect(targetBefore.ordinaryFirstReservation).toBeUndefined();

  const { getAgentLibrary } = await import('../../server/agent-library-runtime.js');
  const library = getAgentLibrary();
  library.saveDraft('user', {
    profileId: 'acceptance-reviewer',
    expectedVersion: 0,
    expectedRevision: 0,
    idempotencyKey: 'draft',
    definition: {
      name: 'Reviewer',
      descriptor: 'Assistant',
      role: 'agent',
      instructions: 'Review the selected source.',
      expectedOutput: 'Findings',
      acceptanceCriteria: ['Cite evidence'],
      modelPolicyRole: 'agent',
    },
  });
  const published = library.publish('user', {
    profileId: 'acceptance-reviewer',
    expectedVersion: 1,
    idempotencyKey: 'publish',
  });
  const clientId = crypto.randomUUID();
  const bindTransport = async () => {
    const currentAuth = await (await import('../../server/auth.js')).authenticateToken(token);
    expect(currentAuth).toEqual(identity);
    const { claimTransportConnection, releaseTransportConnection } =
      await import('../../server/transport-auth-ownership.js');
    const { bindAgentLibraryTransport } = await import('../../server/agent-library-transport.js');
    claimTransportConnection(clientId, currentAuth!.id);
    const unbind = bindAgentLibraryTransport(clientId, currentAuth!);
    releaseTransport = () => {
      unbind();
      releaseTransportConnection(clientId, currentAuth!.id);
    };
  };
  await bindTransport();
  const input = {
    clientId,
    selection: {
      requestId: crypto.randomUUID(),
      expectedMembershipRevision: retained.membershipRevision,
      sourceConversationId: 'existing-chat',
      boundary: { sequence: sourceBoundary, messageId: 'selected-source' },
      mode: 'selected',
      messageIds: ['selected-source'],
      artifacts: [],
      purpose: 'Review the selected design',
      joiningBrief: 'Edited brief retained exactly',
    },
    target: {
      runOn: 'local',
      accountId: 'offline-personal',
      model: 'fixture-model',
      reasoningEffort: 'low',
      agent: { profileId: published.profileId, revision: published.revision },
      repositoryWorkspaceId: previewId,
      permissionMode: 'ask',
    },
  };
  const legacy = await http!.request('POST', path + '/snapshots', {
    headers: { cookie },
    body: input.selection,
  });
  expect(legacy.status).toBe(503);
  // This must fail if actual app wiring omits its review owner. A hand-wired
  // router, fixture settings or a source workspace cannot satisfy it.
  const reviewed = await http!.request('POST', path + '/reviews', {
    headers: { cookie },
    body: input,
  });
  expect(reviewed.status, JSON.stringify(reviewed.body)).toBe(200);
  const result = z
    .object({ snapshot: CollaborationSnapshotSchema, settings: CollaborationSettingsSchema })
    .parse(reviewed.body);
  reviewedSnapshot = result.snapshot;
  reviewedSettings = result.settings;
  expect(reviewedSnapshot).toMatchObject({
    capacity: { status: 'unverified' },
    joiningBrief: input.selection.joiningBrief,
  });
  expect(reviewedSnapshot.messages[0]?.blocks[0]?.content).toBe('Synthetic design requirement');
  expect(JSON.stringify(reviewed.body)).not.toContain('DO_NOT_LEAK');
  expect(reviewedSettings).toMatchObject({
    repositoryWorkspaceId: previewId,
    selection: { permission: { mode: 'ask', revision: 0 } },
    binding: { account: { accountId: 'offline-personal' }, execution: { location: 'local' } },
  });
  // Resolve the real typed method at runtime so this test still compiles on
  // accepted source without the new contract, where required evidence stays red.
  const reviewMethod = Reflect.get(api, 'review');
  expect(typeof reviewMethod).toBe('function');
  const replay = await Reflect.apply(reviewMethod, api, [
    group,
    clientId,
    { selection: input.selection, target: input.target },
  ]);
  expect(replay).toEqual(reviewed.body);
  const projected = await api.view(group);
  expect(projected.joins).toEqual([]);
  expect(projected.messages).toEqual([]);
  // Reopen the same app/root/cookie after the first review response. Rebind
  // only the existing real interactive transport; do not recreate a workspace,
  // rewrite account/profile files or adopt a different operator.
  await restartApplication();
  await bindTransport();
  const recovered = await Reflect.apply(reviewMethod, api, [
    group,
    clientId,
    { selection: input.selection, target: input.target },
  ]);
  expect(recovered).toEqual(reviewed.body);
  const reopenedWorkspaces = (
    await import('../../server/repository-workspace-runtime.js')
  ).getRepositoryWorkspaces(true);
  expect(reopenedWorkspaces.get(previewId)).toEqual(targetBefore);
  expect(readFileSync(join(root!, 'internal-token'), 'utf8')).toBe(internalToken);
  expect(events.listSessions()).toHaveLength(sessionsBefore);
  expect(events.getOrdinaryInitialCommandId('existing-chat')).toBe(commandBefore);
}, 20000);

it('reads exact completed durable source through actual production injection and typed client without restore or allocation', async () => {
  if (!http) throw Error('BLOCKED: actual app prerequisite failed');
  const sessionId = 'retained-durable-source';
  const userText = '\uFEFF  Selected π\r\n\t';
  const answerText = '  Finalized answer π\r\n';
  const privateText = 'PRIVATE_DURABLE_PROVIDER';
  events.upsertSession({ sessionId, conversationSource: 'mitzo' });
  const question = events.append(sessionId, 'user_message', {
    messageId: 'question',
    text: userText,
    credential: privateText,
  });
  events.append(sessionId, 'message_start', { messageId: 'answer', providerTurnId: privateText });
  for (const [blockId, blockType, delta] of [
    ['reasoning', 'thinking', privateText],
    ['tool', 'tool_use', privateText],
    ['visible', 'text', answerText],
  ]) {
    events.append(sessionId, 'block_start', { messageId: 'answer', blockId, blockType });
    events.append(sessionId, 'block_delta', { messageId: 'answer', blockId, delta });
    events.append(sessionId, 'block_end', { messageId: 'answer', blockId });
  }
  const completed = events.append(sessionId, 'message_end', {
    messageId: 'answer',
    provider: privateText,
  });
  const expected = {
    sourceConversationId: sessionId,
    boundary: { sequence: completed, messageId: 'answer' },
    messages: [
      {
        conversationId: sessionId,
        messageId: 'question',
        sequence: question,
        author: 'operator',
        source: null,
        blocks: [
          {
            blockId: 'user-question',
            content: userText,
            sha256: createHash('sha256').update(userText).digest('hex'),
          },
        ],
      },
      {
        conversationId: sessionId,
        messageId: 'answer',
        sequence: completed,
        author: { sessionId },
        source: null,
        blocks: [
          {
            blockId: 'visible',
            content: answerText,
            sha256: createHash('sha256').update(answerText).digest('hex'),
          },
        ],
      },
    ],
  };
  const path = `/api/sessions/${sessionId}/messages?transcript=durable`;
  const requests: string[] = [];
  const durableApi = new MitzoApiClient(async (url, init) => {
    // A legacy/SDK restore request cannot satisfy this positive source check.
    expect(url).toBe(path);
    expect(init?.credentials).toBe('include');
    init?.signal?.throwIfAborted();
    requests.push(url);
    const result = await http!.request('GET', url, { headers: { cookie } });
    return new Response(JSON.stringify(result.body), { status: result.status });
  });
  const method = Reflect.get(durableApi, 'getDurableSessionTranscript');
  expect(typeof method).toBe('function');
  const read = () => Reflect.apply(method, durableApi, [sessionId]);
  const before = events.getSessionEvents(sessionId);
  const sessionsBefore = events
    .listSessions()
    .map((row) => row.sessionId)
    .sort();
  expect((await http.request('GET', path)).status).toBe(401);
  const replay = vi.spyOn(events, 'getSessionEvents');
  try {
    await expect(read()).resolves.toEqual(expected);
    expect(replay).not.toHaveBeenCalled();
  } finally {
    replay.mockRestore();
  }
  expect(requests).toEqual([path]);
  expect(events.getSessionEvents(sessionId)).toEqual(before);
  expect(
    events
      .listSessions()
      .map((row) => row.sessionId)
      .sort(),
  ).toEqual(sessionsBefore);
  expect(events.getOrdinaryInitialCommandId(sessionId)).toBeUndefined();
  expect(JSON.stringify(expected)).not.toContain(privateText);
  await restartApplication();
  await expect(read()).resolves.toEqual(expected);
  expect(requests).toEqual([path, path]);
  expect(events.getSessionEvents(sessionId)).toEqual(before);
  expect(
    events
      .listSessions()
      .map((row) => row.sessionId)
      .sort(),
  ).toEqual(sessionsBefore);
  expect(events.getOrdinaryInitialCommandId(sessionId)).toBeUndefined();
  events.hideSession(sessionId);
  const hidden = await http!.request('GET', path, { headers: { cookie } });
  expect(hidden).toMatchObject({ status: 500, body: { error: 'Session transcript unavailable' } });
  await expect(read()).rejects.toThrow('Session transcript unavailable');
  expect(requests).toEqual([path, path, path]);
}, 20000);

it('requires actual joining and finalized reply owners after the observational review', async () => {
  if (!reviewedSnapshot || !reviewedSettings)
    throw Error('BLOCKED: actual app review prerequisite failed');
  const snapshot = reviewedSnapshot;
  const view = await api.view(group);
  // These gates deliberately use the SAME actual app/client/store. A source
  // review mount alone cannot turn this regression green while join/send owners
  // are missing. Core's safe external account/count/RPC ports and actual ordinary
  // workspace fixture still have to land before this continuation can go green.
  const joined = await api.prepareJoin(group, {
    requestId: crypto.randomUUID(),
    expectedMembershipRevision: view.membershipRevision,
    name: 'Independent reviewer',
    settings: reviewedSettings,
    snapshot: { snapshotId: snapshot.snapshotId, sha256: snapshot.sha256 },
  });
  expect(joined.state).toBe('linked');
  expect(joined.sessionId).toBeTruthy();
  expect(events.getOrdinaryInitialCommandId(joined.sessionId!)).toBeUndefined();
  const afterJoin = await api.view(group);
  const prompt = await api.send(group, {
    requestId: crypto.randomUUID(),
    expectedMembershipRevision: afterJoin.membershipRevision,
    expectedPolicySequence: afterJoin.policySequence,
    text: 'Review the selected design explicitly',
    responders: { kind: 'selected', sessionIds: [joined.sessionId!] },
    snapshot: null,
  });
  await vi.waitFor(async () => {
    const projected = await api.view(group);
    const reply = projected.messages.find(
      (row) =>
        row.replyToDeliveryId !== null &&
        prompt.deliveries.some((d) => d.deliveryId === row.replyToDeliveryId),
    );
    expect(reply).toMatchObject({ author: { sessionId: joined.sessionId } });
    expect(reply!.source?.conversationId).toBe(joined.sessionId);
    expect(reply!.source?.commandId).toBeTruthy();
  });
}, 20000);
