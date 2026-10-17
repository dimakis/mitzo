import { describe, expect, it, vi } from 'vitest';
import { TelosWorkApiClient } from '../telos-work-api.js';
import { TelosWorkItemSchema, TelosWorkViewSchema } from '@mitzo/protocol';
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
