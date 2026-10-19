import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EventStore } from '../event-store.js';
import type { CollaborationSettings } from '@mitzo/protocol';
import {
  compileCollaborationContext,
  compileCollaborationSourceContext,
  type AuthorizedCollaborationContext,
  type CollaborationCapacityAdapter,
} from '../collaboration-context-compiler.js';

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const settings = {
  binding: {
    version: 2,
    account: { accountId: 'fixture', provider: 'openai-codex', profileRevision: 'r1' },
    harness: { implementation: 'codex' },
    execution: { location: 'local', targetId: 'mac', targetRevision: 'r1' },
  },
  selection: {
    version: 1,
    agent: { profileId: 'default-mitzo', revision: 1, kind: 'builtin' },
    context: { source: 'none', revision: null },
    permission: { mode: 'agent', revision: 0 },
    model: 'offline-fixture',
    thinking: null,
  },
  repositoryWorkspaceId: 'workspace',
} as const;
const boundary = { sequence: 1000, messageId: 'm60' };
const pin = { artifactId: 'older-artifact', revision: 2, sha256: hash('revision two') };
const message = (n: number) => ({
  conversationId: 'one',
  messageId: `m${n}`,
  sequence: n * 10,
  author: n % 2 ? ('operator' as const) : { sessionId: 'one' },
  source: null,
  blocks: [{ blockId: `b${n}`, content: `Visible ${n}`, sha256: hash(`Visible ${n}`) }],
});
let messages: ReturnType<typeof message>[], source: AuthorizedCollaborationContext;
let adapter: CollaborationCapacityAdapter, store: EventStore;
function selection(mode: 'selected' | 'conversation_so_far' = 'conversation_so_far') {
  return {
    requestId: randomUUID(),
    expectedMembershipRevision: 1,
    sourceConversationId: 'one',
    boundary,
    mode,
    messageIds: [] as string[],
    artifacts: [] as (typeof pin)[],
    purpose: 'Review the implementation',
    joiningBrief: 'Check failure boundaries',
  };
}
function page(afterSequence = 0) {
  const slice = messages.filter((m) => m.sequence > afterSequence).slice(0, 50);
  const hasMore = messages.some((m) => m.sequence > (slice.at(-1)?.sequence ?? 0));
  return {
    sourceIdentity: 'visible-prefix-r1',
    afterSequence,
    throughSequence: hasMore ? slice.at(-1)!.sequence : boundary.sequence,
    hasMore,
    messages: slice,
    artifacts: afterSequence === 0 ? [pin] : [],
  };
}
beforeEach(() => {
  messages = Array.from({ length: 60 }, (_, n) => message(n + 1));
  source = {
    openConversation: vi.fn(async () => ({
      sourceIdentity: 'visible-prefix-r1',
      sourceConversationId: 'one',
      boundary,
      readPrefixWitness: vi.fn().mockResolvedValue({
        messageCount: messages.length,
        messagesSha256: hash(JSON.stringify(messages)),
        artifactPins: [pin],
      }),
      readPage: vi.fn(async (after: number) => page(after)),
      readSelected: vi.fn(async (ids: string[]) =>
        messages.filter((m) => ids.includes(m.messageId)),
      ),
      assertCurrent: vi.fn(async () => {}),
    })),
    authorizeArtifact: vi.fn(async () => {}),
    readArtifact: vi.fn(async () => ({
      ...pin,
      sourceConversationId: 'older-source',
      mediaType: 'text/plain',
      bytes: Buffer.from('revision two'),
    })),
  };
  adapter = {
    measure: vi.fn(async ({ settings, contextSha256 }) => ({
      settings,
      contextSha256,
      contextTokens: 100,
      bootTokens: 200,
      toolTokens: 300,
      adapterTokens: 40,
      reservedOutputTokens: 1000,
      contextWindowTokens: 4096,
      estimatorRevision: 'offline-tokenizer-v1',
    })),
  };
  store = new EventStore(':memory:');
});
afterEach(() => store.close());

