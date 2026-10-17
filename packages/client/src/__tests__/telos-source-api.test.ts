import { describe, expect, it, vi } from 'vitest';
import { TelosWorkApiClient } from '../telos-work-api.js';
import { TelosSourcePreviewSchema, TelosReviewedSourceViewSchema } from '@mitzo/protocol';

const selection = {
  requestId: '00000000-0000-4000-8000-000000000001',
  expectedMembershipRevision: 0,
  sourceConversationId: 'origin',
  mode: 'selected' as const,
  messageIds: ['message'],
  boundary: { sequence: 1, messageId: 'message' },
  artifacts: [],
  purpose: 'Save source',
  joiningBrief: '',
};
const preview = TelosSourcePreviewSchema.parse({
  sha256: 'a'.repeat(64),
  packet: {
    version: 1,
    actorId: 'operator:verified',
    itemId: 'item',
    workRevision: 'b'.repeat(64),
    selection,
    brief: { sha256: 'c'.repeat(64), text: 'Actual agreed brief' },
    context: {
      requestId: selection.requestId,
      sourceConversationId: 'origin',
      boundary: selection.boundary,
      mode: 'selected',
      purpose: selection.purpose,
      joiningBrief: '',
      artifacts: [],
      messages: [
        {
          conversationId: 'origin',
          messageId: 'message',
          sequence: 1,
          author: 'operator',
          source: null,
          blocks: [{ blockId: 'message', content: 'Agreed text', sha256: 'd'.repeat(64) }],
        },
      ],
      capacity: { status: 'unverified', reason: 'No recipient selected' },
      summary: null,
    },
    attributions: { message: { seatId: null, provenance: null, createdAt: 1 } },
    sourceTitle: 'Original',
    sourceCreatedAt: null,
  },
});
const sourceView = TelosReviewedSourceViewSchema.parse({
  packet: preview.packet,
  available: true,
  sourceHref: '/chat/origin?telosItem=item&telosSource=snapshot',
  snapshot: {
    version: 1,
    snapshotId: 'snapshot',
    itemId: 'item',
    source: { namespace: 'mitzo', conversationId: 'origin' },
    selection: { kind: 'selected', messageIds: ['message'], blockIds: [], throughSequence: 1 },
    adoptedBrief: { revision: 'brief', sha256: 'c'.repeat(64) },
    artifacts: [],
    author: null,
    sourceCreatedAt: null,
    adoptedAt: null,
  },
});
describe('typed reviewed-source API', () => {
  it('keeps reviewed new-outcome creation explicit and preserves the creation request ID', async () => {
    const proposal = {
      requestId: 'new-outcome',
      selection,
      outcome: {
        summary: 'Outcome',
        intent: 'Deliver it',
        rationale: 'Why',
        acceptanceCriteria: ['Reviewed'],
        profile: 'manual',
        milestones: ['One'],
      },
    };
    const reviewed = {
      ...preview,
      packet: {
        ...preview.packet,
        itemId: null,
        creation: { requestId: proposal.requestId, outcome: proposal.outcome },
      },
    };
    const receipt = {
      commandId: 'saved',
      actorId: 'operator:verified',
      work: {
        itemId: 'created',
        kind: 'outcome',
        parentId: null,
        revision: 'e'.repeat(64),
        sources: [],
        links: [],
        assignments: [],
        attempts: [],
      },
    };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(reviewed)))
      .mockResolvedValueOnce(new Response(JSON.stringify(receipt)));
    const api = new TelosWorkApiClient(fetch);
    expect(await api.previewOutcomeSource(proposal)).toEqual(reviewed);
    const input = { ...proposal, previewSha256: preview.sha256 };
    expect(await api.createOutcomeFromSource(input)).toEqual(receipt);
    expect(fetch.mock.calls.map((call) => call[0])).toEqual([
      '/api/telos/work/source/outcome/preview',
      '/api/telos/work/source/outcome/create',
    ]);
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual(input);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('uses explicit authenticated preview/adoption/read requests and preserves the caller request identity', async () => {
    const receipt = {
      commandId: 'command',
      actorId: 'operator:verified',
      work: {
        itemId: 'item',
        kind: null,
        parentId: null,
        revision: 'e'.repeat(64),
        links: [],
        assignments: [],
        sources: [sourceView.snapshot],
        attempts: [],
      },
    };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(preview)))
      .mockResolvedValueOnce(new Response(JSON.stringify(receipt)))
      .mockResolvedValueOnce(new Response(JSON.stringify(sourceView)));
    const api = new TelosWorkApiClient(fetch);
    const signal = new AbortController().signal;
    expect(await api.previewSource({ itemId: 'item', selection }, signal)).toEqual(preview);
    const input = {
      itemId: 'item',
      requestId: 'explicit-adoption',
      expectedRevision: preview.packet.workRevision,
      previewSha256: preview.sha256,
      selection,
    };
    expect(await api.adoptSource(input)).toEqual(receipt);
    expect(await api.readSource('item', 'snapshot', signal)).toEqual(sourceView);
    expect(fetch.mock.calls.map((call) => call[0])).toEqual([
      '/api/telos/work/source/preview',
      '/api/telos/work/source/adopt',
      '/api/telos/work/items/item/sources/snapshot',
    ]);
    expect(fetch.mock.calls[0][1]).toMatchObject({ credentials: 'include', signal });
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual(input);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it('rejects caller source bytes and malformed replies and surfaces conflicts without retrying', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}'))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 'conflict', error: 'Review changed source' }), {
          status: 409,
        }),
      );
    const api = new TelosWorkApiClient(fetch);
    await expect(api.previewSource({ itemId: 'item', selection })).rejects.toThrow();
    await expect(
      api.previewSource({ itemId: 'item', selection, packet: preview.packet } as never),
    ).rejects.toThrow();
    await expect(
      api.adoptSource({
        itemId: 'item',
        requestId: 'same',
        expectedRevision: 'b'.repeat(64),
        previewSha256: 'a'.repeat(64),
        selection,
      }),
    ).rejects.toMatchObject({ code: 'conflict', status: 409 });
    await expect(api.readSource('../private', 'snapshot')).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
