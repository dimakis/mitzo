import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { ConnectionRegistry, SessionRegistry } from '@mitzo/harness';
import { EventStore } from '../event-store.js';
import { NativeCommandRegistry } from '../native-commands.js';
import { SkillRegistry } from '../skills.js';
import { handleSendV2, handleStopV2, type V2HandlerContext } from '../ws-handler-v2.js';
import { createChatRestRouter } from '../chat-rest-handler.js';
import { SessionSseRegistry } from '../session-sse-registry.js';
import { deliberateSessionId } from '../deliberate-admission.js';

const fake = vi.hoisted(() => ({ call: vi.fn(), factory: vi.fn(), route: 'one' }));
vi.mock('../../packages/harness/src/providers/index.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createProvider: fake.factory,
}));
vi.mock('../deliberate-route.js', () => ({ deliberateRouteRevision: () => fake.route }));
vi.mock('../chat.js', () => ({ BASE_REPO: '/tmp', isActive: () => false }));
vi.mock('../app.js', () => ({
  buildSkillRegistry: () => new SkillRegistry({}),
  isAllowedPath: () => true,
  NATIVE_COMMAND_NAMES: new Set(['deliberate', 'skills']),
}));

const reply = {
  content: 'answer',
  model: 'fake',
  usage: { inputTokens: 1, outputTokens: 1 },
  costUsd: 0.01,
};
describe('deliberation transport admission', () => {
  let ctx: V2HandlerContext;
  let app: express.Express;
  const msg = {
    type: 'send' as const,
    sessionId: 's',
    prompt: '/deliberate Design this',
    clientMsgId: 'c',
  };
  let sent: Record<string, unknown>[];
  const transport = {
    isOpen: () => true,
    send: (event: Record<string, unknown>) => {
      sent.push(event);
    },
  };
  beforeEach(() => {
    fake.route = 'one';
    fake.call.mockReset().mockResolvedValue(reply);
    fake.factory.mockReset().mockImplementation(() => ({ name: 'fake', call: fake.call }));
    sent = [];
    ctx = {
      eventStore: new EventStore(':memory:'),
      nativeCommands: new NativeCommandRegistry(),
      connRegistry: new ConnectionRegistry(),
      sessionRegistry: new SessionRegistry(),
    };
    ctx.eventStore.upsertSession({ sessionId: 's' });
    app = express();
    app.use(express.json());
    app.use('/api/chat', createChatRestRouter(new SessionSseRegistry(), ctx));
  });
  afterEach(() => {
    ctx.eventStore.close();
  });
  it.each(['ws', 'sse'])(
    '%s preserves command identity and rejects conflicts before provider/event side effects',
    async (kind) => {
      const send = async (body = msg) =>
        kind === 'ws'
          ? handleSendV2('conn', transport, body, ctx)
          : request(app).post('/api/chat/send').send(body);
      await send();
      await vi.waitFor(() =>
        expect(ctx.eventStore.getSession('s')?.executionPhase).toBe('TERMINAL'),
      );
      expect(ctx.eventStore.getExecutionAdmission('s', 'c')).toBeDefined();
      expect(fake.call).toHaveBeenCalledTimes(6);
      await send();
      const eventsBefore = ctx.eventStore
        .getEventsAfter('s', 0)
        .filter((e) => e.type === 'reasoning_event').length;
      const result = await send({ ...msg, prompt: '/deliberate changed' });
      if (kind === 'sse') expect(result).toMatchObject({ status: 409 });
      else expect(sent.at(-1)).toMatchObject({ type: 'error' });
      expect(fake.call).toHaveBeenCalledTimes(6);
      expect(
        ctx.eventStore.getEventsAfter('s', 0).filter((e) => e.type === 'reasoning_event'),
      ).toHaveLength(eventsBefore);
    },
  );
  it('revalidates actual provider route on HTTP receipt retries', async () => {
    await request(app).post('/api/chat/send').send(msg).expect(202);
    await vi.waitFor(() => expect(ctx.eventStore.getSession('s')?.executionPhase).toBe('TERMINAL'));
    fake.route = 'two';
    await request(app).post('/api/chat/send').send(msg).expect(409);
    expect(fake.call).toHaveBeenCalledTimes(6);
  });
  it.each(['ws', 'sse'])('%s usage-only commands create no execution or provider', async (kind) => {
    const usage = { ...msg, prompt: '/deliberate   ' };
    if (kind === 'ws') await handleSendV2('conn', transport, usage, ctx);
    else await request(app).post('/api/chat/send').send(usage).expect(202);
    expect(ctx.eventStore.getExecutionAdmission('s', 'c')).toBeUndefined();
    expect(fake.factory).not.toHaveBeenCalled();
  });
  it('shares stable sessionless identity across WS and SSE', async () => {
    const initial = { ...msg, sessionId: null };
    await handleSendV2('conn', transport, initial, ctx);
    const sessionId = deliberateSessionId('c');
    await vi.waitFor(() =>
      expect(ctx.eventStore.getSession(sessionId)?.executionPhase).toBe('TERMINAL'),
    );
    await request(app).post('/api/chat/send').send(initial).expect(202);
    expect(fake.call).toHaveBeenCalledTimes(6);
  });
  it('acknowledges admission without waiting for provider completion and supports stop', async () => {
    let release!: (value: typeof reply) => void;
    fake.call.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await request(app).post('/api/chat/send').send(msg).expect(202);
    expect(ctx.eventStore.getExecutionAdmission('s', 'c')).toBeDefined();
    handleStopV2('conn', { type: 'stop', sessionId: 's' }, ctx);
    expect(ctx.eventStore.getSession('s')?.executionTerminalReason).toBe('stopped');
    release(reply);
    await new Promise((resolve) => setImmediate(resolve));
    expect(fake.call).toHaveBeenCalledOnce();
  });
});