it('retains reviewed source context without fabricating recipient settings or admitting execution', async () => {
  const selected = { ...selection('selected'), messageIds: ['m2', 'm1'], artifacts: [pin] };
  const draft = await compileCollaborationSourceContext(selected, source);
  expect(draft.messages.map((message) => message.messageId)).toEqual(['m1', 'm2']);
  expect(draft.artifacts[0].contentBase64).toBe(Buffer.from('revision two').toString('base64'));
  expect(draft.capacity.status).toBe('unverified');
  expect(adapter.measure).not.toHaveBeenCalled();
  expect(store.listSessions()).toEqual([]);
  await expect(compileCollaborationContext(selected, [], source, adapter)).rejects.toThrow();
});

it('compiles all pages, authorized older artifact bytes and measured overhead into an immutable review', async () => {
  const draft = await compileCollaborationContext(selection(), [settings], source, adapter);
  expect(draft.messages).toHaveLength(60);
  expect(draft.messages[0]).toEqual(message(1));
  expect(draft.messages.at(-1)).toEqual(message(60));
  expect(draft.artifacts[0]).toMatchObject({
    ...pin,
    sizeBytes: 12,
    contentBase64: Buffer.from('revision two').toString('base64'),
  });
  expect(source.authorizeArtifact).toHaveBeenCalledTimes(2);
  expect(draft.capacity).toMatchObject({
    status: 'ready',
    assessments: [
      {
        settings,
        estimatedTokens: 640,
        availableTokens: 3096,
        components: {
          contextTokens: 100,
          bootTokens: 200,
          toolTokens: 300,
          adapterTokens: 40,
          reservedOutputTokens: 1000,
          contextWindowTokens: 4096,
        },
      },
    ],
  });
  const group = randomUUID();
  store.upsertSession({ sessionId: 'one', conversationSource: 'mitzo' });
  store.collaborationConversation.begin(group, { requestId: randomUUID(), sessionId: 'one' });
  const saved = store.collaborationConversation.saveSnapshot(group, draft);
  messages[0].blocks[0].content = 'Edited after review';
  expect(store.collaborationConversation.getSnapshot(group, saved.snapshotId)).toEqual(saved);
  expect(store.getSessionEvents('one')).toEqual([]);
  expect(store.listSessions()).toHaveLength(1);
});

it('selected context reads exactly the selected messages in source order and explicit artifact revisions', async () => {
  const input = { ...selection('selected'), messageIds: ['m59', 'm2'], artifacts: [pin] };
  const draft = await compileCollaborationContext(input, [settings], source, adapter);
  expect(draft.messages.map((m) => m.messageId)).toEqual(['m2', 'm59']);
  expect(source.readArtifact).toHaveBeenCalledWith(pin);
});

it('preserves an attributed message original ordinary source independently of the discussion cursor', async () => {
  const original = {
    ...message(2),
    author: { sessionId: 'two' },
    source: {
      conversationId: 'two',
      commandId: 'ordinary-command',
      messageId: 'original-message',
      blockIds: ['b2'],
      throughSequence: 9000,
    },
  };
  const opened = await source.openConversation(selection());
  vi.mocked(opened.readSelected).mockResolvedValue([original]);
  vi.mocked(source.openConversation).mockResolvedValue(opened);
  const draft = await compileCollaborationContext(
    { ...selection('selected'), messageIds: ['m2'] },
    [settings],
    source,
    adapter,
  );
  expect(draft.messages[0].source).toEqual(original.source);
});

it('empty selected context is brief only and does not read conversation pages or artifacts', async () => {
  const opened = await source.openConversation(selection());
  vi.mocked(source.openConversation).mockResolvedValue(opened);
  const draft = await compileCollaborationContext(
    selection('selected'),
    [settings],
    source,
    adapter,
  );
  expect(draft.messages).toEqual([]);
  expect(draft.artifacts).toEqual([]);
  expect(opened.readPage).not.toHaveBeenCalled();
  expect(opened.readSelected).not.toHaveBeenCalled();
  expect(opened.readPrefixWitness).not.toHaveBeenCalled();
  expect(source.readArtifact).not.toHaveBeenCalled();
  expect(adapter.measure).toHaveBeenCalledWith(
    expect.objectContaining({
      context: expect.objectContaining({ joiningBrief: 'Check failure boundaries', messages: [] }),
    }),
  );
});

