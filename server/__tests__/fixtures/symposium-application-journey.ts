import { expect, vi } from 'vitest';
import { z } from 'zod';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Express } from 'express';
import type { EventStore } from '../../event-store.js';
import { createApplicationHttpTransport } from './symposium-application-http.js';
import { CollaborationApiClient, MitzoApiClient } from '@mitzo/client';
import type { CollaborationSettings, CollaborationSnapshot } from '@mitzo/protocol';
// External tool configuration only. Keep actual app/chat, stores, routing,
// internal-token implementation and interactive login/cookie authentication.
vi.mock('../../mcp-config.js', () => ({
  loadMcpServers: () => ({}),
  getMcpConfigPaths: () => [],
}));
// Host location is external fixture metadata. Keep actual private-root guards
// while preventing access to the developer's credential/configuration directories.
vi.mock('node:os', async (original) => {
  const os = await original<typeof import('node:os')>();
  return { ...os, homedir: () => process.env.SYMPOSIUM_OFFLINE_HOME ?? os.homedir() };
});
// External GitHub source acquisition only; actual canonical selection, account,
// connection authorization, ordinary capture and workspace owner remain real.
vi.mock('../../github-repository-source.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../github-repository-source.js')>();
  const boundary = await import('./symposium-application-target.js');
  return {
    ...actual,
    inspectGithubRepositorySource: boundary.inspectSyntheticGithub,
    prepareGithubRepositorySource: boundary.prepareSyntheticGithub,
  };
});
class ApplicationJourneyState {
  root?: string;
  app!: Express;
  events!: EventStore;
  close?: () => Promise<void>;
  cookie = '';
  http?: Awaited<ReturnType<typeof createApplicationHttpTransport>>;
  connections?: Awaited<
    ReturnType<
      typeof import('./symposium-application-target.js').installApplicationReviewConnections
    >
  >;
  releaseTransport?: () => void;
  group = crypto.randomUUID();
  reviewedSnapshot?: CollaborationSnapshot;
  reviewedSettings?: CollaborationSettings;
  joinedSessionId?: string;
  api!: CollaborationApiClient;
}

