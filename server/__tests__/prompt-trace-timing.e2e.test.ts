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
import { summarizePromptTiming, type PromptTimingCommand } from './fixtures/prompt-trace-timing.js';
import {
  startPhaseAResources,
  summarizePhaseA,
  type PhaseStart,
} from './fixtures/phase-a-measurement.js';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import type { Response } from 'express';
import type { ownedOrdinaryRuntimeFixture } from './fixtures/owned-ordinary-workspace-runtime.js';
import type { SessionSseRegistry } from '../session-sse-registry.js';
import type { ConnectionRegistry } from '@mitzo/harness';
import {
  summarizeMultiSession,
  parseSessionCount,
  type LoadCommand,
} from './fixtures/multi-session-measurement.js';

const loadSessions = process.env.MITZO_OFFLINE_LOAD_SESSIONS;
const sessionCount = loadSessions === undefined ? 2 : parseSessionCount(loadSessions);

const services = vi.hoisted(() => ({ workspace: undefined as unknown }));
// Do not import the real singleton while constructing this mock: the combined
// read/preparation graph can re-enter it and retain an unmocked singleton getter.
// The fixture still supplies the actual private RepositoryWorkspaces owner.
vi.mock('../repository-workspace-runtime.js', () => ({
  getOrdinaryWorkspaces: () => services.workspace,
  getRepositoryWorkspaces: () => {
    throw Error('No repository singleton in ordinary timing fixture');
  },
  getLocalRepositoryWorkspaces: () => {
    throw Error('No local repository singleton in ordinary timing fixture');
  },
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
const observedStarts: PhaseStart[] = [];
const provider = new NodeTracerProvider({
  spanProcessors: [
    {
      onStart(span, parent) {
        const start = process.hrtime();
        monotonic.set(span.spanContext().spanId, { start });
        observedStarts.push({ name: span.name, ...span.spanContext(), startTime: start });
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
let finishHeld: (() => void) | undefined;
const heldTurns = new Map<string, () => void>();
let multiSessionMode = false;
let clients = 0;
let preparedSessions: Array<Awaited<ReturnType<typeof ownedOrdinaryRuntimeFixture>>['first']> = [];
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
  exporter.reset();
  monotonic.clear();
  observedStarts.length = 0;
  frames.length = 0;
  writes.clear();
  writeQueuedTimes.clear();
  finishHeld = undefined;
  heldTurns.clear();
  multiSessionMode = false;
  clients = 0;
  upstreamContext = undefined;
  const nativeProcess = process;
  const dlopen = nativeProcess.dlopen;
  vi.spyOn(nativeProcess, 'dlopen').mockImplementation(function (this: NodeJS.Process, ...args) {
    if (/(?:better-sqlite3|better_sqlite3)/.test(args[1]))
      expect(
        globalThis.process === nativeProcess,
        'SQLite binding must load on the actual OS before synthetic Mac qualification',
      ).toBe(true);
    return Reflect.apply(dlopen, this, args);
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw Error('No external network or model calls');
    }),
  );
  // better-sqlite3 chooses its native prebuild lazily on first construction.
  // Load/cache the REAL host addon before simulating Mac runtime eligibility;
  // otherwise Linux selects darwin-*.node even though SQLite itself is real.
  const { default: Database } = await import('better-sqlite3');
  const sqlite = new Database(':memory:');
  try {
    expect(sqlite.prepare('SELECT 1 AS value').get()).toEqual({ value: 1 });
  } finally {
    sqlite.close();
  }
  const { ownedOrdinaryRuntimeFixture } =
    await import('./fixtures/owned-ordinary-workspace-runtime.js');
  // The fixture qualifies synthetic Mach-O artifacts; this is not host/kernel qualification.
  vi.stubGlobal('process', Object.create(process, { platform: { value: 'darwin' } }));
  f = await ownedOrdinaryRuntimeFixture(cleanup, {
    chatRoute: true,
  });
  preparedSessions = [f.first];
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
        preparedSessions.some(
          (session) =>
            chat.eventStore.getLatestOrdinaryCommandAdmission(session.receipt.sessionId)?.state ===
            'uncertain',
        ),
      ).toBe(true);
      const threadId = multiSessionMode ? 'offline-thread-' + ++clients : 'offline-ordinary-thread';
      let turnSequence = 0;
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: vi.fn(),
      });
      const reply = (value: unknown) => {
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
              thread: { id: threadId },
              model: 'fixture-model',
              modelProvider: 'openai',
            };
          if (frame.method === 'turn/start') {
            const sequence = ++turnSequence;
            const turnId = 'offline-turn-' + sequence;
            // Real monotonic elapsed time, deliberately independent ACK/provider delay.
            await new Promise((resolve) =>
              setTimeout(resolve, !multiSessionMode && sequence === 2 ? 80 : 40),
            );
            reply({
              method: 'turn/started',
              params: { threadId, turn: { id: turnId } },
            });
            reply({ id: frame.id, result: { turn: { id: turnId } } });
            await new Promise((resolve) => setTimeout(resolve, 10));
            reply({
              method: 'item/agentMessage/delta',
              params: {
                threadId,
                turnId,
                itemId: 'output-' + sequence,
                delta: 'Offline controlled output',
              },
            });
            const complete = () =>
              reply({
                method: 'turn/completed',
                params: {
                  threadId,
                  turn: { id: turnId, status: 'completed' },
                },
              });
            if (multiSessionMode && sequence === 2) heldTurns.set(threadId, complete);
            else if (!multiSessionMode && sequence === 3) finishHeld = complete;
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
    await vi.waitFor(() => {
      for (const session of preparedSessions)
        expect(chat.registry.findBySessionId(session.receipt.sessionId)).toBeNull();
    });
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
it.skipIf(loadSessions !== undefined)(
  'traces actual cold, warm and queued HTTP commands through durable custody to real client stream writes, ACK and output',
  async () => {
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
    // An idle native slot can precede the next queued command's asynchronous
    // claim. Wait for the exact submitted command, rather than that idle gap.
    const settled = (commandId: string) =>
      vi.waitFor(() =>
        expect(nativeStore.commandStatus(input.sessionId, f.binding, commandId)).toBe('completed'),
      );
    const startOffset = observedStarts.length;
    const resourceMonitor = startPhaseAResources();
    cleanup.push(() => {
      resourceMonitor.stop();
    });
    await settled(await send('cold', true));
    await settled(await send('warm'));
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
    await settled(await queuedSend);
    const resources = resourceMonitor.stop();
    const windowStarts = observedStarts.slice(startOffset);
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
      expect(chat.eventStore.getOrdinaryCommandAdmission(command.commandId)?.state).toBe(
        'consumed',
      );
    await provider.forceFlush();
    const budget = process.env.MITZO_PROMPT_DISPATCH_BUDGET_MS;
    const captured = capturedSpans();
    const result = summarizePromptTiming(
      captured,
      expected,
      budget === undefined ? undefined : Number(budget),
    );
    expect(result.samples[3].ms.queueWait).toBeGreaterThanOrEqual(25);
    expect(result.samples[1].ms.writeCompletedToAck).toBeGreaterThanOrEqual(70);
    expect(f.forbidden).not.toHaveBeenCalled();
    expect(f.legacyLookup).not.toHaveBeenCalled();
    const artifact = {
      ...result,
      phaseA: summarizePhaseA(
        captured.filter((s) =>
          windowStarts.some((start) => start.spanId === s.spanContext().spanId),
        ),
        windowStarts,
        expected,
      ),
      resources,
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
    expect(artifact).toMatchObject({
      phaseA: {
        coverage: { complete: true, unfinished: 0, unattributed: 0 },
        concurrency: { sessions: 1, commands: 4, maxOutstandingCommands: 2, maxActiveTurns: 1 },
        route: { account: 'synthetic-personal', model: 'fixture-model' },
      },
      resources: { eventLoop: { sampleCount: expect.any(Number) } },
    });
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
  },
  30_000,
);

function capturedSpans() {
  return exporter.getFinishedSpans().map((span) => {
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
  });
}

it('measures equal cold/warm/queued workloads through shared real owners in multiple isolated sessions', async () => {
  multiSessionMode = true;
  for (let i = 1; i < sessionCount; i++) preparedSessions.push(await f.prepareSibling());
  await mount();
  const nativeStore = (await import('../codex-chat-session.js')).getCodexConversationStore();
  const commands: LoadCommand[] = [];
  const inputs = preparedSessions.map((session) => ({
    version: 2 as const,
    ...structuredClone(session.request),
    runOn: 'local' as const,
    sessionId: session.receipt.sessionId,
    workspace: { kind: 'ordinary' as const, workspaceId: session.reserved.id },
  }));
  async function send(index: number, kind: LoadCommand['kind'], batchAt: [number, number]) {
    const input = inputs[index],
      initial = kind === 'cold';
    const command = {
      ...input,
      clientMsgId: initial ? input.clientMsgId : randomUUID(),
      payload: initial ? input.payload : { text: 'Equal offline workload' },
    };
    const traceId = randomUUID().replaceAll('-', '');
    commands.push({
      commandId: command.clientMsgId,
      traceId,
      kind,
      sessionId: input.sessionId,
      batchAt,
      issuedAt: process.hrtime(),
    });
    const response = await request(server)
      .post('/api/ordinary/workspaces/commands/' + (initial ? 'first' : 'continue'))
      .set('Authorization', 'Bearer ' + f.token)
      .set('X-Connection-Id', f.operatorConnectionId)
      .set('traceparent', '00-' + traceId + '-1234567890abcdef-01')
      .send(command);
    expect(response.status, JSON.stringify(response.body)).toBe(202);
    expect(response.body).toMatchObject({
      clientMsgId: command.clientMsgId,
      sessionId: input.sessionId,
      state: 'consumed',
    });
    return command.clientMsgId;
  }
  const settle = (index: number, commandId: string) =>
    vi.waitFor(
      () =>
        expect(nativeStore.commandStatus(inputs[index].sessionId, f.binding, commandId)).toBe(
          'completed',
        ),
      { timeout: 10_000 },
    );
  const batch = (kind: LoadCommand['kind']) => {
    const release = process.hrtime();
    return inputs.map((_, index) => send(index, kind, release));
  };
  const startOffset = observedStarts.length,
    monitor = startPhaseAResources();
  cleanup.push(() => {
    monitor.stop();
  });
  const cold = await Promise.all(batch('cold'));
  await Promise.all(cold.map((id, index) => settle(index, id)));
  const warm = await Promise.all(batch('warm'));
  await vi.waitFor(() => expect(heldTurns.size).toBe(sessionCount), { timeout: 10_000 });
  // Keep one real active turn per session until every follow-up is durably queued.
  const queued = Promise.all(batch('queued'));
  await vi.waitFor(
    () => {
      for (const input of inputs)
        expect(
          nativeStore.commands(input.sessionId, f.binding).filter((c) => c.status === 'queued'),
        ).toHaveLength(1);
    },
    { timeout: 10_000 },
  );
  const release = process.hrtime();
  for (const complete of heldTurns.values()) complete();
  const queuedIds = await queued;
  await Promise.all(
    inputs.flatMap((_, index) => [settle(index, warm[index]), settle(index, queuedIds[index])]),
  );
  const resources = monitor.stop();
  await provider.forceFlush();
  const starts = observedStarts.slice(startOffset),
    ids = new Set(starts.map((s) => s.spanId));
  const captured = capturedSpans().filter((s) => ids.has(s.spanContext().spanId));
  const measurement = summarizeMultiSession(captured, starts, commands, sessionCount);
  expect(measurement.coverage.complete).toBe(true);
  expect(measurement.concurrency).toMatchObject({
    sessions: sessionCount,
    commands: sessionCount * 3,
    maxActiveTurns: sessionCount,
  });
  expect(native.CodexAppServerClient.launchIsolated).toHaveBeenCalledTimes(sessionCount);
  expect(frames.filter((f) => f.method === 'thread/start')).toHaveLength(sessionCount);
  expect(frames.filter((f) => f.method === 'thread/resume')).toHaveLength(0);
  for (let index = 0; index < inputs.length; index++) {
    const own = commands.filter((c) => c.sessionId === inputs[index].sessionId);
    const turns = frames.filter((frame) => own.some((c) => c.commandId === frame.commandId));
    expect(turns.map((t) => t.commandId)).toEqual(own.map((c) => c.commandId));
    expect(new Set(turns.map((t) => t.threadId)).size).toBe(1);
    expect(chat.eventStore.getSession(inputs[index].sessionId)?.ordinaryWorkspaceId).toBe(
      inputs[index].workspace.workspaceId,
    );
    for (const command of own)
      expect(chat.eventStore.getOrdinaryCommandAdmission(command.commandId)?.state).toBe(
        'consumed',
      );
  }
  expect(new Set(frames.filter((f) => f.method === 'turn/start').map((f) => f.threadId)).size).toBe(
    sessionCount,
  );
  expect(f.forbidden).not.toHaveBeenCalled();
  expect(f.legacyLookup).not.toHaveBeenCalled();
  // Outside the measured window: cross-session workspace substitution must not
  // reach any adapter, and a subsequent correctly bound command still completes.
  if (inputs.length > 1) {
    const before = frames.filter((frame) => frame.method === 'turn/start').length;
    const rejected = await request(server)
      .post('/api/ordinary/workspaces/commands/continue')
      .set('Authorization', 'Bearer ' + f.token)
      .set('X-Connection-Id', f.operatorConnectionId)
      .send({
        ...inputs[0],
        clientMsgId: randomUUID(),
        workspace: inputs[1].workspace,
        payload: { text: 'Offline substitution probe' },
      });
    expect(rejected.status).toBeGreaterThanOrEqual(400);
    expect(rejected.status).toBeLessThan(500);
    expect(frames.filter((frame) => frame.method === 'turn/start')).toHaveLength(before);
    const commandId = randomUUID();
    const recovered = await request(server)
      .post('/api/ordinary/workspaces/commands/continue')
      .set('Authorization', 'Bearer ' + f.token)
      .set('X-Connection-Id', f.operatorConnectionId)
      .send({ ...inputs[0], clientMsgId: commandId, payload: { text: 'Offline recovery probe' } });
    expect(recovered.status).toBe(202);
    await settle(0, commandId);
  }
  const heldBarrierMs = commands
    .filter((c) => c.kind === 'queued')
    .map((c) => (release[0] - c.batchAt[0]) * 1000 + (release[1] - c.batchAt[1]) / 1e6)[0];
  const artifact = {
    ...measurement,
    resources,
    fixture: {
      provider: 'controlled in-process stdio peer per session',
      ackDelayMs: 40,
      outputAfterAckDelayMs: 10,
      queuePolicy:
        'hold every second turn until all third commands are durably queued, then release together',
      queuedBatchToReleaseMs: heldBarrierMs,
      workspacePreparedBeforeMeasurement: true,
      realOwners: [
        'HTTP router',
        'ordinary workspace custody',
        'SQLite EventStore',
        'CodexConversation queue',
        'CodexAppServerClient',
      ],
      syntheticMacArtifactQualification: true,
      nativeProcesses: 0,
      modelCalls: 0,
    },
  };
  if (process.env.MITZO_OFFLINE_LOAD_OUTPUT)
    await writeFile(
      process.env.MITZO_OFFLINE_LOAD_OUTPUT,
      JSON.stringify(artifact, null, 2) + '\n',
      { mode: 0o600 },
    );
  console.log(
    'OFFLINE_MULTI_SESSION ' +
      JSON.stringify({ sessions: sessionCount, concurrency: measurement.concurrency }),
  );
}, 60_000);
