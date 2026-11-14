import './fixtures/offline-user-home.js';
import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createTelosSdkServer } from '../telos-sdk-tools.js';
import { bindAgentLibraryTransport } from '../agent-library-transport.js';
import { bindAgentToolSelection } from '../agent-tool-selection.js';
import { createTelosSourceApprovalData } from './fixtures/telos-source-approval-data.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([
  { kind: 'create', lost: false },
  { kind: 'adopt', lost: false },
  { kind: 'create', lost: true },
  { kind: 'adopt', lost: true },
] as const)(
  'executes reviewed $kind through the SDK and retains recovery (lost=$lost)',
  async ({ kind, lost }) => {
    const f = createTelosSourceApprovalData();
    cleanup.push(() => f.close());
    const session = f.registry.get('offline-client')!;
    cleanup.push(
      bindAgentLibraryTransport('offline-client', {
        id: f.actor.id,
        expiresAt: Date.now() + 60_000,
      }),
    );
    const name = kind === 'create' ? 'TelosCreateOutcome' : 'TelosAdoptSource';
    bindAgentToolSelection(
      session,
      { tools: [{ id: `mitzo:${name}`, version: 1 }] } as never,
      'claude-sdk',
    );
    const server = createTelosSdkServer({
      session,
      registry: f.registry,
      events: f.events,
      assertCurrent: async (signal) => signal.throwIfAborted(),
      assertCurrentSync: (signal) => signal.throwIfAborted(),
    });
    const client = new Client({ name: 'source-sdk-offline', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(a);
    await client.connect(b);
    cleanup.push(async () => {
      await client.close();
      await server.instance.close();
    });
    const execute = vi.fn(async (url: string, init: RequestInit) => {
      expect(new URL(url).pathname).toBe('/api/internal/telos/source/execute');
      const input = JSON.parse(init.body as string);
      const receipt = f.service.execute(input.approvalReceiptId, 'planning', input.proposal);
      if (lost) throw Error('Synthetic lost retrieval after committed reviewed save');
      return new Response(JSON.stringify(receipt));
    });
    vi.stubGlobal('fetch', execute);
    const pending = client.callTool({
      name,
      arguments:
        kind === 'adopt'
          ? { itemId: 'studio' }
          : {
              summary: 'Reviewed SDK outcome',
              intent: 'Keep selected source',
              rationale: 'Canonical reuse',
              acceptanceCriteria: ['Exact approved source'],
              milestones: ['Verify source'],
              profile: 'personal',
            },
    });
    await vi.waitFor(() => expect(f.pendingRequests()).toHaveLength(1));
    const permId = f.pendingRequests()[0].permId;
    expect(execute).not.toHaveBeenCalled();
    const review = await f.service.review(permId, 'planning', f.actor);
    const message = review.messages.find((message) => message.messageId === 'approved')!;
    const selection = {
      sessionId: 'planning',
      requestId: randomUUID(),
      proposalSha256: review.proposalSha256,
      selection: {
        mode: 'selected' as const,
        boundary: { sequence: message.sequence, messageId: message.messageId },
        messageIds: [message.messageId],
        artifacts: [],
      },
    };
    const preview = await f.service.preview(permId, selection, f.actor);
    await f.service.approve(
      permId,
      { ...selection, previewSha256: preview.preview.sha256 },
      f.actor,
    );
    const result = await pending;
    expect(result.isError).toBe(lost);
    const receipt = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    if (lost) {
      expect(receipt.approvalReceiptId).toBeTruthy();
      expect(receipt.action).toContain('do not submit a new');
      const recovery = await f.service.review(permId, 'planning', f.actor);
      expect(recovery.recovery?.requestId).toBe(selection.requestId);
      const original = recovery.recovery!.receipt!;
      expect(original.permId).toBe(permId);
      const originalInput = JSON.parse(execute.mock.calls[0][1].body as string);
      expect(originalInput.approvalReceiptId).toBe(receipt.approvalReceiptId);
      const before = f.todos().items.length;
      expect(
        f.service.execute(receipt.approvalReceiptId, 'planning', originalInput.proposal),
      ).toMatchObject(original);
      expect(f.todos().items).toHaveLength(before);
      expect(f.retainedOwnerCounts().allocations).toBe(0);
      expect(execute).toHaveBeenCalledOnce();
      return;
    }
    expect(receipt.sourceSnapshotId).toBeTruthy();
    expect(
      JSON.stringify(
        f.service.capture.read(receipt.id, receipt.sourceSnapshotId, f.actor).packet.context
          .messages,
      ),
    ).toContain('Use the approved acoustic plan.');
    expect(f.retainedOwnerCounts().allocations).toBe(0);
    expect(execute).toHaveBeenCalledOnce();
  },
);
