import type { ToolBlock } from '../lib/tool-status';
import { ToolResultContent } from './ToolResultContent';
import { TelosOutcomeRevisionReceiptSchema, TelosOutcomeCancellationSchema } from '@mitzo/protocol';

function isTelosOutcomeCall(block: ToolBlock) {
  return ['TelosCreateOutcome', 'mcp__telos__TelosCreateOutcome'].includes(block.toolName ?? '');
}

/** Keep creation, revision and cancellation results outside collapsed activity.
 * An uncertain write must recover its original reviewed attempt. */
export function TelosOutcomeNotice({ block }: { block: ToolBlock }) {
  if (!isTelosOutcomeCall(block) || !block.toolResult) return null;
  try {
    const value: unknown = JSON.parse(block.toolResult);
    if (TelosOutcomeCancellationSchema.safeParse(value).success)
      return (
        <p className="tool-pill-section" role="status">
          Outcome creation cancelled.
        </p>
      );
    const revision = TelosOutcomeRevisionReceiptSchema.safeParse(value);
    if (revision.success)
      return (
        <section className="tool-pill-section" aria-label="Outcome changes requested">
          <p>Changes requested</p>
          <p>{revision.data.feedback}</p>
          <p className="perm-banner-scope">
            The original proposal is retained. Review the revised proposal before saving.
          </p>
        </section>
      );
  } catch {
    /* Other tool output keeps its existing failure presentation. */
  }
  if (!block.toolError) return null;
  return (
    <section className="tool-pill-section" aria-label="Outcome creation problem">
      <p className="perm-banner-response-error">Couldn’t confirm outcome creation</p>
      <ToolResultContent text={block.toolResult} />
    </section>
  );
}
