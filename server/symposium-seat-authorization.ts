import { contextPackSourceRef } from './context-pack-runtime.js';
import type { SymposiumHostGrantDeps } from './symposium-host-grants.js';

/** Application policy receives the original seat ceiling and its trusted selected recipe. */
export const authorizeSymposiumSeat: SymposiumHostGrantDeps['authorizeSeat'] = ({
  sessionId,
  seat,
  contextSourceRefs,
}) => {
  const sessionSource = `session:${sessionId}`;
  const packSources =
    seat.contextRecipe?.source === 'packs'
      ? seat.contextRecipe.packs.map(contextPackSourceRef)
      : [];
  if (
    contextSourceRefs.length > 0 &&
    contextSourceRefs.some((ref) => ref !== sessionSource && !packSources.includes(ref))
  )
    throw new Error('Only this conversation context can be admitted');
  const writable = seat.role === 'implementer' || seat.role === 'coder';
  return {
    classification: 'mixed' as const,
    sourceRefs: [...new Set([...contextSourceRefs, ...packSources])],
    authority: {
      filesystem:
        seat.authorityRequest?.filesystem ?? (writable ? ('write' as const) : ('read' as const)),
      tools: seat.authorityRequest?.tools ?? (writable ? ('write' as const) : ('read' as const)),
      network: seat.authorityRequest?.network ?? ('restricted' as const),
    },
  };
};
