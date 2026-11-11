import { TelosWorkDelegationReceiptSchema } from '@mitzo/protocol';
import { Link } from 'react-router-dom';
import type { ToolBlock } from '../lib/tool-status';
import { getToolStatus } from '../lib/tool-status';
import type { ReactNode } from 'react';
import { OperationCard } from './OperationCard';
import { UiIcon } from './UiIcon';

/** A receipt is navigation evidence for its exact originating lead, never a
 * command to start a worker or a replacement for the ordinary transcript. */
export function telosWorkerReceipt(block: ToolBlock, sessionId?: string) {
  if (
    !sessionId ||
    !['TelosStartSlice', 'mcp__telos__TelosStartSlice'].includes(block.toolName ?? '') ||
    getToolStatus(block).hasError ||
    !block.toolResult
  )
    return null;
  try {
    const parsed = TelosWorkDelegationReceiptSchema.safeParse(JSON.parse(block.toolResult));
    if (!parsed.success) return null;
    const receipt = parsed.data;
    const attempt = receipt.attempt;
    if (
      attempt.leadConversationId !== sessionId ||
      attempt.workerConversationId !== receipt.workerConversationId ||
      receipt.workerConversationId === sessionId ||
      attempt.state !== 'chat_ready' ||
      !attempt.allocationReceiptId ||
      !attempt.executionTaskId ||
      receipt.workerPath !== `/chat/${encodeURIComponent(receipt.workerConversationId)}` ||
      receipt.itemPath !== `/todos/${encodeURIComponent(attempt.childItemId)}` ||
      receipt.leadPath !== `/chat/${encodeURIComponent(sessionId)}`
    )
      return null;
    // Complete JSON can supply an additional child consistency check. Ordinary
    // native input summaries may be truncated JSON; display text cannot revoke
    // or replace the validated receipt's exact lead/worker/path identities.
    let input: unknown;
    try {
      input = JSON.parse(block.toolInput ?? '');
    } catch {
      // The original tool input summary need not be complete JSON.
    }
    if (input && typeof input === 'object' && !Array.isArray(input)) {
      const expected = input as Record<string, unknown>;
      if (expected.childItemId !== undefined && expected.childItemId !== attempt.childItemId)
        return null;
    }
    return receipt;
  } catch {
    return null;
  }
}

export function TelosWorkerReceiptCard({
  block,
  sessionId,
  details,
}: {
  block: ToolBlock;
  sessionId?: string;
  details?: ReactNode;
}) {
  const receipt = telosWorkerReceipt(block, sessionId);
  if (!receipt) return null;
  const display = receipt.workerDisplay;
  const title = display?.title || 'Worker conversation';
  return (
    <OperationCard
      title={title}
      kind="Worker chat"
      icon="messagesSquare"
      scope="Created from this lead conversation"
      actions={
        <Link className="operation-primary" to={receipt.workerPath} aria-label={`Open ${title}`}>
          Open
          <UiIcon name="arrowUpRight" size={16} />
        </Link>
      }
      details={details}
    >
      {display && (
        <p>
          {[display.profile, display.account, display.model, display.target]
            .filter(Boolean)
            .join(' · ')}
        </p>
      )}
    </OperationCard>
  );
}
