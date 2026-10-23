import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createServer, type Server } from 'node:http';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  NodeTracerProvider,
  SimpleSpanProcessor,
  InMemorySpanExporter,
} from '@opentelemetry/sdk-trace-node';
import { context, trace, ROOT_CONTEXT, type Context, type Span } from '@opentelemetry/api';
import {
  summarizePromptTiming,
  type PromptTimingCommand,
} from '../../scripts/lib/prompt-trace-timing.js';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import type { Response } from 'express';
import type { ownedOrdinaryRuntimeFixture } from './fixtures/owned-ordinary-workspace-runtime.js';
import type { SessionSseRegistry } from '../session-sse-registry.js';
import type { ConnectionRegistry } from '@mitzo/harness';

const services = vi.hoisted(() => ({ workspace: undefined as unknown }));
vi.mock('../repository-workspace-runtime.js', async (original) => ({
  ...(await original<object>()),
  getOrdinaryWorkspaces: () => services.workspace,
}));
vi.mock('../internal-token.js', () => ({
  INTERNAL_TOKEN: 'synthetic-only-ordinary-native-token',
  isValidInternalToken: () => false,
  createSignalCallbackToken: vi.fn(() => 'synthetic-callback'),
  revokeSignalCallbackToken: vi.fn(),
  isValidSignalCallbackToken: () => false,
}));
// Synthetic executable qualification only; no native executable/kernel/model is run.
vi.mock('../codex-native-artifact-qualification.js', async (original) => ({
  ...(await original<typeof import('../codex-native-artifact-qualification.js')>()),
  assertQualifiedNativeMacExecutionArtifact: vi.fn(),
}));
vi.mock('../mcp-config.js', () => ({
  loadMcpServers: () => ({}),
  getMcpConfigPaths: () => [],
  loadFromFile: () => ({}),
}));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => {
    throw Error('No SDK or real model execution');
  },
}));
vi.mock('../auto-rename.js', () => ({
  shouldAutoRename: () => {
    throw Error('No automatic model naming');
  },
}));
vi.mock('../notify.js', () => ({ sendTurnCompleteNotification: vi.fn(async () => {}) }));
vi.mock('../pushover.js', () => ({ sendTurnCompleteNotification: vi.fn(async () => {}) }));
vi.mock('../goal-client.js', () => ({
  createGoal: vi.fn(async () => null),
  reportUsage: vi.fn(async () => {}),
  deriveGoalTitle: () => 'Offline',
}));

