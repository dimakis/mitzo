/** Trusted host enrollment. Documents and provider messages cannot select stores or adapter programs. */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, dirname, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import {
  KnowledgePublicationBridge,
  type KnowledgeBundleSelection,
  type PublishedKnowledgeSource,
} from './knowledge-publication-bridge.js';
const execute = promisify(execFile);
const absolute = z.string().refine(isAbsolute);
const commit = z.string().regex(/^[a-f0-9]{40}$/);
const id = z.string().regex(/^[a-zA-Z0-9_-]+$/);
const Adapter = z
  .object({
    kind: z.literal('mgmt-v1'),
    release: absolute,
    releaseCommit: commit,
    python: absolute,
    config: absolute,
  })
  .strict();
type AdapterConfig = z.infer<typeof Adapter>;
const Configuration = z
  .object({
    defaultStore: id,
    stores: z
      .array(
        z
          .object({
            id,
            publisherUrl: z.string(),
            publisherConfig: absolute,
            adapter: Adapter,
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
const MgmtConfig = z.object({
  root: absolute,
  sourceUrl: z.string().min(1),
  mitzoRepo: absolute,
  builderCommit: commit,
});
export interface KnowledgeStore {
  id: string;
  reconcile(signal: AbortSignal): Promise<KnowledgeBundleSelection>;
}
function json(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}
function privateState(path: string, workspaces: string[]): void {
  const physical = realpathSync(path);
  const stat = lstatSync(path);
  if (
    physical !== resolve(path) ||
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0
  )
    throw new Error('Knowledge adapter state must be private and physical');
  for (const workspace of workspaces) {
    if (!existsSync(workspace)) continue;
    const root = realpathSync(workspace);
    if (root === physical || root.startsWith(physical + sep) || physical.startsWith(root + sep))
      throw new Error('Knowledge adapter state overlaps a workspace');
  }
  for (let ancestor = physical; ; ancestor = dirname(ancestor)) {
    if (existsSync(join(ancestor, '.git')))
      throw new Error('Knowledge adapter state is inside a checkout');
    if (dirname(ancestor) === ancestor) break;
  }
}
export function mgmtKnowledgeAdapter(config: AdapterConfig, sourceUrl: string) {
  const adapter = MgmtConfig.parse(json(config.config));
  if (adapter.sourceUrl !== sourceUrl)
    throw new Error('Knowledge adapter source differs from publisher');
  const workspaces = [
    config.release,
    adapter.mitzoRepo,
    ...(isAbsolute(sourceUrl) ? [sourceUrl] : []),
  ];
  privateState(adapter.root, workspaces);
  const publicationsPath = join(adapter.root, 'publications');
  const verifyPublications = () => {
    const stat = lstatSync(publicationsPath, { throwIfNoEntry: false });
    if (
      stat &&
      (!stat.isDirectory() || realpathSync(publicationsPath) !== resolve(publicationsPath))
    )
      throw new Error('Knowledge bundle escaped adapter state');
  };
  return async (
    selection: { revision: string },
    signal: AbortSignal,
  ): Promise<KnowledgeBundleSelection> => {
    signal.throwIfAborted();
    privateState(adapter.root, workspaces);
    verifyPublications();
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !key.startsWith('GIT_') && !['PYTHONPATH', 'PYTHONHOME'].includes(key),
      ),
    );
    const git = async (...args: string[]) =>
      (
        await execute('git', ['-c', 'core.hooksPath=/dev/null', '-C', config.release, ...args], {
          env,
          signal,
          timeout: 30000,
          maxBuffer: 1024 * 1024,
        })
      ).stdout.trim();
    if (
      (await git('rev-parse', 'HEAD')) !== config.releaseCommit ||
      (await git('status', '--porcelain')) ||
      (await git('branch', '--show-current'))
    )
      throw new Error('Knowledge adapter requires its clean pinned detached release');
    let output: { status?: string; publishedCommit?: string; receipt?: Record<string, unknown> };
    try {
      const result = await execute(
        config.python,
        [
          '-m',
          'mgmt_lib.knowledge_publication',
          '--config',
          config.config,
          '--once',
          '--published-revision',
          selection.revision,
        ],
        { cwd: config.release, env, signal, timeout: 1100000, maxBuffer: 1024 * 1024 },
      );
      output = JSON.parse(result.stdout);
    } catch {
      signal.throwIfAborted();
      throw new Error('Knowledge bundle conversion failed; inspect adapter status');
    }
    if (
      output.status !== 'current' ||
      output.publishedCommit !== selection.revision ||
      output.receipt?.sourceCommit !== selection.revision ||
      output.receipt?.builderCommit !== adapter.builderCommit
    )
      throw new Error('Knowledge adapter returned another publication');
    privateState(adapter.root, workspaces);
    verifyPublications();
    const publications = realpathSync(publicationsPath);
    const directory = realpathSync(join(publications, 'current'));
    if (!directory.startsWith(publications + sep))
      throw new Error('Knowledge bundle escaped adapter state');
    for (const name of ['baseline.json', 'publication.json']) {
      if (!lstatSync(join(directory, name)).isFile())
        throw new Error('Unsafe knowledge bundle metadata');
    }
    const bytes = readFileSync(join(directory, 'baseline.json'));
    const baseline = JSON.parse(bytes.toString());
    const receipt = json(join(directory, 'publication.json')) as Record<string, unknown>;
    if (
      createHash('sha256').update(bytes).digest('hex') !== output.receipt.baselineSha256 ||
      receipt.baselineSha256 !== output.receipt.baselineSha256 ||
      receipt.sourceCommit !== selection.revision ||
      baseline.startingCommit !== selection.revision ||
      receipt.builderCommit !== adapter.builderCommit ||
      receipt.payloadSha256 !== baseline.payloadSha256
    )
      throw new Error('Knowledge bundle provenance changed');
    return {
      seed: join(directory, 'mgmt'),
      sourceCommit: selection.revision,
      baselineSha256: createHash('sha256').update(bytes).digest('hex'),
    };
  };
}
export function knowledgeStoreFromEnvironment(env: NodeJS.ProcessEnv): KnowledgeStore | undefined {
  if (!env.MITZO_KNOWLEDGE_STORE_CONFIG) return undefined;
  const config = Configuration.parse(json(absolute.parse(env.MITZO_KNOWLEDGE_STORE_CONFIG)));
  if (new Set(config.stores.map((store) => store.id)).size !== config.stores.length)
    throw new Error('Duplicate knowledge store');
  const selected = config.stores.find((store) => store.id === config.defaultStore);
  if (!selected) throw new Error('Default knowledge store unavailable');
  const publisher = json(selected.publisherConfig) as {
    root: string;
    readTokenEnv: string;
    sources: PublishedKnowledgeSource[];
  };
  const source = publisher.sources.find((source) => source.id === selected.id);
  if (!source) throw new Error('Knowledge publisher source unavailable');
  const token = env[publisher.readTokenEnv];
  if (!token) throw new Error('Knowledge publisher read token unavailable');
  const bridge = new KnowledgePublicationBridge(
    {
      publisherUrl: selected.publisherUrl,
      publisherRoot: publisher.root,
      source,
      token,
    },
    mgmtKnowledgeAdapter(selected.adapter, source.url),
  );
  return { id: selected.id, reconcile: (signal) => bridge.reconcile(signal) };
}
