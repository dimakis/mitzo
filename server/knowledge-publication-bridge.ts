/** Host-side source verification and format adaptation. Repository agents never configure it. */
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.string().regex(/^[a-f0-9]{40}$/);
const safePath = (path: string) =>
  path.length > 0 &&
  !path.includes('\\') &&
  !path.includes('\0') &&
  !isAbsolute(path) &&
  !path.split('/').some((part) => !part || part === '.' || part === '..');
const Selection = z.object({ revision, directory: z.string(), manifestSha256: sha }).strict();
export type PublishedKnowledgeSelection = z.infer<typeof Selection>;
export interface KnowledgeBundleSelection {
  seed: string;
  sourceCommit: string;
}
export interface PublishedKnowledgeSource {
  id: string;
  url: string;
  ref: string;
  githubRepository?: string;
  paths: string[];
}
export interface KnowledgePublicationBridgeConfig {
  publisherUrl: string;
  publisherRoot: string;
  /** Loaded from the same host configuration as ContexGin, preserving source identity encoding. */
  source: PublishedKnowledgeSource;
  token: string;
}
const hash = (raw: string | Buffer) => createHash('sha256').update(raw).digest('hex');
const Manifest = z
  .object({
    schema: z.literal('contexgin-portable-v1'),
    source: z.string(),
    acceptedRef: z.string(),
    sourceIdentity: sha,
    revision,
    paths: z.array(z.string()),
    files: z
      .array(
        z
          .object({
            path: z.string().refine(safePath),
            sha256: sha,
            bytes: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .max(10000),
    contextSha256: sha,
  })
  .strict();

export class KnowledgePublicationBridge {
  private readonly config: KnowledgePublicationBridgeConfig;
  private readonly url: string;
  constructor(
    config: KnowledgePublicationBridgeConfig,
    private readonly adapt: (
      selection: PublishedKnowledgeSelection,
      signal: AbortSignal,
    ) => Promise<KnowledgeBundleSelection>,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.config = structuredClone(config);
    const url = new URL(config.publisherUrl);
    if (
      url.protocol !== 'http:' ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/' ||
      !isAbsolute(config.publisherRoot) ||
      !config.token ||
      !/^[a-zA-Z0-9_-]+$/.test(config.source.id)
    )
      throw new Error('Invalid local knowledge publisher configuration');
    this.url = url.origin;
  }

  async reconcile(signal: AbortSignal): Promise<KnowledgeBundleSelection> {
    signal.throwIfAborted();
    const response = await this.fetcher(
      this.url + '/api/publications/' + this.config.source.id + '/reconcile',
      {
        method: 'POST',
        redirect: 'error',
        headers: { authorization: 'Bearer ' + this.config.token },
        signal: AbortSignal.any([signal, AbortSignal.timeout(180000)]),
      },
    );
    if (!response.ok) throw new Error('Fresh knowledge publication unavailable');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Publication response missing');
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 1024 * 1024) throw new Error('Publication response too large');
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    const selection = Selection.parse(JSON.parse(raw).current);
    const manifest = await this.verify(selection);
    signal.throwIfAborted();
    const bundle = await this.adapt(selection, signal);
    if (bundle.sourceCommit !== selection.revision)
      throw new Error('Bundle revision differs from publication');
    if (!isAbsolute(bundle.seed)) throw new Error('Bundle seed must be absolute');
    const baseline = z
      .object({ files: z.record(z.string(), z.object({ sha256: sha })) })
      .parse(JSON.parse(await readFile(join(bundle.seed, '..', 'baseline.json'), 'utf8')));
    const published = new Map(manifest.files.map((file) => [file.path, file.sha256]));
    for (const [path, file] of Object.entries(baseline.files)) {
      if (path.endsWith('.md') && (!safePath(path) || published.get(path) !== file.sha256))
        throw new Error('Bundle Markdown differs from published source policy');
    }
    signal.throwIfAborted();
    return bundle;
  }

  private async verify(selection: PublishedKnowledgeSelection): Promise<z.infer<typeof Manifest>> {
    const root = await realpath(this.config.publisherRoot);
    const directory = resolve(selection.directory);
    const sourceRoot = join(root, this.config.source.id);
    if (!directory.startsWith(sourceRoot + sep) || (await realpath(directory)) !== directory)
      throw new Error('Publication escaped the configured source');
    const files = new Set<string>();
    let total = 0;
    const walk = async (path: string): Promise<void> => {
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) throw new Error('Symlink in publication');
      if (stat.isDirectory()) {
        for (const child of await readdir(path)) await walk(join(path, child));
      } else if (stat.isFile() && stat.nlink === 1) {
        total += stat.size;
        files.add(relative(directory, path).split(sep).join('/'));
        if (total > 64 * 1024 * 1024 || files.size > 10002)
          throw new Error('Publication exceeds limits');
      } else throw new Error('Unsafe publication file');
    };
    await walk(directory);
    const raw = await readFile(join(directory, 'manifest.json'));
    if (hash(raw) !== selection.manifestSha256) throw new Error('Publication manifest changed');
    const manifest = Manifest.parse(JSON.parse(raw.toString()));
    const source = this.config.source;
    if (
      manifest.revision !== selection.revision ||
      manifest.source !== source.id ||
      manifest.acceptedRef !== source.ref ||
      manifest.sourceIdentity !== hash(JSON.stringify(source)) ||
      JSON.stringify(manifest.paths) !== JSON.stringify(source.paths)
    )
      throw new Error('Publication provenance differs from configured source');
    const selected = (path: string, policy: string) =>
      policy.endsWith('/') ? path.startsWith(policy) : path === policy;
    if (
      !manifest.files.length ||
      manifest.files.some(
        (file) =>
          !file.path.endsWith('.md') || !source.paths.some((policy) => selected(file.path, policy)),
      ) ||
      source.paths.some((policy) => !manifest.files.some((file) => selected(file.path, policy)))
    )
      throw new Error('Publication files differ from configured source paths');
    const expected = new Set([
      'manifest.json',
      'context.json',
      ...manifest.files.map((file) => 'source/' + file.path),
    ]);
    if (
      expected.size !== manifest.files.length + 2 ||
      files.size !== expected.size ||
      [...files].some((file) => !expected.has(file))
    )
      throw new Error('Publication file set changed');
    for (const file of manifest.files) {
      const raw = await readFile(join(directory, 'source', file.path));
      if (raw.length !== file.bytes || hash(raw) !== file.sha256)
        throw new Error('Publication content changed');
    }
    if (hash(await readFile(join(directory, 'context.json'))) !== manifest.contextSha256)
      throw new Error('Publication context changed');
    return manifest;
  }
}
