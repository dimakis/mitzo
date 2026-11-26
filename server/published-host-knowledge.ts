import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import type { KnowledgeStore } from './knowledge-store-config.js';
import { knowledgePublicationFailureDiagnostic } from './knowledge-publication-bridge.js';
import { createLogger } from './logger.js';
import { beginOperationObservation } from './operation-observation.js';

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const Baseline = z.object({
  startingCommit: z.string().regex(/^[a-f0-9]{40}$/),
  files: z.record(z.string(), z.object({ sha256: sha, mode: z.string().regex(/^0[0-7]{3}$/) })),
});
type View = {
  store: KnowledgeStore;
  root: string;
  sourceCommit: string;
  baselineSha256: string;
  files: z.infer<typeof Baseline>['files'];
  context: string;
};
let store: KnowledgeStore | undefined;
const views = new WeakMap<object, View>();
export const hasHostKnowledgeStore = () => store !== undefined;

class PublishedKnowledgeProblem extends Error {
  constructor(
    readonly reason:
      | 'path_not_published'
      | 'path_changed'
      | 'document_too_large'
      | 'integrity_mismatch'
      | 'enrollment_changed'
      | 'selection_changed'
      | 'source_changed',
    message: string,
  ) {
    super(message);
  }
}
/** Fixed categories preserve diagnostic value without logging source paths or bytes. */
export function publishedKnowledgeFailureReason(error: unknown): string {
  if (error instanceof PublishedKnowledgeProblem) return error.reason;
  if (error instanceof Error && 'code' in error) {
    if (error.code === 'ENOENT') return 'document_unavailable';
    if (error.code === 'EACCES' || error.code === 'EPERM') return 'filesystem_denied';
    if (error.code === 'EIO' || error.code === 'ELOOP') return 'filesystem_failed';
  }
  return 'unexpected_failure';
}

type SelectionIdentity = {
  sessionId: string;
  commandId?: string;
  route: 'openai-api' | 'chatgpt-subscription';
};
type SelectionOutcome = {
  outcome: 'success' | 'unavailable' | 'skipped' | 'cancelled';
  reason:
    | 'selected'
    | 'store_not_enrolled'
    | 'adviser_scope'
    | 'publication_unavailable'
    | 'host_view_unavailable'
    | 'cancelled';
  sourceCommit?: string;
  failureStage?: string;
  failureCode?: string;
  failureStatus?: number;
  diagnosticId?: string;
};
const knowledgeLog = createLogger('published-host-knowledge');
/** One bounded span and log line per selection decision: fixed outcome/reason
 * labels, identities and a short accepted commit. Never paths, URLs or content. */
function recordSelection(
  identity: SelectionIdentity,
  observation: ReturnType<typeof beginOperationObservation> | undefined,
  result: SelectionOutcome,
  elapsedMs?: number,
) {
  try {
    const span = observation ?? beginOperationObservation('local_codex.knowledge_selection');
    span.annotate({
      'session.id': identity.sessionId,
      ...(identity.commandId ? { 'mitzo.command.id': identity.commandId } : {}),
      'codex.route': identity.route,
      'knowledge.runtime': 'local-mac',
      'knowledge.outcome': result.outcome,
      'knowledge.reason': result.reason,
      ...(result.sourceCommit ? { 'knowledge.source_commit': result.sourceCommit } : {}),
      ...(result.failureStage ? { 'knowledge.failure_stage': result.failureStage } : {}),
      ...(result.failureCode ? { 'knowledge.failure_code': result.failureCode } : {}),
      ...(result.failureStatus !== undefined
        ? { 'knowledge.failure_status': result.failureStatus }
        : {}),
      ...(elapsedMs !== undefined ? { 'phase.elapsed_ms': elapsedMs } : {}),
    });
    span.end(result.outcome === 'unavailable');
    const data = { ...identity, ...result, ...(elapsedMs !== undefined ? { elapsedMs } : {}) };
    if (result.outcome === 'unavailable')
      knowledgeLog.warn('Local Codex knowledge selection completed', data);
    else if (result.outcome === 'skipped')
      knowledgeLog.info('Local Codex knowledge selection skipped', data);
    else knowledgeLog.info('Local Codex knowledge selection completed', data);
  } catch {
    /* Diagnostics cannot replace a selection or its original failure. */
  }
}

/** Records why a Local Codex chat receives no published knowledge. */
export function recordHostKnowledgeSelectionSkipped(
  reason: 'store_not_enrolled' | 'adviser_scope',
  identity: SelectionIdentity,
) {
  recordSelection(identity, undefined, { outcome: 'skipped', reason });
}

/** Observes one per-turn selection without changing its result or failure. */
export async function observeHostKnowledgeSelection<T extends { sourceCommit: string } | undefined>(
  identity: SelectionIdentity,
  signal: AbortSignal,
  work: () => Promise<T>,
): Promise<T> {
  const observation = beginOperationObservation('local_codex.knowledge_selection');
  const start = performance.now();
  const elapsed = () => Math.round(performance.now() - start);
  let selected: T;
  try {
    selected = await observation.run(work);
  } catch (error) {
    let result: SelectionOutcome = { outcome: 'cancelled', reason: 'cancelled' };
    try {
      if (!signal.aborted) {
        const publication = knowledgePublicationFailureDiagnostic(error);
        result =
          publication.stage !== 'unknown'
            ? {
                outcome: 'unavailable',
                reason: 'publication_unavailable',
                failureStage: publication.stage,
                failureCode: publication.code,
                ...(publication.status !== undefined ? { failureStatus: publication.status } : {}),
                ...(publication.diagnosticId ? { diagnosticId: publication.diagnosticId } : {}),
              }
            : {
                outcome: 'unavailable',
                reason: 'host_view_unavailable',
                failureStage: 'host_view',
                failureCode: publishedKnowledgeFailureReason(error),
              };
      }
    } catch {
      result = { outcome: 'unavailable', reason: 'host_view_unavailable' };
    }
    recordSelection(identity, observation, result, elapsed());
    throw error;
  }
  recordSelection(
    identity,
    observation,
    selected
      ? { outcome: 'success', reason: 'selected', sourceCommit: selected.sourceCommit.slice(0, 12) }
      : { outcome: 'skipped', reason: 'store_not_enrolled' },
    elapsed(),
  );
  return selected;
}

