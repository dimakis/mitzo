import { expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Express } from 'express';
import type { TelosWorkApiClient } from '@mitzo/client';
import type { EventStore } from '../../event-store.js';

/** Simulates the originating tool invocation only. Review, preview, approval,
 * source custody and receipt consumption use the actual authenticated App. */
export async function adoptReviewedSource(input: {
  api: TelosWorkApiClient;
  events: EventStore;
  registry: typeof import('../../chat.js').registry;
  app: Express;
  operatorId: string;
  assertOperatorCurrent(): void;
  itemId: string;
  sourceSessionId: string;
  messageId: string;
  text: string;
  artifacts: Array<{ artifactId: string; revision: number; sha256: string }>;
}) {
  const { buildPermissionHandler, getPendingRequestsBySession } = await import('@mitzo/harness');
  const sourceClientId = 'reviewed-source-' + randomUUID();
  const sourceController = new AbortController();
  const planningSequence = input.events.append(input.sourceSessionId, 'user_message', {
    messageId: input.messageId,
    text: input.text,
  });
  input.registry.register(sourceClientId, {
    transport: { isOpen: () => true, send: vi.fn() },
    abortController: sourceController,
    sessionId: input.sourceSessionId,
    sessionAllowList: new Set(),
    mode: 'agent',
  });
  try {
    const sourceProposal = { itemId: input.itemId };
    const sourcePermission = buildPermissionHandler(sourceClientId, input.registry)(
      'TelosAdoptSource',
      sourceProposal,
      {
        signal: sourceController.signal,
        toolUseID: 'native:' + randomUUID(),
        forcePrompt: true,
        allowSessionGrant: false,
        nativeSourceScope: {
          operatorId: input.operatorId,
          assertCurrentSync() {
            sourceController.signal.throwIfAborted();
            input.assertOperatorCurrent();
          },
        },
      },
    );
    void sourcePermission.catch(() => {});
    await vi.waitFor(() =>
      expect(getPendingRequestsBySession(input.sourceSessionId)).toHaveLength(1),
    );
    const sourcePermissionId = getPendingRequestsBySession(input.sourceSessionId)[0].permId;
    const sourceReview = await input.api.getSourcePermission(
      sourcePermissionId,
      input.sourceSessionId,
    );
    const sourceInput = {
      sessionId: input.sourceSessionId,
      requestId: randomUUID(),
      proposalSha256: sourceReview.proposalSha256,
      selection: {
        mode: 'selected' as const,
        boundary: { sequence: planningSequence, messageId: input.messageId },
        messageIds: [input.messageId],
        artifacts: input.artifacts,
      },
    };
    const sourcePreview = await input.api.previewSourcePermission(sourcePermissionId, sourceInput);
    const sourceApprovalInput = { ...sourceInput, previewSha256: sourcePreview.preview.sha256 };
    const featureSource = await input.api.approveSourcePermission(
      sourcePermissionId,
      sourceApprovalInput,
    );
    expect(
      await input.api.approveSourcePermission(sourcePermissionId, sourceApprovalInput),
    ).toEqual(featureSource);
    const sourceResolution = await sourcePermission;
    expect(sourceResolution.behavior).toBe('allow');
    if (sourceResolution.behavior !== 'allow') throw Error('Reviewed source approval required');
    const sourceReceiptId = sourceResolution.updatedInput?.__mitzoTelosApproval;
    expect(typeof sourceReceiptId).toBe('string');
    expect(sourceResolution.updatedInput).toEqual({
      ...sourceProposal,
      __mitzoTelosApproval: sourceReceiptId,
    });
    const consumedSource = await request(input.app)
      .post('/api/internal/telos/source/execute')
      .set('X-Internal-Token', 'synthetic-only-ordinary-native-token')
      .set('X-Client-Id', sourceClientId)
      .send({ approvalReceiptId: sourceReceiptId, proposal: sourceProposal, operation: 'adopt' });
    expect(consumedSource.status, JSON.stringify(consumedSource.body)).toBe(200);
    expect(consumedSource.body.receipt).toEqual(featureSource.receipt);
    return {
      featureSource,
      sourcePermissionId,
      sourceApprovalInput,
      sourcePreview,
      planningSequence,
    };
  } finally {
    sourceController.abort();
    input.registry.remove(sourceClientId);
  }
}