export function createApplicationJourney() {
  const state = new ApplicationJourneyState();
  async function loadApplication() {
    // Do not touch host credentials while the core-owned safe import seam is absent.
    // This is a BLOCKED prerequisite, not application behavior acceptance.
    const tokens = readFileSync(new URL('../../internal-token.ts', import.meta.url), 'utf8');
    const application = readFileSync(new URL('../../app.ts', import.meta.url), 'utf8');
    if (
      !tokens.includes('MITZO_INTERNAL_TOKEN_PATH') ||
      !application.includes('closeIdleApplicationResources') ||
      !application.includes('closeIdleRepositoryWorkspaces')
    )
      throw Error(
        'BLOCKED: core safe app/workspace idle teardown seam unavailable; actual app was not imported',
      );
    const fresh = state.root === undefined;
    state.root ??= realpathSync(mkdtempSync(join(tmpdir(), 'symposium-actual-app-')));
    vi.stubEnv('CODEX_HOME', undefined);
    for (const key of Object.keys(process.env)) {
      if (
        /^(MITZO_|OPENAI_|ANTHROPIC_|GOOGLE_|VERTEX_|CLOUD_ML_|NTFY_|PUSHOVER_|APNS_|CONTEXT|CONTEXGIN|LOKI_|OTEL_|MCP_|GH_TOKEN$|GITHUB_TOKEN$)/.test(
          key,
        )
      )
        vi.stubEnv(key, undefined);
    }
    const profiles = join(state.root, 'accounts.json');
    const limits = join(state.root, 'model-limits.json');
    if (fresh) {
      mkdirSync(join(state.root, 'telos-private'), { mode: 0o700 });
      writeFileSync(profiles, '[]', { mode: 0o600 });
      writeFileSync(limits, '{}');
    }
    for (const [key, value] of Object.entries({
      REPO_PATH: state.root,
      TELOS_DB_PATH: join(state.root, 'telos-private', 'telos.db'),
      MITZO_INTERNAL_TOKEN_PATH: join(state.root, 'internal-token'),
      MITZO_CODEX_PRIVATE_DIR: join(state.root, 'private'),
      MITZO_ORDINARY_TASK_ROOT: join(state.root, 'tasks'),
      SYMPOSIUM_OFFLINE_HOME: join(state.root, 'home'),
      MITZO_ACCOUNT_PROFILES_FILE: profiles,
      MITZO_MODEL_LIMITS_CATALOG_FILE: limits,
      CLAUDE_CODE_USE_VERTEX: '0',
      WORKTREE_ENABLED: 'false',
      LOGGER_SYNC: '1',
      LOG_FILE_PATH: join(state.root, 'app.log'),
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
    const targetFixture = await import('./symposium-application-target.js');
    await targetFixture.configureApplicationReviewTarget(state.root, fresh);
    const loaded = await import('../../app.js');
    state.app = loaded.app;
    state.close = Reflect.get(loaded, 'closeIdleApplicationResources');
    if (typeof state.close !== 'function')
      throw Error('Core idle application resource teardown unavailable');
    state.connections = await targetFixture.installApplicationReviewConnections(
      state.root,
      loaded.setConnectionsRuntime,
    );
    // The listener bootstrap installs this exact production composition after
    // importing app.ts. Reuse it without starting index.ts or external services.
    const { mountApplicationChatTransport } = await import('../../chat-rest-handler.js');
    const { ConnectionRegistry } = await import('@mitzo/harness');
    const { SessionSseRegistry } = await import('../../session-sse-registry.js');
    const { NativeCommandRegistry } = await import('../../native-commands.js');
    const chat = await import('../../chat.js');
    const transportConnections = new ConnectionRegistry();
    const transportStreams = new SessionSseRegistry();
    chat.setConnectionRegistry(transportConnections);
    mountApplicationChatTransport(state.app, transportStreams, {
      connRegistry: transportConnections,
      sessionRegistry: chat.registry,
      eventStore: chat.eventStore,
      nativeCommands: new NativeCommandRegistry(),
    });
    const idleClose = state.close;
    state.close = async () => {
      state.releaseTransport?.();
      state.releaseTransport = undefined;
      await state.connections?.close();
      state.connections = undefined;
      transportStreams.destroy();
      transportConnections.dispose();
      chat.setConnectionRegistry(null);
      await idleClose();
    };
    state.events = (await import('../../chat.js')).eventStore;
    state.http = await createApplicationHttpTransport(state.app);
    if (!state.cookie) {
      const login = await state.http.request('POST', '/api/auth/login', {
        body: { passphrase: process.env.AUTH_PASSPHRASE },
      });
      expect(login.status).toBe(200);
      const raw = login.headers['set-cookie'];
      state.cookie = String(Array.isArray(raw) ? raw[0] : raw).split(';')[0];
      expect(state.cookie).toMatch(/^cc_auth=.+/);
    }
  }
  async function restartApplication() {
    if (!state.close || !state.http || !state.root)
      throw Error('Application fixture is not initialized');
    await state.close();
    await state.http.close();
    // Never let an interrupted fresh import reuse the prior owner's successful
    // close receipt as permission to remove its possibly open new resources.
    state.close = undefined;
    state.http = undefined;
    vi.resetModules();
    await loadApplication();
  }
  /** The retained acceptance continuation reuses this real application journey. */
  function getApplicationJoiningJourney() {
    if (!state.joinedSessionId)
      throw Error('BLOCKED: actual application joining prerequisite failed');
    return {
      api: state.api,
      events: state.events,
      group: state.group,
      joinedSessionId: state.joinedSessionId,
    };
  }
  /** Real login/HTTP bridge for the production UI acceptance continuation. */
  async function getApplicationUiJourney() {
    await initializeReviewedJoin();
    const auth = await (
      await import('../../auth.js')
    ).authenticateToken(state.cookie.slice('cc_auth='.length));
    if (!auth) throw Error('Actual application login unavailable');
    const clientId = crypto.randomUUID();
    const { claimTransportConnection, releaseTransportConnection } =
      await import('../../transport-auth-ownership.js');
    const { bindAgentLibraryTransport } = await import('../../agent-library-transport.js');
    claimTransportConnection(clientId, auth.id);
    const unbind = bindAgentLibraryTransport(clientId, auth);
    const previous = state.releaseTransport;
    state.releaseTransport = () => {
      unbind();
      releaseTransportConnection(clientId, auth.id);
      previous?.();
    };
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.startsWith('/') ? url : new URL(url).pathname + new URL(url).search;
      const response = await state.http!.request(init?.method ?? 'GET', path, {
        headers: { cookie: state.cookie },
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return new Response(JSON.stringify(response.body), { status: response.status });
    });
    return {
      ...getApplicationJoiningJourney(),
      typedApi: new MitzoApiClient(fetch),
      fetch,
      clientId,
    };
  }
  async function closeJourney() {
    let released = state.root === undefined;
    try {
      if (state.close) {
        await state.close();
        released = true;
        if (state.http) {
          const fenced = await state.http.request('GET', '/api/session-collaborations');
          expect(fenced).toMatchObject({
            status: 503,
            body: { error: 'Application resources are unavailable' },
          });
        }
      }
    } finally {
      await state.http?.close();
      // A failed idle release remains fenced; retain its root/logs and synthetic
      // environment rather than deleting files under possibly open resources or
      // restoring host configuration to unfinished callbacks.
      if (released) {
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
        if (state.root) rmSync(state.root, { recursive: true, force: true });
      }
    }
  }
  /** Minimal real application setup for a consumer; no test cases or recovery
   * journeys are registered or replayed by importing this fixture. */
  async function initializeReviewedJoin() {
    if (state.joinedSessionId) return getApplicationJoiningJourney();
    await loadApplication();
    state.events.upsertSession({ sessionId: 'existing-chat', conversationSource: 'mitzo' });
    const boundary = state.events.append('existing-chat', 'user_message', {
      messageId: 'selected-source',
      text: 'Synthetic design requirement',
      privateProviderIdentity: 'DO_NOT_LEAK',
    });
    state.api = new CollaborationApiClient(async (url, init) => {
      const result = await state.http!.request(init?.method ?? 'GET', url, {
        headers: { cookie: state.cookie },
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return new Response(JSON.stringify(result.body), { status: result.status });
    });
    await state.api.begin(state.group, {
      requestId: crypto.randomUUID(),
      sessionId: 'existing-chat',
    });
    const view = await state.api.view(state.group);
    await state.api.setPolicy(state.group, {
      requestId: crypto.randomUUID(),
      expectedMembershipRevision: view.membershipRevision,
      expectedRevision: view.policies.find((p) => p.sessionId === 'existing-chat')!.revision,
      sessionId: 'existing-chat',
      readsFutureDiscussion: true,
      repliesByDefault: true,
    });
    const { ordinaryRepositoryRuntimeInventory } =
      await import('../../ordinary-local-codex-entry.js');
    const account = ordinaryRepositoryRuntimeInventory('local', 'codex').result.accounts.find(
      (row) => row.account.accountId === 'offline-personal',
    )!.account;
    const preview = await state.http!.request('POST', '/api/repository-workspaces/preview', {
      headers: { cookie: state.cookie },
      body: {
        accountId: 'offline-personal',
        model: 'fixture-model',
        connectionId: state.connections!.connectionId,
        repository: 'example/acceptance',
        ordinaryRuntime: {
          runOn: 'local',
          runtime: { account, harness: 'codex', targetId: 'offline-observation' },
        },
      },
    });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    const previewId = z.object({ id: z.uuid() }).parse(preview.body).id;
    const prepared = await state.http!.request(
      'POST',
      `/api/repository-workspaces/${previewId}/prepare`,
      {
        headers: { cookie: state.cookie },
        body: { accountId: 'offline-personal', model: 'fixture-model' },
      },
    );
    expect(prepared.status, JSON.stringify(prepared.body)).toBe(200);
    const library = (await import('../../agent-library-runtime.js')).getAgentLibrary();
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
    const auth = await (
      await import('../../auth.js')
    ).authenticateToken(decodeURIComponent(state.cookie.slice('cc_auth='.length)));
    if (!auth) throw Error('Actual application login unavailable');
    const clientId = crypto.randomUUID();
    const { claimTransportConnection, releaseTransportConnection } =
      await import('../../transport-auth-ownership.js');
    const { bindAgentLibraryTransport } = await import('../../agent-library-transport.js');
    claimTransportConnection(clientId, auth.id);
    const unbind = bindAgentLibraryTransport(clientId, auth);
    state.releaseTransport = () => {
      unbind();
      releaseTransportConnection(clientId, auth.id);
    };
    const current = await state.api.view(state.group);
    const reviewed = await state.api.review(state.group, clientId, {
      selection: {
        requestId: crypto.randomUUID(),
        expectedMembershipRevision: current.membershipRevision,
        sourceConversationId: 'existing-chat',
        boundary: { sequence: boundary, messageId: 'selected-source' },
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
    });
    state.reviewedSnapshot = reviewed.snapshot;
    state.reviewedSettings = reviewed.settings;
    const joined = await state.api.prepareJoin(state.group, {
      requestId: crypto.randomUUID(),
      expectedMembershipRevision: current.membershipRevision,
      name: 'Independent reviewer',
      settings: reviewed.settings,
      snapshot: { snapshotId: reviewed.snapshot.snapshotId, sha256: reviewed.snapshot.sha256 },
    });
    expect(joined.state).toBe('linked');
    state.joinedSessionId = joined.sessionId ?? undefined;
    expect(state.events.getOrdinaryInitialCommandId(state.joinedSessionId!)).toBeUndefined();
    return getApplicationJoiningJourney();
  }

  return {
    state,
    loadApplication,
    restartApplication,
    close: closeJourney,
    initializeReviewedJoin,
    getApplicationJoiningJourney,
    getApplicationUiJourney,
  };
}
