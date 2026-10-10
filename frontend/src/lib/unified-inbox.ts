import type { MitzoNotification } from '@mitzo/protocol';

const names: Record<string, string> = {
  'morning-briefing': 'Daily briefing',
  morning_enricher: 'Briefing context',
  health_monitor: 'Workspace health',
  load_monitor: 'Workload alerts',
  service_monitor: 'Service health',
  worktree_gc: 'Unsaved work',
  troubadour: 'Suggested connections',
  dream: 'Memory consolidation',
  dream_detector: 'Memory maintenance checks',
  session_scribe: 'Session summaries',
  patent_radar: 'Patent research',
  pr_shepherd: 'Pull requests',
};
export function inboxSource(source: string) {
  return names[source] || source.replaceAll('_', ' ');
}
export function inboxNeedsYou(item: MitzoNotification) {
  return (
    item.resolvedAt === null &&
    item.archivedAt == null &&
    (item.expiresAt === undefined || item.expiresAt > Date.now()) &&
    (item.kind === 'approval' || item.kind === 'question' || !!item.inbox?.needsAttention)
  );
}
export function inboxTitle(item: MitzoNotification) {
  if (item.inbox?.agent === 'troubadour') {
    const pair = item.title.match(/^\[[^\]]+\]\s+(.+)\s+↔\s+(.+)$/);
    if (pair)
      return `Possible connection: ${pair[2].replace(/^\d{4}-\d{2}-\d{2}\s+/, '').replace(/\.md$/, '')}`;
  }
  return item.title;
}
export function inboxType(item: MitzoNotification) {
  if (item.kind === 'approval') return 'Approval';
  if (item.kind === 'question') return 'Question';
  if (item.kind === 'session') return 'Session update';
  return {
    briefing: 'Briefing',
    proposal: 'Suggestion',
    alert: 'Alert',
    maintenance: 'Maintenance',
    report: 'Report',
  }[item.inbox?.category ?? 'report'];
}
export function inboxSummary(item: MitzoNotification) {
  if (item.inbox?.agent === 'troubadour')
    return 'An unreviewed connection between notes. Inspect the evidence before keeping it.';
  if (item.inbox?.agent === 'worktree_gc')
    return 'A past session was flagged for unsaved changes. Review the record and current state.';
  if (item.inbox?.agent === 'patent_radar')
    return 'A keyword match awaiting a substantive review of the idea.';
  return item.body.replace(/^#+\s+/gm, '').replace(/\*\*|`/g, '');
}