const cleanup: Array<() => void | Promise<void>> = [];
let f: Awaited<ReturnType<typeof ownedOrdinaryRuntimeFixture>>;
let chat: typeof import('../chat.js');
let entry: typeof import('../ordinary-local-codex-entry.js');
let native: typeof import('../codex-app-server-client.js');
let auth: typeof import('../auth.js');
let transportAuth: typeof import('../transport-auth-ownership.js');
let streams: SessionSseRegistry;
let connections: ConnectionRegistry;
const exporter = new InMemorySpanExporter();
const processor = new SimpleSpanProcessor(exporter);
// The locked SDK quantizes each start with Date.now(), then offsets performance
// time independently per span. Capture real monotonic hook times without changing
// production spans or relaxing cross-span ordering for that clock quantization.
const monotonic = new Map<string, { start: [number, number]; end?: [number, number] }>();
const provider = new NodeTracerProvider({
  spanProcessors: [
    {
      onStart(span, parent) {
        monotonic.set(span.spanContext().spanId, { start: process.hrtime() });
        processor.onStart(span, parent);
      },
      onEnd(span) {
        const value = monotonic.get(span.spanContext().spanId);
        if (!value) throw Error('Trace ended without a start');
        value.end = process.hrtime();
        processor.onEnd(span);
      },
      forceFlush: () => processor.forceFlush(),
      shutdown: () => processor.shutdown(),
    },
  ],
});
provider.register();
const timingTracer = trace.getTracer('offline-prompt-timing');
const writes = new Map<string, Span>();
const writeQueuedTimes = new Map<string, [number, number]>();
const frames: Array<{ method: string; commandId?: string; threadId?: string }> = [];
let reply: (value: unknown) => void;
let finishHeld: (() => void) | undefined;
let turnSequence = 0;
let app: express.Express;
let server: Server;
let upstreamContext: Context | undefined;
const startup = await vi.hoisted(async () => {
  const fs = await import('node:fs'),
    os = await import('node:os'),
    path = await import('node:path');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-command-startup-')));
  vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', undefined);
  vi.stubEnv('REPO_PATH', root);
  vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', path.join(root, 'private'));
  vi.stubEnv('MITZO_SYMPOSIUM_CUSTODIAN_CONTROLLER', undefined);
  vi.stubEnv('MITZO_SYMPOSIUM_CUSTODIAN_OWNER', undefined);
  return { root, remove: () => fs.rmSync(root, { recursive: true, force: true }) };
});
beforeEach(async () => {
  vi.resetModules();
  turnSequence = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw Error('No external network or model calls');
    }),
  );
  const { ownedOrdinaryRuntimeFixture } =
    await import('./fixtures/owned-ordinary-workspace-runtime.js');
  // The fixture qualifies synthetic Mach-O artifacts; this is not host/kernel qualification.
  vi.stubGlobal('process', Object.create(process, { platform: { value: 'darwin' } }));
  f = await ownedOrdinaryRuntimeFixture(cleanup, {
    chatRoute: true,
  });
  services.workspace = f.workspaces;
  chat = await import('../chat.js');
  native = await import('../codex-app-server-client.js');
  // Transparent probe around the actual synchronous SQLite uncertainty transition.
  // This is the real durable admission boundary, not an enqueue/RPC promise.
  const claim = chat.eventStore.claimOrdinaryLocalCommandDispatch.bind(chat.eventStore);
  vi.spyOn(chat.eventStore, 'claimOrdinaryLocalCommandDispatch').mockImplementation((commandId) => {
    const span = timingTracer.startSpan('validation.admission.claim', {
      attributes: { 'mitzo.command.id': commandId },
    });
    try {
      const result = claim(commandId);
      expect(result).toBe(true);
      expect(chat.eventStore.getOrdinaryCommandAdmission(commandId)?.state).toBe('uncertain');
      return result;
    } finally {
      span.end();
    }
  });
  auth = await import('../auth.js');
  // The real chat EventStore is independently opened onto the same private database.
  expect(chat.eventStore.getSession(f.first.receipt.sessionId)?.ordinaryWorkspaceId).toBe(
    f.first.reserved.id,
  );
  transportAuth = await import('../transport-auth-ownership.js');
  const raw = f.first.rpc.request.getMockImplementation()!;
  vi.spyOn(native.CodexAppServerClient, 'launchIsolated').mockImplementation(
    (_home, _env, callbacks) => {
      expect(
        chat.eventStore.getLatestOrdinaryCommandAdmission(f.first.receipt.sessionId)?.state,
      ).toBe('uncertain');
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: vi.fn(),
      });
      reply = (value) => {
        child.stdout.write(JSON.stringify(value) + '\n');
      };
      child.stdin.on('data', (chunk: Buffer) => {
        const frame = JSON.parse(chunk.toString()) as {
          id?: number;
          method?: string;
          params?: { clientUserMessageId?: string; threadId?: string };
        };
        if (!frame.method || frame.id === undefined) return;
        frames.push({
          method: frame.method,
          commandId: frame.params?.clientUserMessageId,
          threadId: frame.params?.threadId,
        });
        void (async () => {
          let result: unknown = {};
          if (['account/read', 'model/list', 'config/read'].includes(frame.method!))
            result = await raw(frame.method!);
          if (frame.method === 'thread/start' || frame.method === 'thread/resume')
            result = {
              thread: { id: 'offline-ordinary-thread' },
              model: 'fixture-model',
              modelProvider: 'openai',
            };
          if (frame.method === 'turn/start') {
            const sequence = ++turnSequence;
            const turnId = 'offline-turn-' + sequence;
            // Real monotonic elapsed time, deliberately independent ACK/provider delay.
            await new Promise((resolve) => setTimeout(resolve, sequence === 2 ? 80 : 40));
            reply({
              method: 'turn/started',
              params: { threadId: 'offline-ordinary-thread', turn: { id: turnId } },
            });
            reply({ id: frame.id, result: { turn: { id: turnId } } });
            await new Promise((resolve) => setTimeout(resolve, 10));
            reply({
              method: 'item/agentMessage/delta',
              params: {
                threadId: 'offline-ordinary-thread',
                turnId,
                itemId: 'output-' + sequence,
                delta: 'Offline controlled output',
              },
            });
            const complete = () =>
              reply({
                method: 'turn/completed',
                params: {
                  threadId: 'offline-ordinary-thread',
                  turn: { id: turnId, status: 'completed' },
                },
              });
            if (sequence === 3) finishHeld = complete;
            else complete();
            return;
          }
          reply({ id: frame.id, result });
        })();
      });
      return new native.CodexAppServerClient(child, {
        lifecycle: callbacks,
        observeTurnStartWrite(receipt) {
          if (receipt.boundary === 'prepared') {
            if (writes.has(receipt.commandId)) throw Error('Duplicate command frame');
            expect(chat.eventStore.getOrdinaryCommandAdmission(receipt.commandId)).toBeDefined();
            const span = timingTracer.startSpan(
              'validation.turn.write',
              { attributes: { 'mitzo.command.id': receipt.commandId } },
              context.active(),
            );
            writes.set(receipt.commandId, span);
          } else {
            const span = writes.get(receipt.commandId);
            if (!span) throw Error('Write receipt without prepared frame');
            if (receipt.boundary === 'write_failed') throw Error('Offline stream failed');
            if (receipt.boundary === 'write_queued') {
              writeQueuedTimes.set(span.spanContext().spanId, process.hrtime());
              span.addEvent('write_queued');
            }
            if (receipt.boundary === 'write_completed') span.end();
          }
        },
      });
    },
  );
  for (const port of ['launch', 'launchOpenShell'] as const)
    vi.spyOn(native.CodexAppServerClient, port).mockImplementation(() => {
      throw Error('Alternate native process forbidden');
    });
  const { SessionSseRegistry } = await import('../session-sse-registry.js'),
    { SseTransport } = await import('../sse-transport.js'),
    { ConnectionRegistry } = await import('@mitzo/harness');
  connections = new ConnectionRegistry();
  streams = new SessionSseRegistry();
  streams.add(
    f.operatorConnectionId,
    { write: vi.fn(() => true), end: vi.fn(), writableEnded: false } as unknown as Response,
    f.auth.id,
  );
  connections.register(f.operatorConnectionId, new SseTransport(f.operatorConnectionId, streams));
  transportAuth.claimTransportConnection(f.operatorConnectionId, f.auth.id);
  chat.setConnectionRegistry(connections);
  entry = await import('../ordinary-local-codex-entry.js');
});
afterEach(async () => {
  if (chat && f) {
    auth.revokeAuthSession(f.auth);
    await vi.waitFor(() =>
      expect(chat.registry.findBySessionId(f.first.receipt.sessionId)).toBeNull(),
    );
    streams?.remove(f.operatorConnectionId);
    transportAuth.releaseTransportConnection(f.operatorConnectionId, f.auth.id);
    connections.dispose();
    chat.setConnectionRegistry(null);
    expect(chat.getConnectionRegistry()).toBeNull();
    chat.eventStore.close();
  }
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
// Each test owns a new private root; this initial import root contains no target.
import { afterAll } from 'vitest';
afterAll(async () => {
  startup.remove();
  await provider.shutdown();
});
async function mount() {
  app = express();
  app.use(express.json());
  app.use((_req, _res, next) => context.with(upstreamContext ?? context.active(), () => next()));
  app.use(
    '/api/ordinary/workspaces/commands',
    entry.createOwnedOrdinaryWorkspaceCommandRouter(streams, {
      connRegistry: connections,
      sessionRegistry: chat.registry,
      eventStore: chat.eventStore,
    }),
  );
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
}
const first = () => ({
  version: 2 as const,
  ...structuredClone(f.first.request),
  runOn: 'local' as const,
  sessionId: f.first.receipt.sessionId,
  workspace: { kind: 'ordinary' as const, workspaceId: f.first.reserved.id },
});
it('traces actual cold, warm and queued HTTP commands through durable custody to real client stream writes, ACK and output', async () => {
  await mount();
  const input = first();
  const expected: PromptTimingCommand[] = [];
  async function send(kind: PromptTimingCommand['kind'], initial = false) {
    const command = {
      ...input,
      clientMsgId: initial ? input.clientMsgId : randomUUID(),
      payload: initial ? input.payload : { text: 'Offline timing input' },
    };
    const traceId = randomUUID().replaceAll('-', '');
    expected.push({ commandId: command.clientMsgId, traceId, kind });
    const response = await request(server)
      .post('/api/ordinary/workspaces/commands/' + (initial ? 'first' : 'continue'))
      .set('Authorization', 'Bearer ' + f.token)
      .set('X-Connection-Id', f.operatorConnectionId)
      .set('traceparent', '00-' + traceId + '-1234567890abcdef-01')
      .send(command);
    expect(
      response.status,
      JSON.stringify({ response: response.body, methods: frames.map((f) => f.method) }),
    ).toBe(202);
    expect(response.body).toMatchObject({
      clientMsgId: command.clientMsgId,
      sessionId: input.sessionId,
      state: 'consumed',
    });
    return command.clientMsgId;
  }
  const nativeStore = (await import('../codex-chat-session.js')).getCodexConversationStore();
  const settled = () =>
    vi.waitFor(() => expect(nativeStore.hasRunningCommand(input.sessionId, f.binding)).toBe(false));
  await send('cold', true);
  await settled();
  await send('warm');
  await settled();
  await send('warm');
  await vi.waitFor(() => expect(finishHeld).toBeTypeOf('function'));
  const queuedSend = send('queued');
  await vi.waitFor(() =>
    expect(
      nativeStore.commands(input.sessionId, f.binding).filter((c) => c.status === 'queued'),
    ).toHaveLength(1),
  );
  // Hold an actual active predecessor, not a fake performance clock.
  await new Promise((resolve) => setTimeout(resolve, 30));
  finishHeld!();
  await queuedSend;
  await settled();
  expect(native.CodexAppServerClient.launchIsolated).toHaveBeenCalledOnce();
  expect(frames.filter((f) => f.method === 'initialize')).toHaveLength(1);
  expect(frames.filter((f) => f.method === 'thread/start')).toHaveLength(1);
  expect(frames.filter((f) => f.method === 'thread/resume')).toHaveLength(0);
  const turns = frames.filter((f) => f.method === 'turn/start');
  expect(turns.map((f) => f.commandId)).toEqual(expected.map((c) => c.commandId));
  expect(new Set(turns.map((f) => f.threadId))).toEqual(new Set(['offline-ordinary-thread']));
  expect(chat.eventStore.getSession(input.sessionId)?.ordinaryWorkspaceId).toBe(
    input.workspace.workspaceId,
  );
  for (const command of expected)
    expect(chat.eventStore.getOrdinaryCommandAdmission(command.commandId)?.state).toBe('consumed');
  await provider.forceFlush();
  const budget = process.env.MITZO_PROMPT_DISPATCH_BUDGET_MS;
  const result = summarizePromptTiming(
    exporter.getFinishedSpans().map((span) => {
      const times = monotonic.get(span.spanContext().spanId);
      if (!times?.end) throw Error('Finished trace lacks monotonic boundaries');
      return {
        ...span,
        spanContext: () => span.spanContext(),
        startTime: times.start,
        endTime: times.end,
        events: span.events.map((event) =>
          event.name === 'write_queued'
            ? { ...event, time: writeQueuedTimes.get(span.spanContext().spanId)! }
            : event,
        ),
        otel: { startTime: span.startTime, endTime: span.endTime, events: span.events },
      };
    }),
    expected,
    budget === undefined ? undefined : Number(budget),
  );
  expect(result.samples[3].ms.queueWait).toBeGreaterThanOrEqual(25);
  expect(result.samples[1].ms.writeCompletedToAck).toBeGreaterThanOrEqual(70);
  expect(f.forbidden).not.toHaveBeenCalled();
  expect(f.legacyLookup).not.toHaveBeenCalled();
  const artifact = {
    ...result,
    fixture: {
      browser: false,
      provider: 'controlled in-process stdio peer',
      syntheticMacArtifactQualification: true,
      sameConversation: true,
      bootstrapCount: 1,
      threadStartCount: 1,
      workspacePreparedBeforeMeasurement: true,
    },
    clock:
      'process.hrtime at genuine OTel SpanProcessor hooks; write_queued observer uses same monotonic clock; original OTel times also retained as relative offsets',
    runtime: process.version,
  };
  if (process.env.MITZO_PROMPT_TIMING_OUTPUT)
    await writeFile(
      process.env.MITZO_PROMPT_TIMING_OUTPUT,
      JSON.stringify(artifact, null, 2) + '\n',
      { mode: 0o600 },
    );
  console.log('OFFLINE_PROMPT_TIMING ' + JSON.stringify(result.summary));
  // Real upstream HTTP middleware context must survive an absent trace header.
  // Explicit malformed headers retain the existing strict parser's root behavior.
  const upstreamTrace = randomUUID().replaceAll('-', '');
  upstreamContext = trace.setSpanContext(ROOT_CONTEXT, {
    traceId: upstreamTrace,
    spanId: 'fedcba0987654321',
    traceFlags: 1,
  });
  for (const malformedHeader of [false, true]) {
    const commandId = randomUUID();
    let invalid = request(server)
      .post('/api/ordinary/workspaces/commands/first')
      .set('Authorization', 'Bearer ' + f.token)
      .set('X-Connection-Id', f.operatorConnectionId);
    if (malformedHeader) invalid = invalid.set('traceparent', 'malformed');
    expect((await invalid.send({ clientMsgId: commandId })).status).toBe(400);
    const entrySpan = exporter
      .getFinishedSpans()
      .find(
        (span) =>
          span.name === 'codex.command.http' && span.attributes['mitzo.command.id'] === commandId,
      )!;
    expect(entrySpan).toBeDefined();
    if (malformedHeader) expect(entrySpan.spanContext().traceId).not.toBe(upstreamTrace);
    else {
      expect(entrySpan.spanContext().traceId).toBe(upstreamTrace);
      expect(entrySpan.parentSpanContext?.spanId).toBe('fedcba0987654321');
    }
  }
  upstreamContext = undefined;
}, 30_000);
