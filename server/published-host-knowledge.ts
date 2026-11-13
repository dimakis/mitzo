import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import type { KnowledgeStore } from './knowledge-store-config.js';

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
