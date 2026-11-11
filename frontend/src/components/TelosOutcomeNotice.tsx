import type { ToolBlock } from '../lib/tool-status';
import type { ReactNode } from 'react';
import { ToolResultContent } from './ToolResultContent';
import { OperationCard } from './OperationCard';
import { TelosOutcomeRevisionReceiptSchema, TelosOutcomeCancellationSchema } from '@mitzo/protocol';

function isTelosOutcomeCall(block: ToolBlock) {
  return ['TelosCreateOutcome', 'mcp__telos__TelosCreateOutcome'].includes(block.toolName ?? '');
}

/** Keep creation, revision and cancellation results outside collapsed activity.
 * An uncertain write must recover its original reviewed attempt. */
export function TelosOutcomeNotice({
  block,
  embedded = false,
}: {
  block: ToolBlock;
  embedded?: boolean;
}) {
  if (!isTelosOutcomeCall(block) || !block.toolResult) return null;
  const frame = (content: ReactNode, label: string, failed = false) =>
    embedded ? (
      <section aria-label={label}>{content}</section>
    ) : (
      <OperationCard
        title="Create outcome"
        kind="Telos"
        label={label}
        status={failed ? 'Unconfirmed' : undefined}
        tone={failed ? 'error' : 'normal'}
      >
        {content}
      </OperationCard>
    );
  try {
    const value: unknown = JSON.parse(block.toolResult);
    if (TelosOutcomeCancellationSchema.safeParse(value).success)
      return frame(
        <p className="tool-pill-section" role="status">
          Outcome creation cancelled.
        </p>,
        'Outcome creation cancelled',
      );
    const revision = TelosOutcomeRevisionReceiptSchema.safeParse(value);
    if (revision.success)
      return frame(
        <>
          <p>Changes requested</p>
          <p>{revision.data.feedback}</p>
          <p className="perm-banner-scope">
            The original proposal is retained. Review the revised proposal before saving.
          </p>
        </>,
        'Outcome changes requested',
      );
  } catch {
    /* Other tool output keeps its existing failure presentation. */
  }
  if (!block.toolError) return null;
  return frame(
    <>
      <p className="perm-banner-response-error">Couldn’t confirm outcome creation</p>
      <ToolResultContent text={block.toolResult} />
    </>,
    'Outcome creation problem',
    true,
  );
}
