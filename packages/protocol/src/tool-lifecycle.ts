/** A display projection of an ended execution, never a tool outcome or receipt. */
interface TerminalToolBlock {
  blockType: string;
  toolResult?: string;
  toolResultImages?: readonly unknown[];
  toolInterrupted?: boolean;
  subagent?: { blocks: TerminalToolBlock[]; running?: boolean };
}

/** Called only after the original owning execution's terminal event. Actual
 * results, including empty text and image-only replies, retain their meaning.
 * A late real result takes precedence over this display-only interruption. */
export function interruptUnansweredToolBlocks<T extends TerminalToolBlock>(blocks: T[]): T[] {
  let changed = false;
  const next = blocks.map((block) => {
    const children = block.subagent && interruptUnansweredToolBlocks(block.subagent.blocks);
    const interrupted =
      block.blockType === 'tool_use' &&
      block.toolResult === undefined &&
      !block.toolResultImages?.length &&
      !block.toolInterrupted;
    const subagentEnded =
      block.subagent && (children !== block.subagent.blocks || block.subagent.running);
    if (!interrupted && !subagentEnded) return block;
    changed = true;
    return {
      ...block,
      ...(interrupted ? { toolInterrupted: true } : {}),
      ...(subagentEnded
        ? { subagent: { ...block.subagent!, blocks: children!, running: undefined } }
        : {}),
    };
  });
  return changed ? next : blocks;
}