it('permits brief-only and narrow selections from discussions larger than the full-review limits', async () => {
  const opened = await source.openConversation(selection());
  vi.mocked(source.openConversation).mockResolvedValue({
    ...opened,
    readPrefixWitness: vi.fn().mockResolvedValue({
      messageCount: 2000,
      messagesSha256: 'a'.repeat(64),
      artifactPins: Array.from({ length: 101 }, (_, n) => ({
        ...pin,
        artifactId: `artifact-${n}`,
      })),
    }),
  });
  const brief = await compileCollaborationContext(
    selection('selected'),
    [settings],
    source,
    adapter,
  );
  expect(brief.messages).toEqual([]);
  const selected = await compileCollaborationContext(
    { ...selection('selected'), messageIds: ['m2'] },
    [settings],
    source,
    adapter,
  );
  expect(selected.messages.map((m) => m.messageId)).toEqual(['m2']);
});

it('recovers frozen artifact bytes and exact snapshot retries after EventStore restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mitzo-context-'));
  store.close();
  const path = join(directory, 'events.db');
  store = new EventStore(path);
  try {
    const draft = await compileCollaborationContext(selection(), [settings], source, adapter);
    const group = randomUUID();
    store.upsertSession({ sessionId: 'one', conversationSource: 'mitzo' });
    store.collaborationConversation.begin(group, { requestId: randomUUID(), sessionId: 'one' });
    const saved = store.collaborationConversation.saveSnapshot(group, draft);
    store.close();
    store = new EventStore(path);
    expect(store.collaborationConversation.getSnapshot(group, saved.snapshotId)).toEqual(saved);
    expect(store.collaborationConversation.saveSnapshot(group, draft)).toEqual(saved);
    expect(store.collaborationConversation.events(group, 0).events).toHaveLength(1);
    expect(Buffer.from(saved.artifacts[0].contentBase64!, 'base64').toString()).toBe(
      'revision two',
    );
  } finally {
    store.close();
    store = new EventStore(':memory:');
    rmSync(directory, { recursive: true, force: true });
  }
});

it('keeps capacity unverified without an exact ordinary adapter', async () => {
  const draft = await compileCollaborationContext(selection('selected'), [settings], source);
  expect(draft.capacity.status).toBe('unverified');
});

it('measures each independent exact account/target selection', async () => {
  const other = {
    ...settings,
    binding: {
      ...settings.binding,
      execution: { ...settings.binding.execution, location: 'openshell', targetId: 'sandbox' },
    },
  };
  const draft = await compileCollaborationContext(
    selection('selected'),
    [settings, other],
    source,
    adapter,
  );
  expect(adapter.measure).toHaveBeenCalledTimes(2);
  expect(draft.capacity).toMatchObject({
    status: 'ready',
    assessments: [{ settings }, { settings: other }],
  });
});

it('allows independent same-account agents with identical settings to share a capacity assessment', async () => {
  const draft = await compileCollaborationContext(
    selection('selected'),
    [settings, structuredClone(settings)],
    source,
    adapter,
  );
  expect(draft.capacity).toMatchObject({ status: 'ready', assessments: [{ settings }] });
  expect(adapter.measure).toHaveBeenCalledTimes(1);
});

it('refuses oversized artifact bytes before measuring or encoding a review', async () => {
  const artifact = await source.readArtifact(pin);
  vi.mocked(source.readArtifact).mockResolvedValue({
    ...artifact,
    bytes: Buffer.alloc(512 * 1024 + 1),
  });
  await expect(
    compileCollaborationContext(selection(), [settings], source, adapter),
  ).rejects.toThrow('capacity_refused');
  expect(adapter.measure).not.toHaveBeenCalled();
});

it('requires a separately reviewed summary when the whole measured packet does not fit', async () => {
  vi.mocked(adapter.measure).mockImplementation(async ({ settings, contextSha256 }) => ({
    settings,
    contextSha256,
    contextTokens: 3000,
    bootTokens: 200,
    toolTokens: 300,
    adapterTokens: 40,
    reservedOutputTokens: 1000,
    contextWindowTokens: 4096,
    estimatorRevision: 'offline-tokenizer-v1',
  }));
  const draft = await compileCollaborationContext(selection(), [settings], source, adapter);
  expect(draft.capacity.status).toBe('needs_reviewed_summary');
  expect(draft.summary).toBeNull();
  expect(draft.messages).toHaveLength(60);
});

