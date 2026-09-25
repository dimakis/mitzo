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
  /** Map from progressId to current progress block. */
  blocks: Record<string, ProgressBlock>;
  /** Map from sourceToolId to progressId (for ChatArea lookup). */
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
      itemId: string;
      status: ProgressItemStatus;
    }
  | {
      type: 'replace';
      progressId: string;
      sourceToolId?: string;
      items: ProgressItem[];
    };

// ─── Reducer ────────────────────────────────────────────────────────────────

export function applyProgressUpdate(state: ProgressState, update: ProgressUpdate): ProgressState {
  switch (update.type) {
    case 'start': {
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
        ] = update.progressId;
      }
      return {
        blocks: { ...state.blocks, [update.progressId]: block },
        toolIndex,
      };
    }

    case 'update': {
      const existing = state.blocks[update.progressId];
      if (!existing) return state;
      const items = existing.items.map((item) =>
        item.id === update.itemId ? { ...item, status: update.status } : item,
      );
      return {
        ...state,
        blocks: {
          ...state.blocks,
          [update.progressId]: { ...existing, items },
        },
      };
    }

    case 'replace': {
      const existing = state.blocks[update.progressId];
      if (!existing) return state;
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
        ] = update.progressId;
      }
      return {
        blocks: {
          ...state.blocks,
          [update.progressId]: {
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
