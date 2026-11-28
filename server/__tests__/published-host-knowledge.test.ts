import { hostKnowledgePublication } from './fixtures/host-knowledge-publication.js';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import {
  installHostKnowledgeStore,
  observeHostKnowledgeSelection,
  prepareHostKnowledge,
  readHostKnowledge,
  recordHostKnowledgeSelectionSkipped,
} from '../published-host-knowledge.js';
import { KnowledgePublicationUnavailableError } from '../knowledge-publication-bridge.js';

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
provider.register();
afterAll(() => provider.shutdown());

let root: string;
const disposals: Array<() => void> = [];
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'host-knowledge-')));
});
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
  rmSync(root, { recursive: true, force: true });
});

it('traces each Local Codex knowledge selection outcome with bounded labels only', async () => {
  exporter.reset();
  const identity = { sessionId: 'session', commandId: 'command', route: 'openai-api' } as const;
  const signal = new AbortController().signal;
  const publication = hostKnowledgePublication(root, 'a', 'Accepted secret memory');
  const reconcile = vi
    .fn()
    .mockResolvedValueOnce(publication)
    .mockRejectedValueOnce(
      new KnowledgePublicationUnavailableError({ stage: 'http_status', status: 404 }),
    );
  disposals.push(installHostKnowledgeStore({ id: 'mgmt', reconcile }));
  const session = {};
  const select = () =>
    observeHostKnowledgeSelection(identity, signal, () =>
      prepareHostKnowledge(session, false, signal),
    );
  await expect(select()).resolves.toMatchObject({ sourceCommit: publication.sourceCommit });
  const failure = await select().catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(KnowledgePublicationUnavailableError);
  const hostFailure = Error(`private ${root}`);
  await expect(
    observeHostKnowledgeSelection(identity, signal, () => Promise.reject(hostFailure)),
  ).rejects.toBe(hostFailure);
  recordHostKnowledgeSelectionSkipped('store_not_enrolled', identity);
  const spans = exporter.getFinishedSpans();
  expect(spans.map((span) => span.name)).toEqual(Array(4).fill('local_codex.knowledge_selection'));
  expect(spans.map((span) => span.attributes)).toEqual([
    expect.objectContaining({
      'session.id': 'session',
      'mitzo.command.id': 'command',
      'codex.route': 'openai-api',
      'knowledge.outcome': 'success',
      'knowledge.reason': 'selected',
      'knowledge.source_commit': publication.sourceCommit.slice(0, 12),
    }),
    expect.objectContaining({
      'knowledge.outcome': 'unavailable',
      'knowledge.reason': 'publication_unavailable',
      'knowledge.failure_stage': 'http_status',
      'knowledge.failure_code': 'http_error',
      'knowledge.failure_status': 404,
    }),
    expect.objectContaining({
      'knowledge.outcome': 'unavailable',
      'knowledge.reason': 'host_view_unavailable',
      'knowledge.failure_code': 'unexpected_failure',
    }),
    expect.objectContaining({
      'knowledge.outcome': 'skipped',
      'knowledge.reason': 'store_not_enrolled',
    }),
  ]);
  expect(spans.map((span) => span.status.code)).toEqual([1, 2, 2, 1]);
  expect(JSON.stringify(spans.map((span) => [span.attributes, span.events]))).not.toMatch(
    new RegExp(`secret|private|${root}`),
  );
});

it('clears the prior view when preparing a later turn fails', async () => {
  const first = hostKnowledgePublication(root, 'a', 'Accepted');
  const reconcile = vi.fn().mockResolvedValueOnce(first).mockRejectedValueOnce(Error('offline'));
  disposals.push(installHostKnowledgeStore({ id: 'mgmt', reconcile }));
  const session = {};
  await prepareHostKnowledge(session, false, new AbortController().signal);
  await expect(prepareHostKnowledge(session, false, new AbortController().signal)).rejects.toThrow(
    'offline',
  );
  expect(await readHostKnowledge(session)).toBeUndefined();
});

it('does not deliver a selection after enrollment revocation or cancellation', async () => {
  const publication = hostKnowledgePublication(root, 'a', 'Accepted');
  let deliver!: (value: typeof publication) => void;
  const reconcile = vi.fn(
    () =>
      new Promise<typeof publication>((resolve) => {
        deliver = resolve;
      }),
  );
  const restore = installHostKnowledgeStore({ id: 'mgmt', reconcile });
  disposals.push(restore);
  const session = {};
  const selecting = prepareHostKnowledge(session, false, new AbortController().signal);
  restore();
  deliver(publication);
  await expect(selecting).rejects.toThrow('enrollment changed');
  expect(await readHostKnowledge(session)).toBeUndefined();
  const signal = AbortSignal.abort();
  disposals.push(
    installHostKnowledgeStore({ id: 'mgmt', reconcile: vi.fn().mockResolvedValue(publication) }),
  );
  await expect(prepareHostKnowledge(session, false, signal)).rejects.toThrow();
  expect(await readHostKnowledge(session)).toBeUndefined();
});

it('pins an active turn and refreshes the next one without refetching on tool reads or touching task files', async () => {
  const first = hostKnowledgePublication(root, 'a', 'First accepted memory', '0444');
  const second = hostKnowledgePublication(root, 'b', 'Second accepted memory');
  const reconcile = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
  disposals.push(installHostKnowledgeStore({ id: 'mgmt', reconcile }));
  const session = {};
  expect(
    (await prepareHostKnowledge(session, true, new AbortController().signal))?.sourceCommit,
  ).toBe(first.sourceCommit);
  expect(await readHostKnowledge(session, 'memory/Observations/lesson.md')).toMatchObject({
    content: 'First accepted memory',
  });
  expect(reconcile).toHaveBeenCalledOnce();
  await prepareHostKnowledge(session, true, new AbortController().signal);
  expect(await readHostKnowledge(session, 'memory/Observations/lesson.md')).toMatchObject({
    content: 'Second accepted memory',
  });
  expect(reconcile).toHaveBeenCalledTimes(2);
  writeFileSync(join(second.seed, 'memory/Observations/lesson.md'), 'corrupt');
  await expect(readHostKnowledge(session, 'memory/Observations/lesson.md')).rejects.toThrow();
  await expect(readHostKnowledge(session, '../baseline.json')).rejects.toThrow();
});
