import { join, basename, dirname } from 'node:path';
import { statSync, existsSync, realpathSync } from 'node:fs';
import { privateCodexPathSnapshot } from './codex-private-path.js';
import { InboxQuery, type MitzoNotification } from '@mitzo/protocol';
import { scanInboxItems, discardInboxItem } from './inbox.js';
import { NotificationStore } from './notification-store.js';
import { InboxScanner, type InboxSource } from './inbox-scanner.js';

export function discardInboxSource(
  store: NotificationStore,
  root: string,
  filename: string,
): boolean {
  if (!discardInboxItem(root, filename)) return false;
  // The retained DELETE route can run before reconciliation after a restart.
  // Preserve the durable evidence and cancel delivery without relying on its in-memory file map.
  store.archiveMissingSource(`inbox:${filename}`);
  return true;
}

function category(
  agent: string,
  kind: string | undefined,
): NonNullable<MitzoNotification['inbox']>['category'] {
  if (['briefing', 'proposal', 'alert', 'maintenance', 'report'].includes(kind ?? ''))
    return kind as NonNullable<MitzoNotification['inbox']>['category'];
  if (agent === 'morning-briefing' || agent === 'morning_enricher') return 'briefing';
  if (['health_monitor', 'load_monitor', 'service_monitor'].includes(agent)) return 'alert';
  if (['worktree_gc', 'dream_detector'].includes(agent)) return 'maintenance';
  if (['dream', 'session_scribe', 'pr_shepherd'].includes(agent)) return 'report';
  return 'proposal';
}
/** The notification ledger owns lifecycle state; Markdown remains recoverable evidence.
 * Reconciliation never queues native delivery or moves/deletes source files. */
export class UnifiedInbox {
  private lastRoot = '';
  private activeFiles = new Map<string, string>();
  private sourceVersions = new Map<string, string>();
  private scanner = new InboxScanner();
  private pending?: Promise<boolean>;
  constructor(
    private store: NotificationStore,
    private directory: () => string | undefined,
  ) {
    store.setInboxReadPolicy(() => {
      const root = this.directory();
      const policy = privateCodexPathSnapshot();
      const sourceName = (name: string) => name.replace(/_[a-f0-9]{32}(?=\.md$)/, '');
      const privateNames = new Set(policy.roots.map((path) => sourceName(basename(path))));
      return (filename, sourcePath) => {
        if (basename(filename) !== filename || filename.includes('..') || !filename.endsWith('.md'))
          return false;
        // Provenance can become stale before reconciliation when a source is moved.
        // Private archive names also protect the original logical record identity.
        if (!sourcePath && privateNames.has(sourceName(filename))) return false;
        if (sourcePath) {
          const parent = dirname(sourcePath);
          const originalRoot = basename(parent) === 'archive' ? dirname(parent) : parent;
          if (
            policy.roots.some(
              (path) =>
                sourceName(basename(path)) === sourceName(filename) &&
                [originalRoot, join(originalRoot, 'archive')].includes(dirname(path)),
            )
          )
            return false;
        }
        const locations = [
          ...(sourcePath ? [sourcePath] : []),
          ...(root ? [join(root, filename), join(root, 'archive', filename)] : []),
        ];
        return locations.length > 0 && locations.every((path) => !policy.isPrivate(path));
      };
    });
  }
  reconcile(): boolean {
    const root = this.directory();
    if (!root || !existsSync(root)) return false;
    const archive = join(root, 'archive');
    return this.reconcileSources(
      root,
      scanInboxItems(root),
      existsSync(archive) ? scanInboxItems(archive) : [],
    );
  }
  reconcileAsync(): Promise<boolean> {
    if (this.pending) return this.pending;
    this.pending = (async () => {
      const root = this.directory();
      if (!root) return false;
      const active = await this.scanner.scan(root);
      const archived = await this.scanner.scan(join(root, 'archive'));
      if (root !== this.directory()) return false;
      return this.reconcileSources(root, active, archived);
    })().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
  private reconcileSources(
    root: string,
    active: Array<ReturnType<typeof scanInboxItems>[number] | InboxSource>,
    archive: Array<ReturnType<typeof scanInboxItems>[number] | InboxSource>,
  ): boolean {
    if (this.lastRoot !== root) this.sourceVersions.clear();
    const previousActive = this.lastRoot === root ? this.activeFiles : new Map<string, string>();
    const activeNames = new Set(active.map((item) => item.summary.filename));
    const nextActive = new Map<string, string>();
    let changed = false;
    const seen = new Set<string>();
    for (const archived of [false, true]) {
      const path = archived ? join(root, 'archive') : root;
      if (!existsSync(path)) continue;
      for (const item of archived ? archive : active) {
        const { summary, content, meta } = item;
        const sourceKey = join(path, summary.filename);
        seen.add(sourceKey);
        const originalName = summary.filename.replace(/_[a-f0-9]{32}(?=\.md$)/, '');
        const version =
          'version' in item
            ? `${item.version}:${activeNames.has(summary.filename)}:${activeNames.has(originalName)}`
            : undefined;
        if (!archived) nextActive.set(`inbox:${summary.filename}`, summary.filename);
        if (version !== undefined && this.sourceVersions.get(sourceKey) === version) continue;
        let filename = summary.filename;
        let id = `inbox:${filename}`;
        if (archived) {
          const original = filename.replace(/_[a-f0-9]{32}(?=\.md$)/, '');
          if (
            original !== filename &&
            !activeNames.has(original) &&
            this.store.get(`inbox:${original}`)?.inbox?.content === content
          ) {
            filename = original;
            id = `inbox:${original}`;
          } else if (activeNames.has(filename) || this.store.get(`inbox:archive:${filename}`)) {
            id = `inbox:archive:${filename}`;
          }
        } else {
          nextActive.set(id, filename);
        }
        const kind = category(summary.agent, meta.kind);
        const severity =
          meta.severity === 'critical'
            ? 'critical'
            : meta.severity === 'warning'
              ? 'warning'
              : 'info';
        // Legacy 'pending' meant unread file, not an explicit actionable request.
        const needsAttention =
          ['review', 'approve', 'rescue'].includes(meta.action) && meta.status !== 'resolved';
        const parsed = Date.parse(summary.timestamp);
        const at = Number.isFinite(parsed)
          ? parsed
          : 'modified' in item
            ? item.modified
            : statSync(join(path, summary.filename)).mtimeMs;
        const updated = this.store.syncInbox(
          {
            id,
            kind: 'update',
            inboxFilename: filename,
            title: summary.title || summary.filename,
            body: summary.preview,
            inbox: {
              agent: summary.agent,
              tags: summary.tags,
              category: kind,
              severity,
              needsAttention,
              status: meta.status || 'pending',
              content,
            },
          },
          at,
          archived,
          'source' in item ? item.source : realpathSync(join(path, summary.filename)),
        );
        if (version !== undefined) this.sourceVersions.set(sourceKey, version);
        changed ||= updated;
      }
    }
    for (const [id, filename] of previousActive) {
      if (!nextActive.has(id) && !existsSync(join(root, filename))) {
        changed = this.store.archiveMissingSource(id) || changed;
      }
    }
    this.lastRoot = root;
    this.activeFiles = nextActive;
    for (const path of this.sourceVersions.keys())
      if (!seen.has(path)) this.sourceVersions.delete(path);
    return changed;
  }
  feed(query: Partial<InboxQuery>) {
    this.reconcile();
    return this.store.inboxFeed(InboxQuery.parse(query));
  }
  get(id: string) {
    this.reconcile();
    return this.store.get(id);
  }
}
