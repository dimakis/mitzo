import type { EventStore } from './event-store.js';
import { TelosWorkStore } from './telos-work-store.js';
import { telosDatabasePath } from './telos-database.js';
import { resolveTelosWorkRoleContext } from './telos-work-role-context.js';
import { observeWorkAssignment } from './telos-work-observation.js';
import { isAvailableTelosWorkConversation } from './telos-work-conversation.js';
import { createLogger } from './logger.js';
import { sessionMetadataDiagnostic } from './session-metadata-error.js';

/** A fresh canonical observation supplements immutable reviewed context. It never
 * updates assignments, context hashes, task scope, admission or message receipts. */
export function observeTelosSessionCoordination(
  events: EventStore,
  conversationId: string | undefined,
  owner?: Pick<TelosWorkStore, 'readConversationCoordination'>,
  isLive?: (id: string) => boolean,
) {
  if (!conversationId) return undefined;
  let work: TelosWorkStore | undefined;
  try {
    const meta = events.getSession(conversationId);
    const selected = resolveTelosWorkRoleContext(
      events,
      conversationId,
      meta?.accountBinding ?? undefined,
    );
    if (!selected || !['lead', 'worker'].includes(selected.role)) return undefined;
    const reader =
      owner ??
      (work = new TelosWorkStore(
        telosDatabasePath(),
        { ordinaryConversation: (id) => isAvailableTelosWorkConversation(events.getSession(id)) },
        true,
      ));
    const scope = reader.readConversationCoordination(selected.itemId, conversationId);
    const assignment = scope.item.assignments.find((a) => a.role === selected.role);
    const current = assignment?.conversation.conversationId === conversationId;
    const report = (item: typeof scope.item, role: 'lead' | 'worker') => {
      return observeWorkAssignment(item, role, events, isLive);
    };
    const reportingTo = current && scope.ancestors[0] ? report(scope.ancestors[0], 'lead') : null;
    const unavailable =
      reportingTo &&
      (reportingTo.availability === 'unavailable' ||
        (isLive && reportingTo.runtimeState === 'not_live') ||
        ('executionPhase' in reportingTo &&
          (reportingTo.executionPhase === 'STOPPING' ||
            (reportingTo.executionPhase === 'TERMINAL' &&
              ['stopped', 'interrupted'].includes(reportingTo.executionTerminalReason ?? '')))));
    return {
      observedAt: Date.now(),
      itemId: selected.itemId,
      workLevel:
        scope.item.kind === 'coordinator'
          ? 'outcome'
          : scope.item.kind === 'outcome'
            ? 'feature'
            : scope.item.kind === 'work_item'
              ? 'slice'
              : null,
      role: selected.role,
      revision: scope.item.revision,
      assignment: current
        ? ('current' as const)
        : assignment
          ? ('previous' as const)
          : ('unassigned' as const),
      assignmentRevision: assignment?.revision ?? null,
      reportingTo,
      children: scope.children.map((child) => ({
        itemId: child.itemId,
        summary: child.summary,
        lead: report(child, 'lead'),
        worker: report(child, 'worker'),
      })),
      diagnostic: unavailable
        ? 'assigned_coordinator_unavailable'
        : current && scope.ancestors.length && !reportingTo
          ? 'coordinator_assignment_required'
          : !current
            ? 'current_assignment_required'
            : null,
    };
  } catch (cause) {
    createLogger('telos-session-coordination').warn('Current work coordination unavailable', {
      code: 'coordination_unavailable',
      stage: 'canonical_assignment',
      conversationId,
      ...sessionMetadataDiagnostic(cause),
    });
    return { diagnostic: 'coordination_unavailable' as const };
  } finally {
    work?.close();
  }
}

export function renderTelosSessionCoordination(
  observation: ReturnType<typeof observeTelosSessionCoordination>,
): string {
  if (!observation) return '';
  return `\n## Current Telos coordination\nThis read-only observation supplements the original reviewed context above. Current work level and responsibility come from canonical assignments; retained startup labels and creation/takeover provenance do not reassign a session. Use the current reportingTo conversation for worker reports. If unavailable, preserve work and report the diagnostic; never substitute a stopped or provenance-only lead. Refresh TelosManageItem before coordination decisions. Missing evidence never proves work has not started. Keep created, assigned, admitted, running, received, applied and completed separate. This observation grants no control, messaging or execution authority.\n${JSON.stringify(observation)}\n`;
}
