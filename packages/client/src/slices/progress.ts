/**
 * Progress slice — tracks in-session agent progress from TodoWrite interception.
 *
 * Separate from messages (async updates) and tasks (persistent orchestration).
 * The ProgressWidget reads from this slice to render inline progress.
 */

import type {
  ProgressItem,
  ProgressItemStatus,
  ProgressBlock,
  SymposiumProvenance,
} from '@mitzo/protocol';

export type { ProgressItem, ProgressItemStatus, ProgressBlock };

export interface ProgressState {
  /** Map from seat-scoped progress identity to current progress block. */
  blocks: Record<string, ProgressBlock>;
  /** Map from source tool identity to block storage key (for ChatArea lookup). */
  toolIndex: Record<string, string>;
}

export const INITIAL_PROGRESS_STATE: ProgressState = {
  blocks: {},
  toolIndex: {},
};

/** The same provider message/tool IDs may be reused in different seat streams. */
export function progressToolLookupKey(
  messageId: string,
  toolId: string,
  provenance?: SymposiumProvenance,
): string {
  return provenance
    ? `symposium:${JSON.stringify([provenance.seatId, provenance.membershipGeneration ?? null, messageId, toolId])}`
    : toolId;
}

function progressBlockKey(progressId: string, provenance?: SymposiumProvenance): string {
  return provenance
    ? `symposium:${JSON.stringify([provenance.seatId, provenance.membershipGeneration ?? null, progressId])}`
    : progressId;
}

function resolveProgressBlockKey(
  state: ProgressState,
  update: {
    progressId: string;
    symposiumProvenance?: SymposiumProvenance;
  },
): string | undefined {
  if (update.symposiumProvenance) {
    const key = progressBlockKey(update.progressId, update.symposiumProvenance);
    return state.blocks[key] ? key : undefined;
  }
  if (state.blocks[update.progressId]) return update.progressId;
  // Older progress updates omit provenance. Apply only if their target is unique.
  const matches = Object.keys(state.blocks).filter(
    (key) => state.blocks[key].progressId === update.progressId,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

// ─── Update types ───────────────────────────────────────────────────────────

export type ProgressUpdate =
  | {
      type: 'start';
      progressId: string;
      messageId: string;
      symposiumProvenance?: SymposiumProvenance;
      sourceToolId?: string;
      items: ProgressItem[];
    }
  | {
      type: 'update';
      progressId: string;
      symposiumProvenance?: SymposiumProvenance;
      itemId: string;
      status: ProgressItemStatus;
    }
  | {
      type: 'replace';
      progressId: string;
      symposiumProvenance?: SymposiumProvenance;
      sourceToolId?: string;
      items: ProgressItem[];
    };

// ─── Reducer ────────────────────────────────────────────────────────────────

export function applyProgressUpdate(state: ProgressState, update: ProgressUpdate): ProgressState {
  switch (update.type) {
    case 'start': {
      const blockKey = progressBlockKey(update.progressId, update.symposiumProvenance);
      const block: ProgressBlock = {
        progressId: update.progressId,
        items: update.items,
        sourceToolId: update.sourceToolId,
        ...(update.symposiumProvenance
          ? {
              sourceMessageId: update.messageId,
              symposiumProvenance: update.symposiumProvenance,
            }
          : {}),
      };
      const toolIndex = { ...state.toolIndex };
      if (update.sourceToolId) {
        toolIndex[
          progressToolLookupKey(update.messageId, update.sourceToolId, update.symposiumProvenance)
        ] = blockKey;
      }
      return {
        blocks: { ...state.blocks, [blockKey]: block },
        toolIndex,
      };
    }

    case 'update': {
      const blockKey = resolveProgressBlockKey(state, update);
      const existing = blockKey ? state.blocks[blockKey] : undefined;
      if (!blockKey || !existing) return state;
      const items = existing.items.map((item) =>
        item.id === update.itemId ? { ...item, status: update.status } : item,
      );
      return {
        ...state,
        blocks: {
          ...state.blocks,
          [blockKey]: { ...existing, items },
        },
      };
    }

    case 'replace': {
      const blockKey = resolveProgressBlockKey(state, update);
      const existing = blockKey ? state.blocks[blockKey] : undefined;
      if (!blockKey || !existing) return state;
      const toolIndex = { ...state.toolIndex };
      if (update.sourceToolId) {
        toolIndex[
          existing.sourceMessageId
            ? progressToolLookupKey(
                existing.sourceMessageId,
                update.sourceToolId,
                existing.symposiumProvenance,
              )
            : update.sourceToolId
        ] = blockKey;
      }
      return {
        blocks: {
          ...state.blocks,
          [blockKey]: {
            ...existing,
            items: update.items,
            sourceToolId: update.sourceToolId ?? existing.sourceToolId,
          },
        },
        toolIndex,
      };
    }
  }
}
