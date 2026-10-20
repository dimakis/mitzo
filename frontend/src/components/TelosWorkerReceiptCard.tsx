import { TelosWorkDelegationReceiptSchema } from '@mitzo/protocol';
import { Link } from 'react-router-dom';
import type { ToolBlock } from '../lib/tool-status';
import { getToolStatus } from '../lib/tool-status';
import { UiIcon } from './UiIcon';
import './TelosWorkerReceiptCard.css';

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
    // Full JSON inputs retain an additional child fence. Summarized
    // tool input is display text and cannot supply an invented child identity.
    if (block.toolInput?.trim().startsWith('{')) {
      const input: unknown = JSON.parse(block.toolInput);
      if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
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
}: {
  block: ToolBlock;
  sessionId?: string;
}) {
  const receipt = telosWorkerReceipt(block, sessionId);
  if (!receipt) return null;
  const display = receipt.workerDisplay;
  return (
    <div className="telos-worker-receipt">
      <Link className="telos-worker-receipt-row" to={receipt.workerPath}>
        <span className="telos-worker-receipt-icon">
          <UiIcon name="messagesSquare" size={16} />
        </span>
        <span className="telos-worker-receipt-name">
          <strong>{display?.title || 'Worker conversation'}</strong>
          {display && (
            <small>
              {[display.profile, display.account, display.model, display.target]
                .filter(Boolean)
                .join(' · ')}
            </small>
          )}
          <small>Worker chat · created from this lead conversation</small>
        </span>
        <UiIcon name="arrowUpRight" size={16} />
      </Link>
    </div>
  );
}
