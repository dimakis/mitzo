import type { EventStore } from './event-store.js';
import type { Session, TelosWorkView } from '@mitzo/protocol';
import { createLogger } from './logger.js';
import { sessionMetadataDiagnostic } from './session-metadata-error.js';
import { sessionConversationNavigation } from './session-list-metadata.js';
import type { TelosWorkStore } from './telos-work-store.js';

/** Read-only observations. A retained routing choice is never runtime readiness,
 * command authority, or proof that a provider accepted a turn. */
export function observeWorkConversation(
  events: EventStore,
  conversationId: string,
  isLive?: (id: string) => boolean,
) {
  const meta = events.getSession(conversationId);
  if (!meta || meta.isHidden)
    return {
      conversationId,
      name: null,
      availability: 'unavailable' as const,
      runtimeState: 'unknown' as const,
      startEvidence: { state: 'unknown' as const },
    };
  const identity = {
    conversationId,
    name:
      sessionConversationNavigation(events, conversationId).summary ??
      meta.summary ??
      'Untitled conversation',
    availability: 'available' as const,
    agentName: meta.agentProfile?.definition.name ?? meta.agentName ?? undefined,
    model: meta.selectedModel ?? meta.accountBinding?.model ?? undefined,
    accountLabel: meta.accountBinding?.accountLabel,
  };
  try {
    const binding = events.getSessionRuntimeBinding(conversationId);
    const admission = events.getLatestOrdinaryCommandAdmission(conversationId);
    return {
      ...identity,
      engine: binding?.harness.implementation,
      executionLocation: binding?.execution.location,
      runtimeUnavailable: !binding,
      runtimeState: isLive
        ? isLive(conversationId)
          ? ('live' as const)
          : ('not_live' as const)
        : ('unknown' as const),
      executionPhase: meta.executionPhase,
      executionTerminalReason: meta.executionTerminalReason,
      startEvidence: {
        state: admission ? ('admission_recorded' as const) : ('unknown' as const),
        admissionState: admission?.state ?? null,
        initialCommandId: events.getOrdinaryInitialCommandId(conversationId) ?? null,
      },
    };
  } catch (cause) {
    createLogger('telos-work-observation').warn('Worker runtime observation unavailable', {
      stage: 'work_conversation_observation',
      code: 'work_runtime_observation_unavailable',
      conversationId,
      ...sessionMetadataDiagnostic(cause),
    });
    return {
      ...identity,
      runtimeUnavailable: true,
      runtimeState: 'unknown' as const,
      startEvidence: { state: 'unknown' as const },
    };
  }
}

export function sessionRuntimeIdentity(
  events: EventStore,
  conversationId: string,
): Pick<Session, 'agentName' | 'engine' | 'executionLocation' | 'runtimeUnavailable'> {
  const observation = observeWorkConversation(events, conversationId);
  return {
    agentName: 'agentName' in observation ? observation.agentName : undefined,
    engine: 'engine' in observation ? observation.engine : undefined,
    executionLocation:
      'executionLocation' in observation ? observation.executionLocation : undefined,
    runtimeUnavailable: 'runtimeUnavailable' in observation ? observation.runtimeUnavailable : true,
  };
}

export function observeWorkAssignment(
  work: Pick<TelosWorkView, 'itemId' | 'assignments'> & {
    links?: Array<Pick<TelosWorkView['links'][number], 'role' | 'conversation' | 'availability'>>;
  },
  role: 'lead' | 'worker',
  events?: EventStore,
  isLive?: (id: string) => boolean,
) {
  const current = work.assignments.find((a) => a.role === role);
  if (!current) return null;
  const id = current.conversation.conversationId;
  return {
    ...(events
      ? observeWorkConversation(events, id, isLive)
      : {
          conversationId: id,
          name: null,
          availability: 'unknown',
          runtimeState: 'unknown',
          startEvidence: { state: 'unknown' },
        }),
    ...(work.links &&
    !work.links.some(
      (link) =>
        link.role === role &&
        link.conversation.namespace === 'mitzo' &&
        link.conversation.conversationId === id &&
        link.availability === 'available',
    )
      ? { availability: 'unavailable' as const }
      : {}),
    itemId: work.itemId,
    role,
    assignmentRevision: current.revision,
    assignedAt: current.assignedAt,
    path: `/chat/${encodeURIComponent(id)}`,
  };
}

export function telosWorkContext(
  work: TelosWorkView,
  events?: EventStore,
  isLive?: (id: string) => boolean,
  scope?: ReturnType<TelosWorkStore['readCoordination']>,
) {
  const assignment = (role: 'lead' | 'worker') => observeWorkAssignment(work, role, events, isLive);
  const currentWorker = assignment('worker');
  const latestAllocation = work.attempts.at(-1) ?? null;
  const workerId = currentWorker?.conversationId;
  const targetId = workerId ?? latestAllocation?.workerConversationId;
  const target = events && targetId ? observeWorkConversation(events, targetId, isLive) : undefined;
  const sameAllocation = !!targetId && latestAllocation?.workerConversationId === targetId;
  const supported =
    sameAllocation &&
    latestAllocation?.state === 'chat_ready' &&
    target &&
    'engine' in target &&
    target.engine === 'codex' &&
    target.executionLocation === 'local';
  return {
    revision: work.revision,
    currentLead: assignment('lead'),
    currentWorker,
    ...(scope
      ? {
          reportingTo: scope.ancestors[0]
            ? observeWorkAssignment(scope.ancestors[0], 'lead', events, isLive)
            : null,
          children: scope.children.map((child) => ({
            itemId: child.itemId,
            summary: child.summary,
            currentLead: observeWorkAssignment(child, 'lead', events, isLive),
            currentWorker: observeWorkAssignment(child, 'worker', events, isLive),
          })),
        }
      : {}),
    latestAllocation,
    assignmentHistory: work.assignmentHistory,
    startExistingWorker: {
      supported: !!supported,
      conversationId: targetId ?? null,
      reason: !targetId
        ? 'worker_setup_required'
        : !sameAllocation
          ? 'current_worker_differs_from_allocation'
          : latestAllocation?.state !== 'chat_ready'
            ? 'recover_original_allocation'
            : !supported
              ? 'worker_start_route_unavailable'
              : 'request_exact_start_approval',
    },
  };
}
