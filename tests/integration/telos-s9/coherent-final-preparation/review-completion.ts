import { expect } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  TelosGetItemInput,
  TelosUpdateItemInput,
  type TelosItemToolName,
} from '../../../../server/telos-item-tools.js';

/** Fixture transport only. Implement with the exact original lead's real
 * Codex lifecycle callback, permission owner and authenticated private route.
 * This helper constructs no NativeHostToolContext, actor, permit or receipt. */
export interface CanonicalReviewPort {
  http(path: string, init?: RequestInit): Promise<Response>;
  native(
    name: TelosItemToolName,
    input: unknown,
  ): Promise<{
    conversationId: string;
    threadId: string;
    turnId: string;
    callId: string;
    result: { success: boolean; contentItems: Array<{ type: string; text?: string }> };
  }>;
  reload(): Promise<void>;
  record(stage: string, facts: Record<string, unknown>): Promise<void>;
}
const update = z
  .object({ sessionId: z.string(), requestId: z.string(), note: z.string(), status: z.string() })
  .passthrough();
const item = z
  .object({
    id: z.string(),
    status: z.string(),
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    children: z.array(z.object({ id: z.string(), status: z.string() }).passthrough()),
    updates: z.array(update),
  })
  .passthrough();
const readReceipt = z.object({ ok: z.literal(true), item }).passthrough();
const completionReceipt = readReceipt.extend({ update });
export async function reviewArtifactThenCompleteMilestoneAndOutcome(
  port: CanonicalReviewPort,
  selected: {
    leadConversationId: string;
    taskId: string;
    milestoneId: string;
    outcomeId: string;
    artifact: { id: string; revision: number; sha256: string; bytes: Uint8Array };
    criteriaEvidence: string;
  },
) {
  const call = async (name: TelosItemToolName, input: unknown) => {
    const observed = await port.native(name, input);
    await port.record('actual-canonical-native-result-before-oracles', { name, input, observed });
    expect(observed.conversationId).toBe(selected.leadConversationId);
    for (const id of [observed.threadId, observed.turnId, observed.callId]) expect(id).not.toBe('');
    expect(observed.result.success).toBe(true);
    return JSON.parse(
      observed.result.contentItems.map((part) => part.text ?? '').join('\n'),
    ) as unknown;
  };
  const read = async (itemId: string) =>
    readReceipt.parse(await call('TelosGetItem', TelosGetItemInput.parse({ itemId }))).item;
  const pending = await port.http('/api/tasks/' + selected.taskId);
  const pendingBody: unknown = await pending.json();
  await port.record('actual-task-review-boundary-before-approval', {
    status: pending.status,
    body: pendingBody,
  });
  expect(pending.status).toBe(200);
  expect(pendingBody).toMatchObject({
    task: {
      id: selected.taskId,
      status: 'pending_review',
      completedAt: null,
      artifacts: { report: `artifact:${selected.artifact.id}@${selected.artifact.revision}` },
    },
  });
  const material = await port.http(
    '/api/telos/artifacts/' + selected.artifact.id + '?revision=' + selected.artifact.revision,
  );
  const bytes = Buffer.from(await material.arrayBuffer());
  const actualHash = createHash('sha256').update(bytes).digest('hex');
  await port.record('explicit-operator-retained-artifact-byte-read-before-task-approval', {
    status: material.status,
    artifact: { id: selected.artifact.id, revision: selected.artifact.revision },
    bytes: bytes.length,
    sha256: actualHash,
  });
  expect(material.status).toBe(200);
  expect(bytes).toEqual(Buffer.from(selected.artifact.bytes));
  expect(actualHash).toBe(selected.artifact.sha256);
  expect((await read(selected.milestoneId)).status).toBe('active');
  expect((await read(selected.outcomeId)).status).toBe('active');
  const approved = await port.http('/api/tasks/' + selected.taskId + '/approve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  const approvedBody: unknown = await approved.json();
  const task = await port.http('/api/tasks/' + selected.taskId);
  const taskBody: unknown = await task.json();
  await port.record('actual-operator-task-approval-remains-distinct-from-canonical-completion', {
    status: approved.status,
    body: approvedBody,
    taskStatus: task.status,
    taskBody,
  });
  expect(approved.status).toBe(200);
  expect(task.status).toBe(200);
  expect(taskBody).toMatchObject({ task: { id: selected.taskId, status: 'done' } });
  expect((await read(selected.milestoneId)).status).toBe('active');
  expect((await read(selected.outcomeId)).status).toBe('active');
  const receipts: Array<z.infer<typeof completionReceipt>> = [];
  for (const itemId of [selected.milestoneId, selected.outcomeId]) {
    const before = await read(itemId);
    if (itemId === selected.outcomeId)
      expect(before.children).toEqual([
        expect.objectContaining({ id: selected.milestoneId, status: 'completed' }),
      ]);
    else expect(before.children).toEqual([]);
    const input = TelosUpdateItemInput.parse({
      itemId,
      requestId: randomUUID(),
      expectedRevision: before.revision,
      status: 'completed',
      note: `${selected.criteriaEvidence}; verified artifact:${selected.artifact.id}@${selected.artifact.revision} SHA-256 ${actualHash}; operator-approved task ${selected.taskId}.`,
    });
    const receipt = completionReceipt.parse(await call('TelosUpdateItem', input));
    const retry = completionReceipt.parse(await call('TelosUpdateItem', input));
    await port.record('actual-canonical-completion-and-exact-request-retry', {
      input,
      receipt,
      retry,
    });
    expect(receipt.item.id).toBe(itemId);
    expect(receipt.item.status).toBe('completed');
    expect(receipt.update).toMatchObject({
      sessionId: selected.leadConversationId,
      requestId: input.requestId,
      note: input.note,
      status: 'completed',
    });
    expect(retry).toEqual(receipt);
    expect(
      receipt.item.updates.filter((entry) => entry.requestId === input.requestId),
    ).toHaveLength(1);
    receipts.push(receipt);
  }
  await port.reload(); // Normal retained UI reload only; never called a cold App restart.
  for (const receipt of receipts) {
    const retained = await read(receipt.item.id);
    await port.record('canonical-completion-durable-receipt-after-normal-reload', {
      retained,
      receipt,
    });
    expect(retained).toEqual(receipt.item);
    expect(
      retained.updates.filter((entry) => entry.requestId === receipt.update.requestId),
    ).toHaveLength(1);
  }
  return receipts;
}