it.each(['capacity', 'messages', 'access'])(
  'rejects caller-supplied %s proof before any source read',
  async (key) => {
    await expect(
      compileCollaborationContext({ ...selection(), [key]: {} }, [settings], source, adapter),
    ).rejects.toThrow();
    expect(source.openConversation).not.toHaveBeenCalled();
  },
);

it('does not read source content after access denial', async () => {
  vi.mocked(source.openConversation).mockRejectedValue(Error('Access denied'));
  await expect(
    compileCollaborationContext(selection(), [settings], source, adapter),
  ).rejects.toThrow('Access denied');
  expect(source.readArtifact).not.toHaveBeenCalled();
  expect(adapter.measure).not.toHaveBeenCalled();
});

it.each(['sourceIdentity', 'throughSequence', 'afterSequence', 'hasMore'])(
  'rejects incomplete or inconsistent page proof: %s',
  async (key) => {
    const opened = await source.openConversation(selection());
    vi.mocked(source.openConversation).mockResolvedValue(opened);
    vi.mocked(opened.readPage).mockResolvedValue({
      ...page(),
      [key]: {
        sourceIdentity: 'different-prefix',
        throughSequence: 0,
        afterSequence: 10,
        hasMore: false,
      }[key],
    });
    await expect(
      compileCollaborationContext(selection(), [settings], source, adapter),
    ).rejects.toThrow('snapshot_changed');
    expect(adapter.measure).not.toHaveBeenCalled();
  },
);

it.each(['missing', 'duplicate', 'wrong_conversation', 'future', 'bad_hash', 'wrong_boundary'])(
  'rejects source mismatch: %s',
  async (kind) => {
    if (kind === 'missing') messages = messages.slice(0, -1);
    if (kind === 'duplicate') messages[1] = messages[0];
    if (kind === 'wrong_conversation') messages[0].conversationId = 'private';
    if (kind === 'future') messages[0].sequence = 1001;
    if (kind === 'bad_hash') messages[0].blocks[0].sha256 = 'a'.repeat(64);
    if (kind === 'wrong_boundary') {
      const opened = await source.openConversation(selection());
      vi.mocked(source.openConversation).mockResolvedValue({
        ...opened,
        boundary: { ...boundary, sequence: 999 },
      });
    }
    await expect(
      compileCollaborationContext(selection(), [settings], source, adapter),
    ).rejects.toThrow('snapshot_changed');
  },
);

it('refuses missing selected messages instead of silently narrowing context', async () => {
  await expect(
    compileCollaborationContext(
      { ...selection('selected'), messageIds: ['missing'] },
      [settings],
      source,
      adapter,
    ),
  ).rejects.toThrow('snapshot_changed');
});

it('rejects a page that silently omits an interior message despite a terminal cursor', async () => {
  const opened = await source.openConversation(selection());
  vi.mocked(source.openConversation).mockResolvedValue(opened);
  messages.splice(5, 1);
  await expect(
    compileCollaborationContext(selection(), [settings], source, adapter),
  ).rejects.toThrow('snapshot_changed');
});

it('rejects pages that omit a referenced artifact version', async () => {
  const opened = await source.openConversation(selection());
  const read = opened.readPage;
  opened.readPage = vi.fn(async (after: number, limit: number) => ({
    ...(await read(after, limit)),
    artifacts: [],
  }));
  vi.mocked(source.openConversation).mockResolvedValue(opened);
  await expect(
    compileCollaborationContext(selection(), [settings], source, adapter),
  ).rejects.toThrow('snapshot_changed');
});

it('refuses duplicate selectors and mixed full/selected message selection', async () => {
  for (const input of [
    { ...selection('selected'), messageIds: ['m1', 'm1'] },
    { ...selection(), messageIds: ['m1'] },
    { ...selection('selected'), artifacts: [pin, pin] },
  ])
    await expect(compileCollaborationContext(input, [settings], source, adapter)).rejects.toThrow();
});

