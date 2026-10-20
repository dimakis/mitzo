import type { TelosWorkView, TelosWorkSessionLink, TelosWorkSourceSnapshot } from '@mitzo/protocol';

export interface TelosChatRow {
  key: string;
  conversation: TelosWorkSessionLink['conversation'];
  labels: string[];
  links: TelosWorkSessionLink[];
  sources: TelosWorkSourceSnapshot[];
  availability: TelosWorkSessionLink['availability'];
  unknownAssignmentRoles?: Array<'lead' | 'worker'>;
}
const identity = (ref: TelosChatRow['conversation']) =>
  JSON.stringify([ref.namespace, ref.conversationId]);

/** A unique conversation may have several roles and reviewed source snapshots.
 * Assignment is read from current assignments only; links cannot confer it. */
export function telosChatRows(work: TelosWorkView): TelosChatRow[] {
  const rows = new Map<string, TelosChatRow>();
  function row(conversation: TelosChatRow['conversation']) {
    const key = identity(conversation);
    if (!rows.has(key))
      rows.set(key, {
        key,
        conversation,
        labels: [],
        links: [],
        sources: [],
        availability: 'unknown',
        unknownAssignmentRoles: [],
      });
    return rows.get(key)!;
  }
  for (const link of work.links) {
    const entry = row(link.conversation);
    entry.links.push(link);
    // Conflicting history never fabricates an available conversation.
    const states = entry.links.map((value) => value.availability);
    entry.availability = states.includes('unavailable')
      ? 'unavailable'
      : states.includes('unknown')
        ? 'unknown'
        : 'available';
    const assigned = work.assignments.some(
      (assignment) =>
        assignment.role === link.role && identity(assignment.conversation) === entry.key,
    );
    let label: string;
    if (link.role === 'origin') label = 'Originating conversation';
    else if (assigned) label = `Assigned ${link.role}`;
    else if (link.role === 'lead' || link.role === 'worker') {
      const history = work.assignmentHistory?.[link.role];
      const previous =
        link.conversation.namespace === 'mitzo' &&
        history?.conversationIds.includes(link.conversation.conversationId);
      if (previous) label = 'Previous conversation';
      else if (history?.complete === true)
        label = link.role === 'lead' ? 'Additional lead conversation' : 'Additional worker';
      else {
        label = link.role === 'lead' ? 'Lead conversation' : 'Worker conversation';
        const unknown = (entry.unknownAssignmentRoles ??= []);
        if (!unknown.includes(link.role)) unknown.push(link.role);
      }
    } else label = link.role === 'advisor' ? 'Advisor' : 'Reviewer';
    if (!entry.labels.includes(label)) entry.labels.push(label);
  }
  for (const source of work.sources) {
    if (!source.source) continue;
    const entry = row(source.source);
    entry.sources.push(source);
    if (!entry.labels.includes('Originating conversation'))
      entry.labels.push('Originating conversation');
  }
  return [...rows.values()];
}

/** Only a unique, available ordinary non-origin conversation permits direct entry. */
export function telosDirectChat(work: TelosWorkView): TelosChatRow | null {
  const rows = telosChatRows(work);
  const only = rows[0];
  return rows.length === 1 &&
    only.conversation.namespace === 'mitzo' &&
    only.availability === 'available' &&
    only.links.some((link) => link.role !== 'origin')
    ? only
    : null;
}
