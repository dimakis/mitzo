import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import express from 'express';
import request from 'supertest';
import { ConnectionRegistry } from '@mitzo/harness';
import { NativeCommandRegistry } from '../native-commands.js';
import { SessionSseRegistry } from '../session-sse-registry.js';
import { SseTransport } from '../sse-transport.js';
import {
  claimTransportConnection,
  releaseTransportConnection,
} from '../transport-auth-ownership.js';

const runtime = vi.hoisted(() => ({
  admitExplicitSend: vi.fn(),
  resumeAfterExplicitSend: vi.fn(async () => {}),
}));
vi.mock('../codex-chat-session.js', () => ({
  getCodexRuntime: () => runtime,
  publicCodexRuntimeError: () => 'Offline recovery failed',
}));
vi.mock('../responses-chat-session.js', () => ({ getResponsesRuntime: () => undefined }));
vi.mock('../mcp-config.js', () => ({ loadMcpServers: () => ({}) }));
vi.mock('../auto-rename.js', () => ({ shouldAutoRename: () => false }));
vi.mock('../app.js', () => ({
  buildSkillRegistry: () => new Map(),
  isAllowedPath: () => true,
  NATIVE_COMMAND_NAMES: new Set(),
}));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(() => {
    throw Error('Real model calls are forbidden');
  }),
}));

let chat: typeof import('../chat.js');
let createChatRestRouter: (typeof import('../chat-rest-handler.js'))['createChatRestRouter'];
const root = mkdtempSync(join(tmpdir(), 'mitzo-idle-retention-'));
beforeAll(async () => {
  vi.stubEnv('REPO_PATH', root);
  vi.stubEnv('WORKTREE_ENABLED', 'false');
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw Error('No network in idle retention fixture');
    }),
  );
  chat = await import('../chat.js');
  ({ createChatRestRouter } = await import('../chat-rest-handler.js'));
});
afterAll(() => {
  chat?.eventStore.close();
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it.each(['ready', 'failed', 'recovery-failed'] as const)(
  'returns a retained HTTP receipt through the actual attached-owner route before idle admission is %s',
  async (outcome) => {
    runtime.admitExplicitSend.mockReset();
    runtime.resumeAfterExplicitSend.mockClear();
    let rejectRecovery!: (error: Error) => void;
    if (outcome === 'recovery-failed')
      runtime.resumeAfterExplicitSend.mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectRecovery = reject;
          }),
      );
    const id = `attached-idle-${outcome}`;
    const connectionId = `owner-${outcome}`;
    const authId = `login-${outcome}`;
    const originalTransport = { send: vi.fn(), isOpen: () => true };
    const connections = new ConnectionRegistry();
    const streams = new SessionSseRegistry();
    const streamResponse = {
      write: vi.fn(() => true),
      end: vi.fn(),
      writableEnded: false,
    } as unknown as express.Response;
    streams.add(connectionId, streamResponse, authId);
    connections.register(connectionId, new SseTransport(connectionId, streams));
    claimTransportConnection(connectionId, authId);
    chat.eventStore.upsertSession({ sessionId: id, cwd: root, mode: 'agent' });
    chat.registry.register(id, {
      transport: originalTransport,
      abortController: new AbortController(),
      sessionAllowList: new Set(),
      mode: 'agent',
      sessionId: id,
      cwd: root,
      ownerConnectionId: connectionId,
    });
    chat.registry.get(id)!.inputQueue = { push: vi.fn(), close: vi.fn() };
    chat.eventStore.setSessionState(id, 'ACTIVE');
    let finish!: () => void;
    let reject!: (error: Error) => void;
    runtime.admitExplicitSend.mockImplementationOnce(
      () =>
        new Promise((resolve, fail) => {
          finish = () => resolve({ model: 'offline-fixture' });
          reject = fail;
        }),
    );
    const ctx = {
      connRegistry: connections,
      sessionRegistry: chat.registry,
      eventStore: chat.eventStore,
      nativeCommands: new NativeCommandRegistry(),
    };
    const app = express();
    app.use(express.json());
    app.use((_req, res, next) => {
      res.locals.authSession = { id: authId };
      next();
    });
    app.use('/api/chat', createChatRestRouter(streams, ctx));
    const server: Server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const command = {
      type: 'send',
      sessionId: id,
      prompt: 'Continue the exact saved request',
      clientMsgId: `${id}-command`,
    };
    const post = () =>
      request(server)
        .post('/api/chat/send')
        .set('X-Connection-ID', connectionId)
        .send(command)
        .timeout(1000);
    try {
      const first = await post();
      expect(first.status).toBe(202);
      expect(first.body).toMatchObject({
        accepted: true,
        retained: true,
        sessionId: id,
        clientMsgId: command.clientMsgId,
      });
      expect(chat.registry.get(id)!.transport).toBe(originalTransport);
      expect(chat.eventStore.hasUserMessage(id, command.clientMsgId)).toBe(true);
      expect(runtime.admitExplicitSend).toHaveBeenCalledOnce();
      expect(runtime.resumeAfterExplicitSend).not.toHaveBeenCalled();
      expect((await post()).body).toEqual(first.body);
      expect(runtime.admitExplicitSend).toHaveBeenCalledOnce();
      if (outcome === 'ready') {
        finish();
        await vi.waitFor(() => expect(runtime.resumeAfterExplicitSend).toHaveBeenCalledOnce());
        expect(chat.eventStore.getSendCommand(command.clientMsgId)?.error).toBeNull();
      } else {
        if (outcome === 'recovery-failed') {
          finish();
          await vi.waitFor(() => expect(runtime.resumeAfterExplicitSend).toHaveBeenCalledOnce());
          rejectRecovery(Error('private recovery detail'));
        } else reject(Error('private idle transport detail'));
        await vi.waitFor(() =>
          expect(chat.eventStore.getSendCommand(command.clientMsgId)?.error).toMatch(
            /^Message saved\./,
          ),
        );
        const errors = chat.eventStore
          .getSessionEvents(id)
          .filter((event) => event.type === 'error');
        expect(errors).toHaveLength(1);
        expect(errors[0].payload).toMatchObject({
          sessionId: id,
          clientMsgId: command.clientMsgId,
          error: expect.stringMatching(/^Message saved\./),
        });
        expect(originalTransport.send).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'error',
            seq: errors[0].seq,
            clientMsgId: command.clientMsgId,
          }),
        );
        const failedRetry = await post();
        expect(failedRetry.status).toBe(422);
        expect(failedRetry.body.error).toMatch(/^Message saved\./);
        expect(runtime.resumeAfterExplicitSend).toHaveBeenCalledTimes(
          outcome === 'recovery-failed' ? 1 : 0,
        );
      }
      expect(runtime.admitExplicitSend).toHaveBeenCalledOnce();
      expect(
        chat.eventStore.getSessionEvents(id).filter((event) => event.type === 'user_message'),
      ).toHaveLength(1);
    } finally {
      finish?.();
      await new Promise<void>((resolve, rejectClose) =>
        server.close((error) => (error ? rejectClose(error) : resolve())),
      );
      chat.registry.abort(id);
      streams.destroy();
      connections.dispose();
      releaseTransportConnection(connectionId, authId);
    }
  },
);