it.each(['revision', 'sha256', 'bytes'])(
  'refuses artifact version or byte mismatch: %s',
  async (key) => {
    const artifact = await source.readArtifact(pin);
    vi.mocked(source.readArtifact).mockResolvedValue({
      ...artifact,
      [key]: {
        revision: 3,
        sha256: hash('other'),
        bytes: Buffer.from('other'),
      }[key],
    });
    await expect(
      compileCollaborationContext(selection(), [settings], source, adapter),
    ).rejects.toThrow('snapshot_changed');
  },
);

it('requires artifact authority before reading and after measuring', async () => {
  vi.mocked(source.authorizeArtifact).mockRejectedValue(Error('Artifact access denied'));
  await expect(
    compileCollaborationContext(selection(), [settings], source, adapter),
  ).rejects.toThrow('Artifact access denied');
  expect(source.readArtifact).not.toHaveBeenCalled();
  vi.mocked(source.authorizeArtifact)
    .mockResolvedValueOnce()
    .mockRejectedValueOnce(Error('Revoked'));
  await expect(
    compileCollaborationContext(selection(), [settings], source, adapter),
  ).rejects.toThrow('Revoked');
});

it('refuses changed source authority at the final barrier', async () => {
  const opened = await source.openConversation(selection());
  vi.mocked(source.openConversation).mockResolvedValue(opened);
  vi.mocked(opened.assertCurrent).mockRejectedValue(Error('Source changed or revoked'));
  await expect(
    compileCollaborationContext(selection(), [settings], source, adapter),
  ).rejects.toThrow('Source changed or revoked');
});

it.each(['settings', 'contextSha256', 'bootTokens', 'contextTokens'])(
  'refuses measurement mismatch or invalid accounting: %s',
  async (key) => {
    const measure = adapter.measure;
    adapter.measure = vi.fn(async (input) => ({
      ...(await measure(input)),
      [key]: {
        settings: { ...settings, repositoryWorkspaceId: 'another' },
        contextSha256: 'a'.repeat(64),
        bootTokens: -1,
        contextTokens: Number.MAX_SAFE_INTEGER,
      }[key],
    }));
    await expect(
      compileCollaborationContext(selection('selected'), [settings], source, adapter),
    ).rejects.toThrow();
  },
);

it('refuses count and byte overflow without truncation or measurement', async () => {
  messages = Array.from({ length: 501 }, (_, n) => ({ ...message(n + 1), sequence: n + 1 }));
  await expect(
    compileCollaborationContext(selection(), [settings], source, adapter),
  ).rejects.toThrow('capacity_refused');
  messages = [message(60)];
  messages[0].blocks[0].content = '€'.repeat(180_000);
  messages[0].blocks[0].sha256 = hash(messages[0].blocks[0].content);
  await expect(
    compileCollaborationContext(selection(), [settings], source, adapter),
  ).rejects.toThrow('capacity_refused');
  expect(adapter.measure).not.toHaveBeenCalled();
});

it.each(['hash', 'size', 'encoding'])(
  'refuses invalid retained artifact %s at the EventStore boundary',
  async (kind) => {
    const draft = await compileCollaborationContext(selection(), [settings], source, adapter);
    const artifact = draft.artifacts[0];
    if (kind === 'hash') artifact.sha256 = 'a'.repeat(64);
    if (kind === 'size') artifact.sizeBytes++;
    if (kind === 'encoding') artifact.contentBase64 += '\n';
    const group = randomUUID();
    store.upsertSession({ sessionId: 'one', conversationSource: 'mitzo' });
    store.collaborationConversation.begin(group, { requestId: randomUUID(), sessionId: 'one' });
    expect(() => store.collaborationConversation.saveSnapshot(group, draft)).toThrow(
      'snapshot_changed',
    );
    expect(store.collaborationConversation.events(group, 0).events).toEqual([]);
  },
);

