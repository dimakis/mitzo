import type { TelosItemStore } from './telos-item-store.js';
import type { TelosWorkStore } from './telos-work-store.js';
import type { telosWorkContext } from './telos-work-observation.js';

/** A current-status projection, never a second authority/cache or a history export. */
export function telosWorkOverview(value: {
  item: ReturnType<TelosItemStore['read']>;
  lifecycle: ReturnType<TelosWorkStore['readLifecycle']>;
  workContext: ReturnType<typeof telosWorkContext>;
}) {
  const { item, lifecycle, workContext: context } = value;
  const truncatedFields: string[] = [];
  const text = (field: string, source: string, limit: number) => {
    if (source.length <= limit) return source;
    truncatedFields.push(field);
    return source.slice(0, limit).replace(/[\uD800-\uDBFF]$/u, '') + '…';
  };
  const first = <T>(field: string, source: T[], limit: number) => {
    if (source.length > limit) truncatedFields.push(field);
    return source.slice(0, limit);
  };
  const assignment = (field: string, source: typeof context.currentLead) => {
    if (!source) return null;
    // Detailed provider/account labels are available through the explicit full
    // read; current identity, revision and execution observations remain distinct.
    return {
      conversationId: source.conversationId,
      itemId: source.itemId,
      role: source.role,
      assignmentRevision: source.assignmentRevision,
      assignedAt: source.assignedAt,
      path: source.path,
      name: source.name === null ? null : text(field + '.name', source.name, 160),
      availability: source.availability,
      runtimeState: source.runtimeState,
      startEvidence: source.startEvidence,
      ...('engine' in source
        ? { engine: source.engine, executionLocation: source.executionLocation }
        : {}),
      ...('executionPhase' in source
        ? {
            executionPhase: source.executionPhase,
            executionTerminalReason: source.executionTerminalReason,
          }
        : {}),
      ...('runtimeUnavailable' in source ? { runtimeUnavailable: source.runtimeUnavailable } : {}),
    };
  };
  return {
    view: 'overview' as const,
    item: {
      id: item.id,
      workLevel: item.workLevel,
      status: item.status,
      parentId: item.parentId,
      revision: item.revision,
      updatedAt: item.updatedAt,
      summary: text('item.summary', item.summary, 240),
      intent: text('item.intent', item.intent, 600),
      rationale: text('item.rationale', item.rationale, 300),
      acceptanceCriteria: first('item.acceptanceCriteria', item.acceptanceCriteria, 3).map(
        (criterion, index) => text(`item.acceptanceCriteria[${index}]`, criterion, 160),
      ),
      children: first('item.children', item.children, 5).map((child, index) => ({
        ...child,
        summary: text(`item.children[${index}].summary`, child.summary, 120),
      })),
      updates: first('item.updates', item.updates, 1).map((update, index) => ({
        ...update,
        note: text(`item.updates[${index}].note`, update.note, 240),
      })),
    },
    counts: {
      children: item.children.length,
      acceptanceCriteria: item.acceptanceCriteria.length,
      updatesInFullReadWindow: item.updates.length,
      assignmentHistory: context.assignmentHistory.length,
      lifecycleHistory: lifecycle.history.length,
    },
    lifecycle: {
      itemId: lifecycle.itemId,
      revision: lifecycle.revision,
      disposition: lifecycle.disposition,
      effectiveDisposition: lifecycle.effectiveDisposition,
      pause: { stage: lifecycle.pause.stage, controlCount: lifecycle.pause.controls.length },
    },
    workContext: {
      revision: context.revision,
      currentLead: assignment('workContext.currentLead', context.currentLead),
      currentWorker: assignment('workContext.currentWorker', context.currentWorker),
      reportingTo: assignment('workContext.reportingTo', context.reportingTo ?? null),
      children: first('workContext.children', context.children ?? [], 5).map((child, index) => ({
        itemId: child.itemId,
        summary: text(`workContext.children[${index}].summary`, child.summary, 120),
        currentLead: assignment(`workContext.children[${index}].currentLead`, child.currentLead),
        currentWorker: assignment(
          `workContext.children[${index}].currentWorker`,
          child.currentWorker,
        ),
      })),
      latestAllocation: context.latestAllocation,
      startExistingWorker: context.startExistingWorker,
    },
    truncatedFields,
    details: {
      tool: 'TelosManageItem',
      input: { operation: 'read', itemId: item.id, view: 'full' },
    },
  };
}
