import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createTelosCanonicalData } from './fixtures/telos-canonical-advisor.js';
import { TelosItemStore } from '../telos-item-store.js';
import {
  executeTelosBacklogOperation,
  telosBacklogDefinitions,
  type TelosBacklogToolName,
} from '../telos-backlog-tools.js';
import { createIntegrationToolDiscovery } from '../integration-tool-discovery.js';
import * as logging from '../logger.js';
import fs from 'node:fs';
import { telosDiagnosticFailure } from '../telos-operation-failure.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn());
});
function fixture(variant: 'fresh' | 'upgraded' = 'fresh') {
  const f = createTelosCanonicalData(variant);
  cleanup.push(() => f.close());
  const items = new TelosItemStore(f.dbPath);
  cleanup.push(() => items.close());
  let current = true;
  const assertCurrentSync = () => {
    if (!current) throw Error('retired');
  };
  const approve = vi.fn(async (_name: string, input: Record<string, unknown>) => ({
    behavior: 'allow' as const,
    updatedInput: input,
  }));
  const run = (
    name: TelosBacklogToolName,
    raw: Record<string, unknown>,
    guard = assertCurrentSync,
  ) =>
    executeTelosBacklogOperation(
      {
        items,
        work: f.work,
        events: f.events,
        approve,
        context: {
          operatorId: f.actor.id,
          conversationId: 'ordinary-chat',
          toolName: name,
          requestHash: createHash('sha256').update(JSON.stringify(raw)).digest('hex'),
          signal: new AbortController().signal,
          assertCurrentSync: guard,
          async assertCurrent() {
            assertCurrentSync();
          },
        },
      },
      name,
      raw,
    );
  return {
    ...f,
    items,
    run,
    approve,
    retire: () => {
      current = false;
    },
  };
}
it('returns the current named assignment separately from historical links, without starting work', async () => {
  const f = fixture();
  const command = (raw: Record<string, unknown>) =>
    f.work.execute(
      {
        itemId: 'studio',
        requestId: `context-${Math.random()}`,
        expectedRevision: f.work.read('studio', f.actor).revision,
        ...raw,
      },
      f.actor,
    );
  command({
    operation: 'link',
    role: 'lead',
    conversation: { namespace: 'mitzo', conversationId: 'planning' },
  });
  command({
    operation: 'assign',
    role: 'lead',
    conversationId: 'planning',
    expectedAssignmentRevision: 0,
  });
  const result = await f.run('TelosManageItem', { operation: 'read', itemId: 'studio' });
  expect(result.isError).toBe(false);
  const value = JSON.parse(result.content);
  expect(value.workContext).toMatchObject({
    revision: f.work.read('studio', f.actor).revision,
    currentLead: {
      conversationId: 'planning',
      name: 'Studio planning',
      assignmentRevision: 1,
      runtimeState: 'unknown',
      startEvidence: { state: 'unknown' },
    },
    currentWorker: null,
    latestAllocation: null,
  });
  expect(value.item.revision).toBe(f.items.read('studio').revision);
  expect(f.events.getOrdinaryInitialCommandId('planning')).toBeUndefined();
  expect(f.approve).not.toHaveBeenCalled();
});
it('discovers list, search and maintenance contracts by their exact callable identity', async () => {
  const f = fixture();
  const discovery = createIntegrationToolDiscovery({
    tools: [],
    directTools: telosBacklogDefinitions,
    directOnly: true,
    displayName: (name) => name,
    assertCurrent() {},
    execute: f.run as never,
  });
  const list = JSON.parse(
    (
      await discovery.execute(
        'ListIntegrationTools',
        { query: 'Telos' },
        new AbortController().signal,
      )
    ).content,
  );
  expect(list.tools.map((t: { toolId: string }) => t.toolId)).toEqual([
    'TelosListItems',
    'TelosSearchItems',
    'TelosManageItem',
    'TelosCreateChild',
    'TelosCreateFeature',
  ]);
  for (const { toolId } of list.tools) {
    const described = await discovery.execute(
      'DescribeIntegrationTool',
      { toolId },
      new AbortController().signal,
    );
    expect(described.isError).toBe(false);
    expect(JSON.parse(described.content)).toMatchObject({
      toolId,
      invocation: 'direct',
      inputSchema: { type: 'object' },
    });
  }
});
const featureBrief = {
  requestId: 'standalone-feature',
  summary: 'Create standalone Telos features',
  intent: 'Save a complete feature contract without an outcome wrapper.',
  rationale: 'A single feature can have its own slices.',
  acceptanceCriteria: ['An ordinary chat can create, inspect and decompose the feature.'],
  note: 'User authorized this standalone feature.',
};
it('repairs an unclassified existing feature with exact approval, stable replay and its original ID', async () => {
  const f = fixture();
  const original = f.items.read('studio');
  const request = {
    operation: 'edit',
    itemId: 'studio',
    requestId: 'repair-level',
    expectedRevision: original.revision,
    workLevel: 'feature',
    note: 'Classify the existing feature for reviewed lead setup',
  };
  const result = await f.run('TelosManageItem', request);
  expect(result.isError).toBe(false);
  expect(JSON.parse(result.content).item).toMatchObject({
    id: 'studio',
    workLevel: 'feature',
    summary: original.summary,
  });
  expect(f.approve).toHaveBeenCalledWith('TelosManageItem', request, expect.any(AbortSignal));
  expect(f.work.read('studio', f.actor)).toMatchObject({
    kind: 'outcome',
    assignments: [],
    attempts: [],
  });
  expect(await f.run('TelosManageItem', request)).toEqual(result);
  expect(f.db.prepare('SELECT count(*) AS n FROM items').get()).toEqual({ n: 1 });
  const changed = await f.run('TelosManageItem', {
    ...request,
    requestId: 'convert-existing',
    expectedRevision: f.items.read('studio').revision,
    workLevel: 'outcome',
  });
  expect(changed.isError).toBe(true);
  expect(changed.content).toContain('already classified');
});
it('refuses invalid slice classification and rolls back its audit receipt', async () => {
  const f = fixture();
  const before = f.items.read('studio');
  const result = await f.run('TelosManageItem', {
    operation: 'edit',
    itemId: 'studio',
    requestId: 'invalid-level',
    expectedRevision: before.revision,
    workLevel: 'slice',
    note: 'Invalid root slice',
  });
  expect(result.isError).toBe(true);
  expect(result.content).toContain('does not match its parent');
  expect(f.items.read('studio')).toEqual(before);
  expect(f.work.read('studio', f.actor).kind).toBeNull();
});
it('preserves existing role links when an unclassified item already has a lead', async () => {
  const f = fixture();
  f.work.execute(
    {
      operation: 'link',
      itemId: 'studio',
      requestId: 'existing-lead',
      expectedRevision: f.work.read('studio', f.actor).revision,
      role: 'lead',
      conversation: { namespace: 'mitzo', conversationId: 'planning' },
    },
    f.actor,
  );
  const before = f.items.read('studio');
  const work = f.work.read('studio', f.actor);
  const result = await f.run('TelosManageItem', {
    operation: 'edit',
    itemId: 'studio',
    requestId: 'unsafe-level',
    expectedRevision: before.revision,
    workLevel: 'feature',
    note: 'Must preserve the existing role',
  });
  expect(result.isError).toBe(true);
  expect(result.content).toContain('cannot change after lead or worker setup');
  expect(f.items.read('studio')).toEqual(before);
  expect(f.work.read('studio', f.actor)).toEqual(work);
});
it('creates a feature and slice that the existing lead and worker setup can use', async () => {
  const f = fixture();
  const feature = JSON.parse((await f.run('TelosCreateFeature', featureBrief)).content);
  expect(f.work.read(feature.item.id, f.actor).kind).toBe('outcome');
  const slice = JSON.parse(
    (
      await f.run('TelosCreateChild', {
        ...featureBrief,
        requestId: 'feature-slice',
        parentId: feature.item.id,
        expectedParentRevision: feature.item.revision,
        summary: 'Deliver one slice',
      })
    ).content,
  );
  expect(slice.ok).toBe(true);
  expect(f.work.read(slice.item.id, f.actor).kind).toBe('work_item');
  expect(f.work.read(feature.item.id, f.actor).assignments).toEqual([]);
  expect(f.work.read(slice.item.id, f.actor).attempts).toEqual([]);
  const replay = JSON.parse((await f.run('TelosCreateFeature', featureBrief)).content);
  expect(replay).toEqual(feature);
});
it('creates a feature beneath an explicitly classified shared outcome', async () => {
  const f = fixture();
  f.work.execute(
    {
      operation: 'classify',
      itemId: 'studio',
      requestId: 'shared-outcome',
      expectedRevision: f.work.read('studio', f.actor).revision,
      kind: 'coordinator',
    },
    f.actor,
  );
  const result = JSON.parse(
    (
      await f.run('TelosCreateChild', {
        ...featureBrief,
        parentId: 'studio',
        expectedParentRevision: f.items.read('studio').revision,
      })
    ).content,
  );
  expect(result.ok).toBe(true);
  expect(f.work.read(result.item.id, f.actor).kind).toBe('outcome');
});
it('requires a fresh parent review after its work level changes', async () => {
  const f = fixture();
  const expectedParentRevision = f.items.read('studio').revision;
  f.work.execute(
    {
      operation: 'classify',
      itemId: 'studio',
      requestId: 'level-change',
      expectedRevision: f.work.read('studio', f.actor).revision,
      kind: 'coordinator',
    },
    f.actor,
  );
  const result = await f.run('TelosCreateChild', {
    ...featureBrief,
    parentId: 'studio',
    expectedParentRevision,
  });
  expect(result.isError).toBe(true);
  expect(result.content).toContain('read the parent again');
  expect(f.items.read('studio').children).toEqual([]);
});
it('reports rejected asynchronous backlog authority and preserves the failed operation without saving a feature', async () => {
  const f = fixture();
  const warn = vi.fn();
  vi.spyOn(logging, 'createLogger').mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    warn,
    error: vi.fn(),
  });
  const result = await f.run('TelosCreateFeature', featureBrief, async () => {
    throw Error('private upstream payload');
  });
  expect(result.isError).toBe(true);
  expect(result.content).toContain('mutation not confirmed');
  await vi.waitFor(() =>
    expect(warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        stage: 'backlog-authority',
        code: 'ASYNC_AUTHORITY_REJECTED',
        conversationId: 'ordinary-chat',
        diagnosticId: expect.any(String),
        requestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ),
  );
  expect(JSON.stringify(warn.mock.calls)).not.toContain('private upstream payload');
  expect(f.approve).not.toHaveBeenCalled();
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM items').get()).toEqual({ n: 1 });
});
it('retains a rejected asynchronous authority without an unhandled rejection when its logger also fails', async () => {
  const f = fixture();
  const original = new Error('PRIVATE authority failure');
  const diagnosticCause = new Error('PRIVATE logger failure');
  const fallback = vi.spyOn(fs, 'write').mockImplementation(((
    _fd: number,
    line: string,
    done: (error: Error | null, written: number) => void,
  ) => {
    done(null, Buffer.byteLength(line));
  }) as typeof fs.write);
  vi.spyOn(logging, 'createLogger').mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warn: () => {
      throw diagnosticCause;
    },
  });
  expect(() =>
    f.items.createFeatureGuarded(featureBrief, 'ordinary-chat', async () => {
      throw original;
    }),
  ).toThrow('Synchronous Telos item authority required');
  await vi.waitFor(() => expect(fallback).toHaveBeenCalledTimes(1));
  const line = String(fallback.mock.calls[0][1]);
  const diagnostic = JSON.parse(line);
  expect(diagnostic).toMatchObject({
    code: 'telos_diagnostic_sink_failed',
    stage: 'item-authority',
  });
  expect(line).not.toContain('PRIVATE');
  expect(telosDiagnosticFailure(diagnostic.diagnosticId)).toMatchObject({
    operationCause: original,
    diagnosticCause,
  });
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM items').get()).toEqual({ n: 1 });
});
it('reports a rejected asynchronous item guard without leaking its private error or saving a feature', async () => {
  const f = fixture();
  const warn = vi.fn();
  vi.spyOn(logging, 'createLogger').mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    warn,
    error: vi.fn(),
  });
  expect(() =>
    f.items.createFeatureGuarded(featureBrief, 'ordinary-chat', async () => {
      throw Error('private upstream payload');
    }),
  ).toThrow('Synchronous Telos item authority required');
  await vi.waitFor(() =>
    expect(warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        stage: 'item-authority',
        code: 'ASYNC_AUTHORITY_REJECTED',
        diagnosticId: expect.any(String),
      }),
    ),
  );
  expect(JSON.stringify(warn.mock.calls)).not.toContain('private upstream payload');
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM items').get()).toEqual({ n: 1 });
});
it.each(['fresh', 'upgraded'] as const)(
  'creates one standalone feature with canonical provenance, a replayable receipt and no implied session setup (%s)',
  async (variant) => {
    const f = fixture(variant);
    const result = await f.run('TelosCreateFeature', featureBrief);
    expect(result.isError).toBe(false);
    const receipt = JSON.parse(result.content);
    expect(receipt).toMatchObject({
      ok: true,
      item: { summary: featureBrief.summary, parentId: null, status: 'active' },
      preparation: {
        dedicatedConversationCreated: false,
        sourceFilesSaved: false,
        originatingConversationId: 'ordinary-chat',
      },
    });
    expect(f.approve).toHaveBeenCalledWith(
      'TelosCreateFeature',
      featureBrief,
      expect.any(AbortSignal),
    );
    expect(f.items.read(receipt.item.id)).toMatchObject({
      intent: featureBrief.intent,
      rationale: featureBrief.rationale,
      acceptanceCriteria: featureBrief.acceptanceCriteria,
      updates: [{ note: featureBrief.note, sessionId: 'ordinary-chat' }],
    });
    expect(await f.run('TelosCreateFeature', featureBrief)).toEqual(result);
    expect(
      (await f.run('TelosCreateFeature', { ...featureBrief, summary: 'Different' })).isError,
    ).toBe(true);
    const child = await f.run('TelosCreateChild', {
      ...featureBrief,
      requestId: 'feature-slice',
      parentId: receipt.item.id,
      expectedParentRevision: receipt.item.revision,
      summary: 'Implement the creator',
    });
    expect(child.isError).toBe(false);
    expect(JSON.parse(child.content).item.parentId).toBe(receipt.item.id);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM items WHERE parent_id IS NULL').get()).toEqual({
      n: 2,
    });
  },
);
it('recovers the original feature receipt after owner restart and archive without creating a duplicate', async () => {
  const f = fixture();
  const created = await f.run('TelosCreateFeature', featureBrief);
  const saved = JSON.parse(created.content);
  expect(
    (
      await f.run('TelosManageItem', {
        operation: 'archive',
        itemId: saved.item.id,
        requestId: 'archive-feature',
        expectedRevision: f.work.readLifecycle(saved.item.id, f.actor).revision,
      })
    ).isError,
  ).toBe(false);
  f.restartOwners();
  const reloaded = new TelosItemStore(f.dbPath);
  cleanup.push(() => reloaded.close());
  expect(reloaded.createFeatureGuarded(featureBrief, 'ordinary-chat', () => {})).toEqual({
    item: saved.item,
    update: saved.update,
  });
  expect(await f.run('TelosCreateFeature', featureBrief)).toEqual(created);
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM items').get()).toEqual({ n: 2 });
});
it('rolls back feature, history and receipt together when the canonical writer fails', async () => {
  const f = fixture();
  f.db.exec(`CREATE TRIGGER refuse_feature_history BEFORE INSERT ON history
    WHEN NEW.item_id != 'studio' BEGIN SELECT RAISE(ABORT, 'fixture history failure'); END;`);
  const failed = await f.run('TelosCreateFeature', featureBrief);
  expect(failed.isError).toBe(true);
  expect(failed.content).toContain('mutation not confirmed');
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM items').get()).toEqual({ n: 1 });
  f.db.exec('DROP TRIGGER refuse_feature_history');
  expect((await f.run('TelosCreateFeature', featureBrief)).isError).toBe(false);
});
it('refuses invalid, denied, modified and retired feature creation before any canonical effects', async () => {
  const f = fixture();
  for (const extra of [
    { parentId: 'studio' },
    { milestones: ['Invented wrapper'] },
    { acceptanceCriteria: [] },
  ])
    expect((await f.run('TelosCreateFeature', { ...featureBrief, ...extra })).isError).toBe(true);
  expect(f.approve).not.toHaveBeenCalled();
  f.approve.mockImplementationOnce(async () => ({ behavior: 'deny' }) as never);
  expect((await f.run('TelosCreateFeature', featureBrief)).content).toContain('approval');
  f.approve.mockImplementationOnce(async (_name, input) => ({
    behavior: 'allow',
    updatedInput: { ...input, summary: 'Substituted' },
  }));
  expect((await f.run('TelosCreateFeature', featureBrief)).isError).toBe(true);
  f.approve.mockImplementationOnce(async (_name, input) => {
    f.retire();
    return { behavior: 'allow', updatedInput: input };
  });
  expect((await f.run('TelosCreateFeature', featureBrief)).isError).toBe(true);
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM items').get()).toEqual({ n: 1 });
});
it('lets an ordinary authenticated chat find and inspect an item without assigning a lead role', async () => {
  const f = fixture();
  const list = await f.run('TelosSearchItems', { query: 'studio' });
  expect(list.isError).toBe(false);
  expect(JSON.parse(list.content).items.map((i: { id: string }) => i.id)).toEqual(['studio']);
  expect(f.approve).not.toHaveBeenCalled();
  const read = await f.run('TelosManageItem', { operation: 'read', itemId: 'studio' });
  expect(JSON.parse(read.content)).toMatchObject({
    item: { id: 'studio', summary: 'Home studio' },
    lifecycle: { itemId: 'studio', disposition: 'active' },
  });
});
it('pages oversized legacy briefs without losing content or exceeding the tool result limit', async () => {
  const f = fixture();
  const title = 'Long legacy explanation '.repeat(50000);
  f.db.prepare('UPDATE items SET summary=? WHERE id=?').run(title, 'studio');
  let offset = 0;
  let reconstructed = '';
  let hash: string | undefined;
  for (;;) {
    const result = await f.run('TelosManageItem', { operation: 'read', itemId: 'studio', offset });
    expect(result.isError).toBe(false);
    expect(Buffer.byteLength(result.content)).toBeLessThan(64 * 1024);
    const page = JSON.parse(result.content);
    expect(page.format).toBe('json-fragment');
    hash ??= page.snapshotHash;
    expect(page.snapshotHash).toBe(hash);
    reconstructed += page.contentFragment;
    if (page.nextOffset === null) break;
    offset = page.nextOffset;
  }
  expect(JSON.parse(reconstructed).item.summary).toBe(title);
});
it('approves exact brief edits and canonical archive/unarchive with retryable receipts', async () => {
  const f = fixture();
  const edit = {
    operation: 'edit',
    itemId: 'studio',
    requestId: 'edit',
    expectedRevision: f.items.read('studio').revision,
    summary: 'Select studio panels',
    note: 'Make the title actionable.',
  };
  expect((await f.run('TelosManageItem', edit)).isError).toBe(false);
  expect(f.items.read('studio')).toMatchObject({ summary: edit.summary, status: 'active' });
  const command = {
    operation: 'archive',
    itemId: 'studio',
    requestId: 'archive',
    expectedRevision: f.work.readLifecycle('studio', f.actor).revision,
  };
  const archive = await f.run('TelosManageItem', command);
  expect(archive.isError).toBe(false);
  expect(await f.run('TelosManageItem', command)).toEqual(archive);
  expect(JSON.parse((await f.run('TelosListItems', {})).content).items).toEqual([]);
  expect(
    (
      await f.run('TelosManageItem', {
        ...command,
        operation: 'unarchive',
        requestId: 'unarchive',
        expectedRevision: f.work.readLifecycle('studio', f.actor).revision,
      })
    ).isError,
  ).toBe(false);
  expect(f.items.read('studio').status).toBe('active');
});
it('records ordinary-chat progress and completion with exact approval and durable replay', async () => {
  const f = fixture();
  const input = {
    operation: 'update',
    itemId: 'studio',
    requestId: 'ordinary-progress',
    expectedRevision: f.items.read('studio').revision,
    note: 'Verified the acoustic plan; ready for review.',
    status: 'completed',
  };
  const result = await f.run('TelosManageItem', input);
  expect(result.isError).toBe(false);
  expect(f.approve).toHaveBeenCalledWith('TelosManageItem', input, expect.any(AbortSignal));
  expect(f.items.read('studio')).toMatchObject({
    status: 'completed',
    updates: [{ note: input.note, sessionId: 'ordinary-chat' }],
  });
  expect(await f.run('TelosManageItem', input)).toEqual(result);
  expect((await f.run('TelosManageItem', { ...input, note: 'Different evidence' })).isError).toBe(
    true,
  );
});
it('rejects destructive, empty, spoofed and approval-modified requests, including retirement during approval', async () => {
  const f = fixture();
  for (const raw of [
    { operation: 'delete_permanently', itemId: 'studio' },
    { operation: 'read', itemId: 'studio', operatorId: 'spoofed' },
    {
      operation: 'edit',
      itemId: 'studio',
      requestId: 'empty',
      expectedRevision: f.items.read('studio').revision,
      note: 'Nothing',
    },
  ])
    expect((await f.run('TelosManageItem', raw)).isError).toBe(true);
  const edit = {
    operation: 'edit',
    itemId: 'studio',
    requestId: 'edit',
    expectedRevision: f.items.read('studio').revision,
    summary: 'Changed',
    note: 'Rename',
  };
  f.approve.mockImplementationOnce(async (_name, input) => ({
    behavior: 'allow',
    updatedInput: { ...input, summary: 'Substituted' },
  }));
  expect((await f.run('TelosManageItem', edit)).isError).toBe(true);
  f.approve.mockImplementationOnce(async (_name, input) => {
    f.retire();
    return { behavior: 'allow', updatedInput: input };
  });
  expect((await f.run('TelosManageItem', edit)).isError).toBe(true);
  expect(f.items.read('studio').summary).toBe('Home studio');
});
it('keeps a committed legacy-brief edit receipt within the transport bound', async () => {
  const f = fixture();
  f.db
    .prepare('UPDATE items SET summary=? WHERE id=?')
    .run('Legacy context '.repeat(10000), 'studio');
  const result = await f.run('TelosManageItem', {
    operation: 'edit',
    itemId: 'studio',
    requestId: 'bounded-edit',
    expectedRevision: f.items.read('studio').revision,
    intent: 'Retain the original context',
    note: 'Verified edit',
  });
  expect(result.isError).toBe(false);
  expect(Buffer.byteLength(result.content)).toBeLessThan(48 * 1024);
  expect(JSON.parse(result.content)).toMatchObject({
    ok: true,
    item: { id: 'studio', revision: f.items.read('studio').revision },
  });
  expect(f.items.read('studio').intent).toBe('Retain the original context');
});
it('distinguishes denied approval from a storage outage', async () => {
  const f = fixture();
  f.approve.mockImplementationOnce(async () => ({ behavior: 'deny' }) as never);
  const result = await f.run('TelosManageItem', {
    operation: 'edit',
    itemId: 'studio',
    requestId: 'denied',
    expectedRevision: f.items.read('studio').revision,
    summary: 'Changed',
    note: 'Requested edit',
  });
  expect(result.isError).toBe(true);
  expect(result.content).toContain('approval');
  expect(result.content).not.toContain('operation unavailable');
  expect(f.items.read('studio').summary).toBe('Home studio');
});
