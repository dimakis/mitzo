import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { z } from 'zod';
import { buildPermissionHandler } from '@mitzo/harness';
import { buildSessionPermissionHooks } from '../session-permission-policy.js';
import { createTelosSourceRouter } from '../telos-source-routes.js';
import { createTelosSourceApprovalData } from './fixtures/telos-source-approval-data.js';

const registrations = vi.hoisted(
  () =>
    new Map<
      string,
      {
        shape: z.ZodRawShape;
        run(
          input: Record<string, unknown>,
        ): Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
      }
    >(),
);
vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: class {
    registerTool(
      name: string,
      definition: { inputSchema: z.ZodRawShape },
      run: (
        input: Record<string, unknown>,
      ) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>,
    ) {
      registrations.set(name, { shape: definition.inputSchema, run });
    }
    async connect() {}
  },
}));
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({ StdioServerTransport: class {} }));
const cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup
    .splice(0)
    .reverse()
    .forEach((close) => close());
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it.each(['create', 'adopt'] as const)(
  'passes one reviewed SDK %s through its real permission hook, MCP schema/callback and internal receipt route',
  async (kind) => {
    const f = createTelosSourceApprovalData();
    cleanup.push(() => f.close());
    const app = express();
    app.use(express.json());
    const path = vi.fn(() => f.dbPath);
    app.use(
      createTelosSourceRouter({
        dbPath: path,
        events: f.events,
        operatorAuth: (req, res, next) => {
          if (req.headers['x-operator'] !== f.actor.id) {
            res.status(403).end();
            return;
          }
          res.locals.authSession = { id: f.actor.id, expiresAt: Date.now() + 60_000 };
          next();
        },
        ordinaryConversation: (id) => id === 'planning',
        createOutcome: f.createOutcome,
        verifyInternal: (req) => req.headers['x-internal-token'] === 'fixture-internal',
        sessionId: (client) =>
          client === 'offline-client' ? f.registry.get(client)?.sessionId : undefined,
      }),
    );
    const previous = process.argv;
    process.argv = [
      'node',
      'telos',
      '--base-url',
      'http://fixture',
      '--client-id',
      'offline-client',
    ];
    vi.stubEnv('MITZO_INTERNAL_TOKEN', 'fixture-internal');
    try {
      await import('../telos-mcp-server.js');
    } finally {
      process.argv = previous;
    }
    const post = (route: string, body: object) =>
      request(app).post(route).set('x-operator', f.actor.id).send(body);
    const name = kind === 'create' ? 'TelosCreateOutcome' : 'TelosAdoptSource';
    const proposal =
      kind === 'create'
        ? {
            summary: 'Reviewed SDK outcome',
            intent: 'Result',
            rationale: 'Why',
            acceptanceCriteria: ['Evidence'],
            milestones: ['One'],
            profile: 'personal',
          }
        : { itemId: 'studio' };
    const hooks = buildSessionPermissionHooks(buildPermissionHandler('offline-client', f.registry));
    const pending = hooks.PreToolUse![0].hooks[0](
      {
        hook_event_name: 'PreToolUse',
        session_id: 'planning',
        transcript_path: '',
        cwd: '',
        tool_name: 'mcp__telos__' + name,
        tool_use_id: 'actual-sdk-' + kind,
        tool_input: proposal,
      },
      'actual-sdk-' + kind,
      { signal: new AbortController().signal },
    );
    let card: Record<string, unknown> | undefined;
    await vi.waitFor(() => {
      card ??= f.drainEvents().find((event) => event.type === 'permission_request');
      expect(card).toBeDefined();
    });
    const permId = String(card!.permId),
      base = '/api/telos/work/source/permissions/' + permId;
    path.mockClear();
    expect((await request(app).get(base).query({ sessionId: 'planning' })).status).toBe(403);
    expect(path).not.toHaveBeenCalled();
    const review = await request(app)
      .get(base)
      .query({ sessionId: 'planning' })
      .set('x-operator', f.actor.id);
    expect(review.status).toBe(200);
    expect(review.body.toolUseId).toBe('actual-sdk-' + kind);
    const message = review.body.messages.find(
      (message: { messageId: string }) => message.messageId === 'approved',
    );
    const input = {
      sessionId: 'planning',
      requestId: randomUUID(),
      proposalSha256: review.body.proposalSha256,
      selection: {
        mode: 'selected',
        boundary: { sequence: message.sequence, messageId: message.messageId },
        messageIds: [message.messageId],
        artifacts: [],
      },
    };
    const preview = await post(base + '/preview', input);
    expect(preview.status).toBe(200);
    const approved = { ...input, previewSha256: preview.body.preview.sha256 };
    const saved = await post(base + '/approve', approved);
    expect(saved.status).toBe(200);
    const resolution = await pending;
    expect(resolution).toHaveProperty('hookSpecificOutput.updatedInput.__mitzoTelosApproval');
    const updated = (
      resolution as { hookSpecificOutput: { updatedInput: Record<string, unknown> } }
    ).hookSpecificOutput.updatedInput;
    const registration = registrations.get(name)!;
    const parsed = z.object(registration.shape).parse(updated);
    expect(parsed.__mitzoTelosApproval).toBe(updated.__mitzoTelosApproval);
    const hostFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const response = await request(app)
        .post(new URL(String(url)).pathname)
        .set(init!.headers as Record<string, string>)
        .send(JSON.parse(String(init!.body)));
      return new Response(JSON.stringify(response.body), {
        status: response.status,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', hostFetch);
    const first = await registration.run(parsed);
    expect(first.isError).not.toBe(true);
    expect(JSON.parse(first.content[0].text)).toMatchObject({
      id: saved.body.receipt.work.itemId,
      path: '/todos/' + saved.body.receipt.work.itemId,
      sourceSnapshotId: saved.body.sourceSnapshotId,
    });
    expect(await registration.run(parsed)).toEqual(first);
    expect(f.counts().canonicalCreates).toBe(kind === 'create' ? 1 : 0);
    expect(f.counts().sources.total).toBe(1);
    const internal = await request(app)
      .post('/api/internal/telos/source/execute')
      .set('x-internal-token', 'fixture-internal')
      .set('x-client-id', 'offline-client')
      .send({ operation: kind, proposal, approvalReceiptId: randomUUID() });
    expect(internal.status).toBe(403);
  },
);
