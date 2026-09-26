import { z } from 'zod';

export const SymposiumContextPackageSchema = z.strictObject({
  mode: z.enum(['independent', 'summary', 'selected-turns', 'full-context']),
  summary: z.string().max(16000).optional(),
  turnIds: z.array(z.string().min(1)).max(200).optional(),
});
export interface ShareableContextTurn {
  id: string;
  content: string;
  shareable: boolean;
}

/** Pure, bounded snapshot: never retrieves history or calls a summarizing model. */
export function buildSymposiumContextPackage(
  request: z.infer<typeof SymposiumContextPackageSchema>,
  turns: ShareableContextTurn[],
): string {
  const input = SymposiumContextPackageSchema.parse(request);
  if (input.mode === 'independent') return '';
  if (input.mode === 'summary') {
    if (!input.summary?.trim()) throw new Error('Write the summary to share');
    return `Operator-selected summary:\n${input.summary.trim()}`;
  }
  const eligible = turns.filter((turn) => turn.shareable);
  let selected = eligible;
  if (input.mode === 'selected-turns') {
    if (!input.turnIds?.length) throw new Error('Select at least one shared turn');
    if (input.turnIds.some((id) => !eligible.some((turn) => turn.id === id)))
      throw new Error('Selected turn is unavailable or private');
    selected = eligible.filter((turn) => input.turnIds!.includes(turn.id));
  }
  const content = selected.map((turn) => `[${turn.id}]\n${turn.content}`).join('\n\n');
  if (!content) throw new Error('No completed shared turns are available');
  if (content.length > 64000)
    throw new Error('Context is too large; select fewer turns or write a summary');
  return `Explicit shared conversation context (${input.mode}):\n${content}`;
}
