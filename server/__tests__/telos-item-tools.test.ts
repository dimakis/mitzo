import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  executeTelosItemTool,
  telosItemDefinitions,
  TelosUpdateItemInput,
  TELOS_PROGRESS_INSTRUCTIONS,
} from '../telos-item-tools.js';
const input = {
  itemId: 'child',
  requestId: 'finish-child',
  expectedRevision: 'a'.repeat(64),
  status: 'completed',
  note: 'Report artifact abc revision 1 covers the requested comparison.',
};
afterEach(() => vi.unstubAllGlobals());
describe('Telos progress tool contract', () => {
  it('offers item inspection and progress updates with lifecycle instructions', () => {
    expect(telosItemDefinitions.map((d) => d.name)).toEqual(['TelosGetItem', 'TelosUpdateItem']);
    for (const text of [
      'before handover',
      'milestones',
      'expectedRevision',
      'TelosUpdateItem',
      'evidence',
      'reopen',
      'saving a report',
    ])
      expect(TELOS_PROGRESS_INSTRUCTIONS).toContain(text);
  });
  it.each([
    { ...input, note: '' },
    { ...input, expectedRevision: '' },
    { ...input, sessionId: 'spoofed' },
    { ...input, status: 'deleted' },
  ])('rejects unsafe update input before contacting the host', async (invalid) => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(TelosUpdateItemInput.safeParse(invalid).success).toBe(false);
    expect(
      (await executeTelosItemTool('http://host', 'client', 'secret', 'TelosUpdateItem', invalid))
        .isError,
    ).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('sends updates to the host and returns the confirmed status and revision', async () => {
    const receipt = {
      ok: true,
      item: { id: 'child', status: 'completed', revision: 'b'.repeat(64) },
      update: { sessionId: 'session-a', note: input.note },
    };
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(receipt)));
    vi.stubGlobal('fetch', fetch);
    expect(
      await executeTelosItemTool('http://host', 'client', 'secret', 'TelosUpdateItem', input),
    ).toEqual({ content: JSON.stringify(receipt), isError: false });
    expect(fetch).toHaveBeenCalledWith(
      'http://host/api/internal/telos/items/update',
      expect.objectContaining({
        body: JSON.stringify(input),
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Token': 'secret',
          'X-Client-Id': 'client',
        },
      }),
    );
  });
  it('never reports success for stale, malformed, failed or interrupted responses', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: false, error: 'Telos item changed' }), { status: 409 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })))
      .mockRejectedValueOnce(new Error('Aborted'));
    vi.stubGlobal('fetch', fetch);
    for (let i = 0; i < 3; i++)
      expect(
        (await executeTelosItemTool('http://host', 'client', 'secret', 'TelosUpdateItem', input))
          .isError,
      ).toBe(true);
  });
});