const nativeReviewGroup = randomUUID();
function compileWithReview(
  input: ReturnType<typeof selection>,
  selected: unknown,
  sources: AuthorizedCollaborationContext,
  capacity?: CollaborationCapacityAdapter,
  retain?: NonNullable<Parameters<typeof compileCollaborationContext>[4]>['retainNativeWitnesses'],
) {
  return compileCollaborationContext(input, selected, sources, capacity, {
    reviewIdentity: {
      collaborationId: nativeReviewGroup,
      operatorId: 'operator',
      requestId: input.requestId,
    },
    retainNativeWitnesses: retain,
  });
}
function nativeAdapter(overrides: Record<string, unknown> = {}): CollaborationCapacityAdapter {
  return {
    measure: vi.fn(async ({ settings, contextSha256 }) => ({
      kind: 'nativePreparedRequest' as const,
      scope: 'reviewContext' as const,
      settings,
      contextSha256,
      inputTokens: 3096,
      maxOutputTokens: 1000,
      contextWindowTokens: 4096,
      nativeWitness: {
        preparationId: 'private-preparation',
        requestIdentity: 'a'.repeat(64),
        witnessId: 'private-witness',
      },
      ...overrides,
    })),
  };
}

it('projects an exact whole-request total at equality without inventing additive buckets', async () => {
  const retain = vi.fn();
  const draft = await compileWithReview(
    selection('selected'),
    [settings],
    source,
    nativeAdapter(),
    retain,
  );
  expect(draft.capacity).toMatchObject({
    status: 'ready',
    assessments: [
      {
        kind: 'nativePreparedRequest',
        scope: 'reviewContext',
        settings,
        inputTokens: 3096,
        maxOutputTokens: 1000,
        contextWindowTokens: 4096,
        measurementId: expect.any(String),
      },
    ],
  });
  expect(JSON.stringify(draft)).not.toMatch(
    /private-preparation|private-witness|nativeOperationId|collaboration-review:|estimatedTokens|components/,
  );
  expect(retain).toHaveBeenCalledOnce();
  expect(retain.mock.calls[0][0][0]).toMatchObject({
    assessment: draft.capacity.status === 'ready' && draft.capacity.assessments[0],
    contextSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    nativeWitness: { preparationId: 'private-preparation', witnessId: 'private-witness' },
  });
});

it('refuses the next exact input token while retaining no native authority', async () => {
  const retain = vi.fn();
  const draft = await compileWithReview(
    selection('selected'),
    [settings],
    source,
    nativeAdapter({ inputTokens: 3097 }),
    retain,
  );
  expect(draft.capacity.status).toBe('needs_reviewed_summary');
  expect(retain).not.toHaveBeenCalled();
});

it.each([
  { inputTokens: -1 },
  { inputTokens: 0.5 },
  { inputTokens: Number.MAX_SAFE_INTEGER + 1 },
  {
    inputTokens: Number.MAX_SAFE_INTEGER,
    maxOutputTokens: 1,
    contextWindowTokens: Number.MAX_SAFE_INTEGER,
  },
  { maxOutputTokens: 0 },
  { contextWindowTokens: 0 },
  { scope: 'command' },
  { nativeWitness: { preparationId: '', requestIdentity: 'a'.repeat(64), witnessId: 'private' } },
  { nativeWitness: { preparationId: 'private', requestIdentity: 'invalid', witnessId: 'private' } },
  {
    nativeWitness: {
      preparationId: 'private',
      requestIdentity: 'a'.repeat(64),
      witnessId: 'bad id',
    },
  },
])('refuses invalid native measurement %j before retaining authority', async (overrides) => {
  const retain = vi.fn();
  await expect(
    compileWithReview(selection('selected'), [settings], source, nativeAdapter(overrides), retain),
  ).rejects.toThrow();
  expect(retain).not.toHaveBeenCalled();
});

it.each(['model', 'account', 'settings', 'context'] as const)(
  'binds native measurement to exact %s',
  async (field) => {
    const measured: CollaborationSettings = structuredClone(settings);
    if (field === 'model')
      measured.selection.model = 'different' as typeof measured.selection.model;
    if (field === 'account')
      measured.binding.account.accountId = 'different' as typeof measured.binding.account.accountId;
    if (field === 'settings')
      measured.repositoryWorkspaceId = 'different' as typeof measured.repositoryWorkspaceId;
    const retain = vi.fn();
    await expect(
      compileWithReview(
        selection('selected'),
        [settings],
        source,
        nativeAdapter(
          field === 'context' ? { contextSha256: 'b'.repeat(64) } : { settings: measured },
        ),
        retain,
      ),
    ).rejects.toThrow();
    expect(retain).not.toHaveBeenCalled();
  },
);

