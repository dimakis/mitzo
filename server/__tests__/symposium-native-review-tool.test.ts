import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  createSymposiumNativeReviewTool,
  SYMPOSIUM_READ_REVIEW_PAGE_TOOL,
} from '../symposium-native-review-tool.js';

const artifact = {
  version: 1 as const,
  kind: 'sealed_reader' as const,
  readerAdmissionId: 'transition-1',
  artifactGenerationId: 'generation-1',
  sealFenceId: 'fence-1',
  bindingDigest: 'a'.repeat(64),
};
const execution = {
  sessionId: 'session-1',
  deliveryId: 'delivery-1',
  claimToken: 'claim-1',
  seat: { id: 'reviewer', role: 'reviewer' },
  provenance: { version: 3, artifact },
  signal: new AbortController().signal,
};
const workflow = {
  workflowId: 'workflow-1',
  applicationAttempts: [
    {
      workflowId: 'workflow-1',
      attemptId: 'attempt-1',
      kind: 'review',
      actorSeatId: 'reviewer',
      artifactRevision: 'b'.repeat(40),
      artifactHash: 'c'.repeat(64),
      binding: { claimToken: 'claim-1', deliveryId: 'delivery-1' },
    },
  ],
};
const preparation = { kind: 'review', transitionId: 'transition-1', seal: { fenceId: 'fence-1' } };

describe('reviewer sealed page native tool', () => {
  it('passes only the host-bound active claim and numbered page to durable storage', async () => {
    const readReviewPage = vi.fn(() => ({
      context: '{"pageIndex":1}',
      receipt: {
        pageIndex: 1,
        contextSha256: createHash('sha256').update('{"pageIndex":1}').digest('hex'),
      },
    }));
    const markReviewPageDelivered = vi.fn();
    const verifyCurrent = vi.fn();
    const tool = createSymposiumNativeReviewTool({
      reviews: {
        applicationWorkflowForSession: () => workflow,
        getApplicationPreparation: () => preparation,
        readReviewPage,
        markReviewPageDelivered,
      } as never,
      execution: execution as never,
      verifyCurrent,
    });
    expect(tool.tools?.map((item) => item.name)).toEqual([SYMPOSIUM_READ_REVIEW_PAGE_TOOL]);
    const result = await tool.executeTool(
      SYMPOSIUM_READ_REVIEW_PAGE_TOOL,
      { pageIndex: 1 },
      new AbortController().signal,
      { turnId: 'turn', callId: 'call' } as never,
    );
    expect(result.isError).toBe(false);
    expect(readReviewPage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        workflowId: 'workflow-1',
        attemptId: 'attempt-1',
        claimToken: 'claim-1',
        seatId: 'reviewer',
        sealFenceId: 'fence-1',
        pageIndex: 1,
      }),
    );
    expect(verifyCurrent).toHaveBeenCalledTimes(2);
    expect(markReviewPageDelivered).not.toHaveBeenCalled();
    tool.onToolResultDurable(SYMPOSIUM_READ_REVIEW_PAGE_TOOL, { pageIndex: 1 }, result, {
      turnId: 'turn',
      callId: 'call',
    });
    expect(markReviewPageDelivered).toHaveBeenCalledWith({
      workflowId: 'workflow-1',
      attemptId: 'attempt-1',
      pageIndex: 1,
      contextSha256: createHash('sha256').update('{"pageIndex":1}').digest('hex'),
    });
  });

  it('rejects forged fields and a stale reviewer claim', async () => {
    const readReviewPage = vi.fn();
    const markReviewPageDelivered = vi.fn();
    const tool = createSymposiumNativeReviewTool({
      reviews: {
        applicationWorkflowForSession: () => workflow,
        getApplicationPreparation: () => preparation,
        readReviewPage,
        markReviewPageDelivered,
      } as never,
      execution: execution as never,
      verifyCurrent: () => {},
    });
    const call = (arguments_: Record<string, unknown>) =>
      tool.executeTool(SYMPOSIUM_READ_REVIEW_PAGE_TOOL, arguments_, new AbortController().signal, {
        turnId: 'turn',
        callId: 'call',
      } as never);
    expect((await call({ pageIndex: 1, workflowId: 'other' })).isError).toBe(true);
    expect((await call({ pageIndex: 2048 })).isError).toBe(true);
    expect(readReviewPage).not.toHaveBeenCalled();
    const stale = createSymposiumNativeReviewTool({
      reviews: {
        applicationWorkflowForSession: () => workflow,
        getApplicationPreparation: () => preparation,
        readReviewPage,
        markReviewPageDelivered,
      } as never,
      execution: { ...execution, claimToken: 'old-claim' } as never,
      verifyCurrent: () => {},
    });
    expect(
      (
        await stale.executeTool(
          SYMPOSIUM_READ_REVIEW_PAGE_TOOL,
          { pageIndex: 1 },
          new AbortController().signal,
          { turnId: 'turn', callId: 'call' } as never,
        )
      ).isError,
    ).toBe(true);
    expect(readReviewPage).not.toHaveBeenCalled();
    expect(markReviewPageDelivered).not.toHaveBeenCalled();
  });

  it('does not count a page when the final current-claim check fails', async () => {
    const markReviewPageDelivered = vi.fn();
    const tool = createSymposiumNativeReviewTool({
      reviews: {
        applicationWorkflowForSession: () => workflow,
        getApplicationPreparation: () => preparation,
        readReviewPage: () => ({ context: 'page', receipt: { contextSha256: 'hash-1' } }),
        markReviewPageDelivered,
      } as never,
      execution: execution as never,
      verifyCurrent: vi
        .fn()
        .mockImplementationOnce(() => {})
        .mockImplementationOnce(() => {
          throw new Error('stale claim');
        }),
    });
    const result = await tool.executeTool(
      SYMPOSIUM_READ_REVIEW_PAGE_TOOL,
      { pageIndex: 1 },
      new AbortController().signal,
      { turnId: 'turn', callId: 'call' } as never,
    );
    expect(result.isError).toBe(true);
    expect(markReviewPageDelivered).not.toHaveBeenCalled();
  });

  it('reads pages for a delta review', async () => {
    const markReviewPageDelivered = vi.fn();
    const readReviewPage = vi.fn(() => ({
      context: 'delta',
      receipt: { contextSha256: 'hash-d' },
    }));
    const tool = createSymposiumNativeReviewTool({
      reviews: {
        applicationWorkflowForSession: () => ({
          ...workflow,
          applicationAttempts: [{ ...workflow.applicationAttempts[0], kind: 'delta' }],
        }),
        getApplicationPreparation: () => ({ ...preparation, kind: 'delta' }),
        readReviewPage,
        markReviewPageDelivered,
      } as never,
      execution: execution as never,
      verifyCurrent: () => {},
    });
    const result = await tool.executeTool(
      SYMPOSIUM_READ_REVIEW_PAGE_TOOL,
      { pageIndex: 1 },
      new AbortController().signal,
      { turnId: 'turn', callId: 'call' } as never,
    );
    expect(result.isError).toBe(false);
    expect(readReviewPage).toHaveBeenCalledOnce();
    expect(markReviewPageDelivered).not.toHaveBeenCalled();
  });
});
