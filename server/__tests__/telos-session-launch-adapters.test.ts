import { afterEach, describe, expect, it, vi } from 'vitest';
import express, { type RequestHandler } from 'express';
import request from 'supertest';
import {
  createTelosSessionProposalRouter,
  executeTelosCreateSession,
  telosSessionProposalFailure,
} from '../telos-session-launch-adapters.js';
import { agentToolCatalog } from '../agent-tool-catalog.js';

const mocks = vi.hoisted(() => ({
  propose: vi.fn(),
  auth: vi.fn(),
  allowed: vi.fn(() => true),
  error: vi.fn(),
}));
vi.mock('../logger.js', () => ({
  createLogger: () => ({ error: mocks.error, warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../session-launch-tools.js', async (original) => ({
  ...(await original<typeof import('../session-launch-tools.js')>()),
  proposeTelosSession: mocks.propose,
}));
vi.mock('@mitzo/harness', async (original) => ({
  ...(await original<typeof import('@mitzo/harness')>()),
  checkSkillPolicy: () => 'allow',
}));
vi.mock('../agent-library-transport.js', () => ({
  captureAgentLibraryAuthorization: () => ({ auth: { id: 'operator' }, assertCurrent: mocks.auth }),
}));
vi.mock('../agent-tool-selection.js', () => ({ agentToolAllowed: mocks.allowed }));

const input = {
  requestId: '61df5cc3-0370-42f3-bbe8-c9eeb91ffcd2',
  itemId: 'slice',
  expectedRevision: 'a'.repeat(64),
  title: 'Selected slice',
  prompt: 'Reviewed work',
  sourceSnapshotIds: [],
  artifactRefs: [],
};
const receipt = {
  proposalId: 'a3eb433a-acf5-45a8-a629-3c6c6c3fb439',
  requestId: input.requestId,
  sourceSessionId: 'claude-lead',
  title: input.title,
  prompt: input.prompt,
  configuration: {
    version: 1,
    runtime: {
      version: 1,
      account: null,
      agentProfile: null,
      execution: { location: 'local', targetId: 'child-mac' },
    },
    mode: 'agent',
    isolation: true,
    repositoryWorkspaceId: null,
    contextBlocks: [],
    extraTools: [],
  },
  telos: {
    version: 1,
    parentItemId: 'feature',
    parentAssignmentRevision: 1,
    itemId: input.itemId,
    expectedRevision: input.expectedRevision,
    role: 'worker',
    sourceSnapshotIds: [],
    artifactRefs: [],
  },
  state: 'pending',
  revision: 1,
  childSessionId: null,
  createdAt: 1,
  updatedAt: 1,
};
function proposalApp(before?: RequestHandler) {
  const session = {
    sessionId: 'claude-lead',
    ownerConnectionId: 'signed-connection',
    abortController: new AbortController(),
  };
  const registry = { get: () => session, isClosingOut: () => false, isUserClose: () => false };
  const app = express();
  app.use(express.json());
  if (before) app.use(before);
  app.use(
    createTelosSessionProposalRouter({
      controller: {} as never,
      registry: registry as never,
      verifyInternal: () => true,
      ordinaryConversation: () => true,
    }),
  );
  return app;
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('Telos work-bound session adapter contract', () => {
  it('retains and sanitizes an unexpected failure after the HTTP consumer disconnects', async () => {
    const cause = new Error('private provider or source payload');
    const disconnectedInput = { ...input, requestId: '2ff0e574-ea1f-47fa-82d0-4267d503eb83' };
    const app = proposalApp((_req, res, next) => {
      mocks.propose.mockImplementationOnce(async () => {
        res.destroy();
        throw cause;
      });
      next();
    });
    await expect(
      request(app)
        .post('/api/internal/telos/session/propose')
        .set('X-Client-Id', 'claude-client')
        .send({ clientId: 'claude-client', sessionId: 'claude-lead', input: disconnectedInput }),
    ).rejects.toThrow(/socket hang up|aborted|ECONNRESET/i);
    expect(telosSessionProposalFailure(disconnectedInput.requestId)).toBe(cause);
    expect(mocks.error).toHaveBeenCalledWith('Telos session proposal unavailable', {
      stage: 'proposal',
      code: 'telos_session_proposal_failed',
      requestId: disconnectedInput.requestId,
      sourceSessionId: 'claude-lead',
    });
  });

  it('exposes the same tool on local Claude and local/OpenShell Codex selection routes', () => {
    expect(agentToolCatalog().find((tool) => tool.name === 'TelosCreateSession')?.routes).toEqual([
      'local-api',
      'codex',
      'codex-owned-local',
    ]);
  });

  it('retains Claude SDK caller identity while the child runtime remains independently reviewed', async () => {
    mocks.propose.mockResolvedValue(receipt);
    const app = proposalApp();
    const res = await request(app)
      .post('/api/internal/telos/session/propose')
      .set('X-Client-Id', 'claude-client')
      .send({ clientId: 'claude-client', sessionId: 'claude-lead', input });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      sourceSessionId: 'claude-lead',
      telos: { itemId: 'slice' },
      state: 'pending',
    });
    expect(mocks.propose).toHaveBeenCalledWith(
      expect.anything(),
      'claude-lead',
      input,
      expect.objectContaining({
        operatorConnectionId: 'signed-connection',
        authSessionId: 'operator',
      }),
    );
    const refused = await request(app)
      .post('/api/internal/telos/session/propose')
      .set('X-Client-Id', 'claude-client')
      .send({ clientId: 'claude-client', sessionId: 'different-lead', input });
    expect(refused.status).toBe(403);
    expect(mocks.propose).toHaveBeenCalledTimes(1);
    mocks.propose.mockResolvedValue({
      ...receipt,
      handoverDownloadUrl: '/api/session-launch/retained/handover',
      startupBlocker: 'Select child account.',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const response = await request(app)
          .post('/api/internal/telos/session/propose')
          .set(init.headers as Record<string, string>)
          .send(JSON.parse(init.body as string));
        return { ok: response.status === 200, json: async () => response.body };
      }),
    );
    const transported = await executeTelosCreateSession(
      'http://fixture',
      'claude-client',
      'claude-lead',
      'synthetic-token',
      input,
    );
    expect(transported.isError).toBe(false);
    expect(JSON.parse(transported.content)).toMatchObject({
      ...receipt,
      startupBlocker: 'Select child account.',
    });
  });

  it('does not accept an ordinary or mismatched response as work-bound creation', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ...receipt, telos: { ...receipt.telos, itemId: 'unrelated' } }),
    });
    vi.stubGlobal('fetch', fetch);
    const result = await executeTelosCreateSession(
      'http://fixture',
      'claude-client',
      'claude-lead',
      'synthetic-token',
      input,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/not confirmed|does not match/i);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('accepts the proposal response including its handover and editable startup blocker', async () => {
    const response = {
      ...receipt,
      handoverDownloadUrl: '/api/session-launch/retained/handover',
      startupBlocker: 'Select the independent child runtime.',
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => response }));
    const result = await executeTelosCreateSession(
      'http://fixture',
      'claude-client',
      'claude-lead',
      'synthetic-token',
      input,
    );
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toEqual(response);
  });
});
