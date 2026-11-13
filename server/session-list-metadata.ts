import { ModelTokenLimitsSchema } from '@mitzo/protocol';
import type { Session, SessionMeta } from '@mitzo/protocol';
import type { EventStore } from '@mitzo/protocol/event-store';
import { createLogger } from './logger.js';
import { sessionMetadataDiagnostic } from './session-metadata-error.js';
import { resolveTelosWorkRoleContext } from './telos-work-role-context.js';
import type { TelosWorkView } from '@mitzo/protocol';

const log = createLogger('session-model');
type ModelSelection = { model?: string };

/** Navigation over retained host context, never inferred from chat text. Parent
 * visibility remains independent; an unreadable relationship retains the chat. */
export function sessionConversationNavigation(
  events: EventStore,
  sessionId: string,
  origin?: () => string | undefined,
  readWork?: (id: string) => {
    work: TelosWorkView;
    item: { summary: string; workLevel: string | null };
  },
): Partial<
  Pick<
    Session,
    | 'summary'
    | 'parentConversationId'
    | 'parentConversationTitle'
    | 'treeUnavailable'
    | 'workRole'
    | 'parentRelationship'
    | 'conversationAncestors'
  >
> {
  try {
    const meta = events.getSession(sessionId);
    if (!meta || meta.isHidden) return {};
    const role = resolveTelosWorkRoleContext(events, sessionId, meta.accountBinding ?? undefined);
    let title: string | undefined;
    if (role?.brief.text.trim().startsWith('{')) {
      const brief: unknown = JSON.parse(role.brief.text);
      if (
        brief &&
        typeof brief === 'object' &&
        'summary' in brief &&
        typeof brief.summary === 'string'
      )
        title = brief.summary.trim().slice(0, 240) || undefined;
    }
    let parentId = role?.leadConversationId ?? origin?.();
    let parentRelationship: Session['parentRelationship'] = role ? 'retained_setup' : 'creation';
    let workRole: Session['workRole'];
    const ancestors: NonNullable<Session['conversationAncestors']> = [];
    if (role && readWork) {
      const { work, item } = readWork(role.itemId);
      title = item.summary;
      const assignment = work.assignments.find((a) => a.role === role.role);
      const current = assignment?.conversation.conversationId === sessionId;
      const level =
        item.workLevel === 'outcome' || item.workLevel === 'feature' || item.workLevel === 'slice'
          ? item.workLevel
          : null;
      workRole = {
        itemId: role.itemId,
        level,
        role: role.role,
        assignment: current ? 'current' : assignment ? 'previous' : 'pending',
      };
      // A retained source/lead reference is provenance, never current ownership.
      parentId = undefined;
      if (current && work.parentId) {
        const seen = new Set([role.itemId]);
        const conversations = new Set([sessionId]);
        let next: string | null = work.parentId;
        while (next) {
          if (seen.has(next) || seen.size >= 32) throw Error('Invalid retained work ancestry');
          seen.add(next);
          const parentWork = readWork(next);
          const id = parentWork.work.assignments.find((a) => a.role === 'lead')?.conversation
            .conversationId;
          const parentMeta = id ? events.getSession(id) : undefined;
          if (!id || !parentMeta || parentMeta.isHidden) break;
          if (conversations.has(id)) throw Error('Ambiguous assigned conversation ancestry');
          conversations.add(id);
          ancestors.push({
            id,
            summary: parentMeta.manuallyRenamed
              ? parentMeta.summary || 'Untitled conversation'
              : parentWork.item.summary,
          });
          next = parentWork.work.parentId;
        }
        for (let i = 0; i < ancestors.length - 1; i++) {
          ancestors[i].parentConversationId = ancestors[i + 1].id;
          ancestors[i].parentConversationTitle = ancestors[i + 1].summary;
        }
        parentId = ancestors[0]?.id;
        parentRelationship = 'assignment';
      }
    }
    const parent = parentId && parentId !== sessionId ? events.getSession(parentId) : undefined;
    return {
      ...(title && !meta.manuallyRenamed ? { summary: title } : {}),
      ...(workRole ? { workRole } : {}),
      ...(ancestors.length ? { conversationAncestors: ancestors } : {}),
      ...(parent && !parent.isHidden
        ? {
            parentConversationId: parent.sessionId,
            parentConversationTitle:
              ancestors[0]?.summary || parent.summary || 'Parent conversation',
            parentRelationship,
          }
        : {}),
    };
  } catch (error) {
    log.warn('Conversation relationship unavailable', {
      stage: 'conversation_tree',
      code: 'conversation_tree_unavailable',
      sessionId,
      ...sessionMetadataDiagnostic(error),
    });
    return { treeUnavailable: true };
  }
}

/** Absent receipts retain legacy metadata; unreadable receipts make the model unknown. */
export function readSessionModelSelection(
  store: Pick<EventStore, 'getLatestOrdinaryCommandAdmission'>,
  sessionId: string,
): ModelSelection | null | undefined {
  try {
    return store.getLatestOrdinaryCommandAdmission?.(sessionId)?.selection;
  } catch (error) {
    log.warn('Session model selection unavailable', {
      code: 'session_model_selection_unavailable',
      stage: 'model_selection',
      sessionId,
      ...sessionMetadataDiagnostic(error),
    });
    return null;
  }
}

export function sessionModelIdentity(
  meta: Partial<SessionMeta>,
  alias: (accountId: string, fallback: string) => string = (_id, fallback) => fallback,
  selection?: ModelSelection | null,
): Pick<Session, 'model' | 'accountLabel' | 'modelUnavailable' | 'modelObservedAt'> {
  const binding = meta.accountBinding;
  return {
    modelObservedAt: Date.now(),
    ...(selection === null ? { modelUnavailable: true } : {}),
    model:
      selection === null
        ? undefined
        : (selection?.model ??
          meta.selectedModel ??
          (binding?.provider !== 'unavailable' ? binding?.model : undefined)),
    accountLabel: binding ? alias(binding.accountId, binding.accountLabel) : undefined,
  };
}

/** Read-only list projection. Cumulative usage never establishes context occupancy. */
export function sessionListMetadata(
  meta: Partial<SessionMeta>,
  event: { payload: Record<string, unknown>; createdAt: number; seatId?: string } | null,
  alias?: (accountId: string, fallback: string) => string,
  selection?: ModelSelection | null,
): Pick<
  Session,
  | 'telosTaskId'
  | 'cwd'
  | 'contextUsage'
  | 'model'
  | 'accountLabel'
  | 'modelUnavailable'
  | 'modelObservedAt'
> {
  const context = event?.payload.agentContext;
  const limits = ModelTokenLimitsSchema.safeParse(event?.payload.tokenLimits);
  return {
    ...sessionModelIdentity(meta, alias, selection),
    telosTaskId: meta.telosTaskId ?? undefined,
    cwd: meta.cwd ?? undefined,
    contextUsage:
      event && !event.seatId && !meta.symposiumConfig
        ? {
            used:
              typeof context === 'number' && Number.isSafeInteger(context) && context > 0
                ? context
                : null,
            measuredAt: event.createdAt,
            limits: limits.success ? limits.data : null,
          }
        : undefined,
  };
}
