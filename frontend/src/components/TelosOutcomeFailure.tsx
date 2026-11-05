import type { ToolBlock } from '../lib/tool-status';
import { ToolResultContent } from './ToolResultContent';

function isTelosOutcomeCall(block: ToolBlock) {
  return ['TelosCreateOutcome', 'mcp__telos__TelosCreateOutcome'].includes(block.toolName ?? '');
}

/** Keep the failure visible when ordinary activity details collapse. No retry
 * action here: an uncertain write must recover its original reviewed attempt. */
export function TelosOutcomeFailure({ block }: { block: ToolBlock }) {
  if (!isTelosOutcomeCall(block) || !block.toolError || !block.toolResult) return null;
  return (
    <section className="tool-pill-section" aria-label="Outcome creation problem">
      <p className="perm-banner-response-error">Couldn’t confirm outcome creation</p>
      <ToolResultContent text={block.toolResult} />
    </section>
  );
}