it('does not retain native witness when final source authorization fails', async () => {
  const opened = await source.openConversation(selection());
  vi.mocked(source.openConversation).mockResolvedValue(opened);
  vi.mocked(opened.assertCurrent).mockRejectedValue(Error('authority changed'));
  const retain = vi.fn();
  await expect(
    compileWithReview(selection('selected'), [settings], source, nativeAdapter(), retain),
  ).rejects.toThrow('authority changed');
  expect(retain).not.toHaveBeenCalled();
});

it.each(['unverified', 'refused'] as const)(
  'retains unavailable %s without a partial ready assessment',
  async (status) => {
    const other: CollaborationSettings = structuredClone(settings);
    other.selection.model = 'another' as typeof other.selection.model;
    const native = nativeAdapter();
    const mixed: CollaborationCapacityAdapter = {
      measure: async (input) =>
        input.settings.selection.model === settings.selection.model
          ? native.measure(input)
          : {
              kind: 'unavailable',
              status,
              reason: 'Selected native route is unavailable.',
              settings: input.settings,
              contextSha256: input.contextSha256,
            },
    };
    const retain = vi.fn();
    const draft = await compileWithReview(
      selection('selected'),
      [settings, other],
      source,
      mixed,
      retain,
    );
    expect(draft.capacity).toEqual({ status, reason: 'Selected native route is unavailable.' });
    expect(retain).not.toHaveBeenCalled();
  },
);

it.each(['settings', 'context'] as const)(
  'validates unavailable result %s binding',
  async (field) => {
    const retain = vi.fn();
    const unavailable: CollaborationCapacityAdapter = {
      measure: async (input) => ({
        kind: 'unavailable',
        status: 'refused',
        reason: 'Selected native route is unavailable.',
        settings:
          field === 'settings'
            ? { ...input.settings, repositoryWorkspaceId: 'changed' }
            : input.settings,
        contextSha256: field === 'context' ? 'b'.repeat(64) : input.contextSha256,
      }),
    };
    await expect(
      compileWithReview(selection('selected'), [settings], source, unavailable, retain),
    ).rejects.toThrow();
    expect(retain).not.toHaveBeenCalled();
  },
);

it('preserves the exact public 512 KiB limit independently of private native witness bytes', async () => {
  messages = [message(1)];
  messages[0].blocks = [
    { blockId: 'first', content: 'x'.repeat(490_000), sha256: hash('x'.repeat(490_000)) },
    { blockId: 'second', content: '', sha256: hash('') },
  ];
  const input = { ...selection('selected'), messageIds: ['m1'] };
  const baseline = await compileWithReview(input, [settings], source, nativeAdapter());
  const padding = 512 * 1024 - Buffer.byteLength(JSON.stringify(baseline));
  messages[0].blocks[1].content = 'x'.repeat(padding);
  messages[0].blocks[1].sha256 = hash(messages[0].blocks[1].content);
  const retain = vi.fn();
  const exact = await compileWithReview(input, [settings], source, nativeAdapter(), retain);
  expect(Buffer.byteLength(JSON.stringify(exact))).toBe(512 * 1024);
  expect(retain).toHaveBeenCalledOnce();
  messages[0].blocks[1].content += 'x';
  messages[0].blocks[1].sha256 = hash(messages[0].blocks[1].content);
  await expect(compileWithReview(input, [settings], source, nativeAdapter())).rejects.toThrow(
    'capacity_refused',
  );
});

it('keeps direct native measurement unverified without the original retained review identity', async () => {
  const capacity = nativeAdapter();
  const draft = await compileCollaborationContext(
    selection('selected'),
    [settings],
    source,
    capacity,
  );
  expect(draft.capacity.status).toBe('unverified');
  expect(vi.mocked(capacity.measure).mock.calls[0][0].nativeOperationId).toBeUndefined();
});

it('rejects a trusted review identity from a different original request before source reads', async () => {
  const input = selection('selected');
  await expect(
    compileCollaborationContext(input, [settings], source, nativeAdapter(), {
      reviewIdentity: {
        collaborationId: nativeReviewGroup,
        operatorId: 'operator',
        requestId: randomUUID(),
      },
    }),
  ).rejects.toThrow('snapshot_changed');
  expect(source.openConversation).not.toHaveBeenCalled();
});