export function hostKnowledgeReceipt(session: object, context: string) {
  const view = views.get(session);
  if (!view || view.store !== store || view.context !== context)
    throw Error('Host knowledge acknowledgement differs from its selection');
  return {
    sourceCommit: view.sourceCommit,
    baselineSha256: view.baselineSha256,
    contextSha256: createHash('sha256').update(context).digest('hex'),
  };
}
/** Host-only opt-in; profile documents and tool arguments cannot select a source. */
export function installHostKnowledgeStore(selected: KnowledgeStore) {
  const previous = store;
  store = selected;
  return () => {
    if (store === selected) store = previous;
  };
}
const allowed = (path: string) =>
  (path === 'AGENTS.md' || (path.startsWith('memory/') && path.endsWith('.md'))) &&
  !path.includes('\\') &&
  !path.split('/').some((part) => !part || part.startsWith('.'));

async function read(view: View, path: string) {
  if (!allowed(path) || !view.files[path])
    throw new PublishedKnowledgeProblem(
      'path_not_published',
      'Path is outside published MGMT memory',
    );
  const target = join(view.root, path);
  if ((await realpath(target)) !== target)
    throw new PublishedKnowledgeProblem('path_changed', 'Published knowledge path changed');
  const metadata = await stat(target);
  if (metadata.size > 2 * 1024 * 1024)
    throw new PublishedKnowledgeProblem(
      'document_too_large',
      'Published knowledge document exceeds bounds',
    );
  const bytes = await readFile(target);
  if (
    createHash('sha256').update(bytes).digest('hex') !== view.files[path].sha256 ||
    (metadata.mode & 0o7777) !== Number.parseInt(view.files[path].mode, 8)
  )
    throw new PublishedKnowledgeProblem(
      'integrity_mismatch',
      'Published knowledge integrity mismatch',
    );
  return bytes.toString('utf8');
}

/** One freshness selection per turn. Tool reads reuse its exact immutable view. */
export async function prepareHostKnowledge(
  session: object,
  preserveProfile: boolean,
  signal: AbortSignal,
  additionalContext: () => string = () => '',
) {
  views.delete(session);
  const selected = store;
  if (!selected) return undefined;
  const publication = await selected.reconcile(signal);
  signal.throwIfAborted();
  if (
    store !== selected ||
    !isAbsolute(publication.seed) ||
    (await realpath(publication.seed)) !== publication.seed
  )
    throw new PublishedKnowledgeProblem('enrollment_changed', 'Host knowledge enrollment changed');
  const bytes = await readFile(join(publication.seed, '..', 'baseline.json'));
  if (createHash('sha256').update(bytes).digest('hex') !== publication.baselineSha256)
    throw new PublishedKnowledgeProblem('selection_changed', 'Host knowledge selection changed');
  const baseline = Baseline.parse(JSON.parse(bytes.toString('utf8')));
  if (baseline.startingCommit !== publication.sourceCommit)
    throw new PublishedKnowledgeProblem('source_changed', 'Host knowledge source changed');
  const view: View = {
    store: selected,
    root: publication.seed,
    sourceCommit: publication.sourceCommit,
    baselineSha256: publication.baselineSha256,
    files: baseline.files,
    context: '',
  };
  const guidance = baseline.files['AGENTS.md'] ? await read(view, 'AGENTS.md') : '';
  signal.throwIfAborted();
  if (store !== selected)
    throw new PublishedKnowledgeProblem('enrollment_changed', 'Host knowledge enrollment changed');
  view.context = `${additionalContext()}# Published MGMT knowledge\nAccepted source: ${view.sourceCommit}\nUse ReadKnowledge with action published to list or read accepted memory. This view supersedes older accepted knowledge in the task checkout. Keep task edits separate; a candidate or local commit is not shared acceptance.${preserveProfile ? ' The selected agent profile retains its separately recorded context revision.' : ''}\n${guidance}`;
  views.set(session, view);
  return view;
}

export async function readHostKnowledge(session: object, path?: string, query = '', offset = 0) {
  const view = views.get(session);
  if (!view || view.store !== store) return undefined;
  const identity = { sourceCommit: view.sourceCommit, baselineSha256: view.baselineSha256 };
  if (path) {
    const content = await read(view, path);
    if (view.store !== store || views.get(session) !== view)
      throw new PublishedKnowledgeProblem(
        'enrollment_changed',
        'Host knowledge enrollment changed',
      );
    return { ...identity, path, content };
  }
  const paths = Object.keys(view.files)
    .filter((path) => allowed(path) && path.toLowerCase().includes(query.toLowerCase()))
    .sort();
  return {
    ...identity,
    documents: paths.slice(offset, offset + 100),
    nextOffset: offset + 100 < paths.length ? offset + 100 : null,
  };
}
