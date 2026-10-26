import { describe, expect, it, vi } from 'vitest';
import { TelosWorkApiClient } from '../telos-work-api.js';
import {
  TelosWorkItemSchema,
  TelosWorkViewSchema,
  TelosWorkDelegationInputSchema,
} from '@mitzo/protocol';
const view = TelosWorkViewSchema.parse({
  itemId: 'item',
  kind: null,
  parentId: null,
  revision: 'a'.repeat(64),
  links: [],
  assignments: [],
  sources: [],
  attempts: [],
});
describe('typed Telos work client', () => {
  it('reads a batch once with its abort signal and rejects missing or substituted identities', async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          records: [],
          failures: [{ itemId: 'missing', code: 'not_found', status: 404 }],
        }),
      ),
    );
    const api = new TelosWorkApiClient(fetch);
    const signal = new AbortController().signal;
    expect(await api.readRecords(['missing'], signal)).toEqual({
      records: [],
      failures: [{ itemId: 'missing', code: 'not_found', status: 404 }],
    });
    expect(fetch).toHaveBeenCalledWith(
      '/api/telos/work/records',
      expect.objectContaining({
        method: 'POST',
        signal,
        body: JSON.stringify({ itemIds: ['missing'] }),
      }),
    );
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ records: [], failures: [] })));
    await expect(api.readRecords(['missing'])).rejects.toThrow(/identit/);
    fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          records: [],
          failures: [{ itemId: 'foreign', code: 'not_found', status: 404 }],
        }),
      ),
    );
    await expect(api.readRecords(['missing'])).rejects.toThrow(/identit/);
  });
  const delegation = TelosWorkDelegationInputSchema.parse({
    requestId: 'start',
    childItemId: 'slice',
    leadItemId: 'outcome',
    leadConversationId: 'lead',
    expectedRevision: 'a'.repeat(64),
    mode: 'start',
    predecessorAttemptId: null,
    settings: {
      binding: {
        version: 2,
        account: { accountId: 'offline', provider: 'openai-codex', profileRevision: 'r1' },
        harness: { implementation: 'codex' },
        execution: { location: 'local', targetId: 'offline', targetRevision: 'r1' },
      },
      repositoryWorkspaceId: 'workspace',
      selection: {
        version: 1,
        agent: { profileId: 'agent', revision: 1 },
        context: { source: 'none', revision: null },
        permission: { mode: 'agent', revision: 0 },
        model: 'offline',
        thinking: null,
      },
    },
    contextSelection: {
      version: 1,
      itemId: 'slice',
      role: 'worker',
      brief: { revision: 'a'.repeat(64), sha256: 'b'.repeat(64), text: 'Reviewed' },
      parentCriteria: [],
      overallGoal: { itemId: 'outcome', revision: 'a'.repeat(64), text: 'Goal' },
      sources: [],
      artifacts: [],
      leadConversationId: 'lead',
    },
  });
  const delegated = {
    version: 1,
    state: 'chat_ready',
    workerConversationId: 'worker',
    workerPath: '/chat/worker',
    itemPath: '/todos/slice',
    leadPath: '/chat/lead',
    execution: 'not_started',
    attempt: {
      version: 1,
      requestId: 'start',
      attemptId: 'attempt',
      predecessorAttemptId: null,
      leadConversationId: 'lead',
      childItemId: 'slice',
      contextSnapshotId: 'context',
      state: 'chat_ready',
      workerConversationId: 'worker',
      allocationReceiptId: 'ordinary',
      executionTaskId: 'task',
      accountingGoalId: null,
      turnCommandId: null,
    },
  };
  it('delegates exact full reviewed input with its original request and abort signal', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(delegated)));
    const api = new TelosWorkApiClient(fetch);
    const signal = new AbortController().signal;
    expect(await api.delegateSlice(delegation, signal)).toEqual(delegated);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]).toEqual([
      '/api/telos/work/delegation/start',
      {
        credentials: 'include',
        signal,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(delegation),
      },
    ]);
  });
  it('rejects malformed delegation input before sending and validates returned allocation receipts', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{}'));
    const api = new TelosWorkApiClient(fetch);
    expect(() =>
      api.delegateSlice({ ...delegation, childItemId: ['slice', 'sibling'] } as never),
    ).toThrow();
    expect(fetch).not.toHaveBeenCalled();
    await expect(api.delegateSlice(delegation)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('exposes uncertain delegation failure without inventing or retrying a request', async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: 'unavailable', error: 'Allocation uncertain' }), {
        status: 503,
      }),
    );
    const api = new TelosWorkApiClient(fetch);
    await expect(api.delegateSlice(delegation)).rejects.toMatchObject({
      status: 503,
      code: 'unavailable',
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(JSON.parse(fetch.mock.calls[0][1].body).requestId).toBe('start');
  });
  it('reviews canonical role context through its dedicated authenticated endpoint without executing a command', async () => {
    const context = {
      version: 1,
      itemId: 'item',
      role: 'reviewer' as const,
      brief: { revision: view.revision, sha256: 'b'.repeat(64), text: 'Reviewed work' },
      parentCriteria: [],
      overallGoal: { itemId: 'item', revision: view.revision, text: 'Goal' },
      sources: [],
      artifacts: [],
    };
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(context)));
    const api = new TelosWorkApiClient(fetch);
    const input = {
      itemId: 'item',
      role: 'reviewer' as const,
      sourceSnapshotIds: [],
      artifactRefs: [],
    };
    expect(await api.roleContext(input)).toEqual(context);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]).toMatchObject([
      '/api/telos/work/roles/context',
      { method: 'POST', credentials: 'include', body: JSON.stringify(input) },
    ]);
  });
  it('reads and validates the canonical workspace record without starting a chat or retrying', async () => {
    const record = TelosWorkItemSchema.parse({
      version: 1,
      itemId: 'legacy',
      kind: null,
      parentId: null,
      summary: 'Existing outcome',
      intent: '',
      rationale: '',
      acceptanceCriteria: [],
      profile: 'work',
      status: 'active',
      starred: false,
      categories: [],
      createdAt: null,
      updatedAt: null,
      contextHints: {
        repos: [],
        paths: [],
        issues: [],
        docIds: [],
        people: [],
        jiraKeys: [],
        keywords: [],
        sessionIds: [],
        taskHint: '',
      },
      sources: [],
      links: [],
      legacyFields: { retained: 'original value' },
    });
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(record)))
      .mockResolvedValueOnce(new Response('{}'));
    const api = new TelosWorkApiClient(fetch);
    const abort = new AbortController();
    expect(await api.readRecord(record.itemId, abort.signal)).toEqual(record);
    expect(fetch.mock.calls[0]).toEqual([
      '/api/telos/work/items/' + encodeURIComponent(record.itemId) + '/record',
      { credentials: 'include', signal: abort.signal },
    ]);
    await expect(api.readRecord(record.itemId)).rejects.toThrow();
    await expect(api.readRecord('../private')).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('uses ordinary authenticated API calls without allocation or hidden retries', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(view)))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ commandId: 'command', actorId: 'operator:verified', work: view }),
        ),
      )
      .mockResolvedValueOnce(new Response('[]'));
    const api = new TelosWorkApiClient(fetch);
    expect(await api.read('item')).toEqual(view);
    const command = {
      operation: 'classify' as const,
      itemId: 'item',
      kind: 'outcome' as const,
      requestId: 'explicit',
      expectedRevision: view.revision,
    };
    expect((await api.execute(command)).work).toEqual(view);
    expect(await api.links({ namespace: 'mitzo', conversationId: 'chat' })).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls[0]).toMatchObject([
      '/api/telos/work/items/item',
      { credentials: 'include' },
    ]);
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual(command);
  });
  it('rejects malformed data and exposes conflicts without generating a replacement request', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Stale work', code: 'conflict' }), { status: 409 }),
      )
      .mockResolvedValueOnce(new Response('{}'));
    const api = new TelosWorkApiClient(fetch);
    await expect(api.read('item')).rejects.toMatchObject({ status: 409, code: 'conflict' });
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(api.read('item')).rejects.toThrow();
    await expect(api.read('../secrets')).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
