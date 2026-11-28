/** Host-side source verification and format adaptation. Repository agents never configure it. */
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { SessionRuntimeError } from './session-runtime-error.js';
import { runtimeFailureDiagnostics } from './runtime-failure-diagnostics.js';
import { isDeepStrictEqual } from 'node:util';
import {
  parsePortableSpokePolicy,
  parsePortableSpokePolicyText,
  portableSpokePaths,
  portableSpokePathSelected,
  portableSpokePathPermitted,
} from '../scripts/lib/portable-spoke-policy.mjs';

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.string().regex(/^[a-f0-9]{40}$/);
const safePath = (path: string) =>
  path.length > 0 &&
  !path.includes('\\') &&
  !path.includes('\0') &&
  !isAbsolute(path) &&
  !path.split('/').some((part) => !part || part === '.' || part === '..');
const policyPath = z
  .string()
  .refine((path) => safePath(path.endsWith('/') ? path.slice(0, -1) : path));
const policyFile = z
  .string()
  .max(200)
  .refine((path) => safePath(path) && path.endsWith('.json'));
const PolicyEnrollment = z
  .object({
    path: policyFile,
    requiredPrivateRoots: z.array(z.string()).max(512),
  })
  .strict();
const PolicyReceipt = z
  .object({ path: policyFile, sha256: sha, content: z.string().max(128 * 1024) })
  .strict();
const SourcePolicy = z.object({
  paths: z.array(policyPath).min(1),
  optionalPaths: z.array(policyPath).optional(),
  excludePaths: z.array(policyPath).optional(),
  excludePathSegments: z
    .array(z.string().refine((part) => !part.includes('/') && safePath(part)))
    .optional(),
  excludeHiddenPaths: z.boolean().optional(),
});
const Selection = z.object({ revision, directory: z.string(), manifestSha256: sha }).strict();
export type PublishedKnowledgeSelection = z.infer<typeof Selection>;
export interface KnowledgeBundleSelection {
  seed: string;
  sourceCommit: string;
  /** Exact baseline bytes whose Markdown entries passed publisher policy verification. */
  baselineSha256: string;
}
export interface PublishedKnowledgeSource {
  id: string;
  url: string;
  ref: string;
  githubRepository?: string;
  paths: string[];
  optionalPaths?: string[];
  excludePaths?: string[];
  excludePathSegments?: string[];
  excludeHiddenPaths?: boolean;
  spokePolicy?: z.infer<typeof PolicyEnrollment>;
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
    ...SourcePolicy.shape,
    spokePolicy: PolicyReceipt.optional(),
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

export type KnowledgePublicationFailureStage =
  | 'transport'
  | 'http_status'
  | 'response'
  | 'selection_schema'
  | 'verification'
  | 'adapter'
  | 'bundle_verification';

/** A bounded admission failure; never retain transport bodies, URLs, or credentials. */
export class KnowledgePublicationUnavailableError extends Error {
  readonly stage: 'transport' | 'http_status' | 'response';
  readonly status?: number;
  constructor(
    failure: { stage: 'transport' | 'http_status' | 'response'; status?: number } = {
      stage: 'transport',
    },
  ) {
    super('Fresh knowledge publication unavailable');
    this.name = 'KnowledgePublicationUnavailableError';
    this.stage = failure.stage;
    if (failure.status !== undefined) this.status = failure.status;
  }
}

// Classification is attached beside the original error so admission keeps its
// exact identity and message. Codes are fixed host labels, never upstream text.
const failureStages = new WeakMap<Error, KnowledgePublicationFailureStage>();
const failureCodes = new WeakMap<Error, string>();
const failure = (code: string, message: string) => {
  const error = new Error(message);
  failureCodes.set(error, code);
  return error;
};
async function atStage<T>(
  stage: KnowledgePublicationFailureStage,
  signal: AbortSignal,
  work: () => T | Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!signal.aborted && error instanceof Error && !failureStages.has(error))
      failureStages.set(error, stage);
    throw error;
  }
}

/** Sanitized structured fields for logs and spans: stage, stable code, HTTP status
 * and allowlisted cause categories. Never messages, URLs, paths or credentials. */
export function knowledgePublicationFailureDiagnostic(error: unknown): {
  stage: KnowledgePublicationFailureStage | 'unknown';
  code: string;
  status?: number;
  runtimeFailureCode?: string;
  diagnosticId?: string;
  causeType: string;
  causeCode?: string;
} {
  const unavailable = error instanceof KnowledgePublicationUnavailableError ? error : undefined;
  const stage =
    unavailable?.stage ?? (error instanceof Error ? failureStages.get(error) : undefined);
  const runtime = error instanceof SessionRuntimeError ? error : undefined;
  const code =
    (error instanceof Error ? failureCodes.get(error) : undefined) ??
    (unavailable
      ? { transport: 'fetch_failed', http_status: 'http_error', response: 'body_read_failed' }[
          unavailable.stage
        ]
      : runtime && stage === 'adapter'
        ? 'adapter_failed'
        : error instanceof z.ZodError
          ? 'schema_mismatch'
          : error instanceof SyntaxError
            ? 'invalid_json'
            : 'unexpected_failure');
  const { causeType, causeCode } = runtimeFailureDiagnostics(error);
  return {
    stage: stage ?? 'unknown',
    code,
    ...(unavailable?.status !== undefined ? { status: unavailable.status } : {}),
    ...(runtime ? runtime.telemetry() : {}),
    causeType,
    ...(causeCode ? { causeCode } : {}),
  };
}

export class KnowledgePublicationBridge {
  private readonly config: KnowledgePublicationBridgeConfig;
  private readonly url: string;
  constructor(
    config: KnowledgePublicationBridgeConfig,
    private readonly adapt: (
      selection: PublishedKnowledgeSelection,
      signal: AbortSignal,
    ) => Promise<Omit<KnowledgeBundleSelection, 'baselineSha256'>>,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    // Validate without reconstructing source: property order belongs to publisher identity.
    SourcePolicy.parse(config.source);
    if (config.source.spokePolicy !== undefined) {
      const enrollment = PolicyEnrollment.parse(config.source.spokePolicy);
      parsePortableSpokePolicy(
        { version: 1, portableRoots: [], privateRoots: enrollment.requiredPrivateRoots },
        enrollment.requiredPrivateRoots,
      );
    }
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

  reconcile(signal: AbortSignal): Promise<KnowledgeBundleSelection> {
    return this.select(signal, true);
  }

  /** Conversion warmup observes only the publisher's existing snapshot. A command
   * still performs its own freshness barrier and complete verification. */
  prewarm(signal: AbortSignal): Promise<KnowledgeBundleSelection> {
    return this.select(signal, false);
  }

  private async select(signal: AbortSignal, fresh: boolean): Promise<KnowledgeBundleSelection> {
    signal.throwIfAborted();
    let response: Response;
    try {
      response = await this.fetcher(
        this.url + '/api/publications/' + this.config.source.id + (fresh ? '/reconcile' : ''),
        {
          method: fresh ? 'POST' : 'GET',
          redirect: 'error',
          headers: { authorization: 'Bearer ' + this.config.token },
          signal: AbortSignal.any([signal, AbortSignal.timeout(180000)]),
        },
      );
    } catch {
      signal.throwIfAborted();
      throw new KnowledgePublicationUnavailableError({ stage: 'transport' });
    }
    if (!response.ok)
      throw new KnowledgePublicationUnavailableError({
        stage: 'http_status',
        status: response.status,
      });
    const raw = await atStage('response', signal, async () => {
      const reader = response.body?.getReader();
      if (!reader) throw failure('body_missing', 'Publication response missing');
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          signal.throwIfAborted();
          const { done, value } = await reader.read().catch(() => {
            signal.throwIfAborted();
            throw new KnowledgePublicationUnavailableError({ stage: 'response' });
          });
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 1024 * 1024)
            throw failure('body_too_large', 'Publication response too large');
          chunks.push(value);
        }
      } finally {
        // An errored stream also rejects cancel(); cleanup must not replace the
        // bounded transport diagnostic or the caller's original abort reason.
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      return Buffer.concat(chunks).toString('utf8');
    });
    const selection = await atStage('selection_schema', signal, () =>
      Selection.parse(JSON.parse(raw).current),
    );
    const manifest = await atStage('verification', signal, () => this.verify(selection, signal));
    signal.throwIfAborted();
    let bundle: Omit<KnowledgeBundleSelection, 'baselineSha256'>;
    try {
      bundle = await this.adapt(selection, signal);
    } catch (error) {
      signal.throwIfAborted();
      // Retain the cause privately; wrappers can preserve a reviewed diagnosis
      // without copying adapter output or granting permission to resend.
      const unavailable = new SessionRuntimeError('knowledge_unavailable', { cause: error });
      failureStages.set(unavailable, 'adapter');
      throw unavailable;
    }
    return atStage('bundle_verification', signal, async () => {
      if (bundle.sourceCommit !== selection.revision)
        throw failure('revision_mismatch', 'Bundle revision differs from publication');
      if (!isAbsolute(bundle.seed))
        throw failure('seed_not_absolute', 'Bundle seed must be absolute');
      const baselineBytes = await readFile(join(bundle.seed, '..', 'baseline.json'));
      const baseline = z
        .object({
          files: z.record(z.string(), z.object({ sha256: sha })),
          spokePolicy: PolicyReceipt.optional(),
        })
        .parse(JSON.parse(baselineBytes.toString('utf8')));
      if (!isDeepStrictEqual(baseline.spokePolicy, manifest.spokePolicy))
        throw failure('policy_mismatch', 'Bundle portable policy differs from published source');
      const published = new Map(manifest.files.map((file) => [file.path, file.sha256]));
      const markdownMismatch = () =>
        failure('markdown_mismatch', 'Bundle Markdown differs from published source policy');
      for (const [path, file] of Object.entries(baseline.files)) {
        if (path.endsWith('.md') && (!safePath(path) || published.get(path) !== file.sha256))
          throw markdownMismatch();
      }
      for (const [path, sha256] of published) {
        if (baseline.files[path]?.sha256 !== sha256) throw markdownMismatch();
      }
      signal.throwIfAborted();
      return { ...bundle, baselineSha256: hash(baselineBytes) };
    });
  }

  private async verify(
    selection: PublishedKnowledgeSelection,
    signal: AbortSignal,
  ): Promise<z.infer<typeof Manifest>> {
    const root = await realpath(this.config.publisherRoot);
    const directory = resolve(selection.directory);
    const sourceRoot = join(root, this.config.source.id);
    if (!directory.startsWith(sourceRoot + sep) || (await realpath(directory)) !== directory)
      throw failure('escaped_source', 'Publication escaped the configured source');
    const files = new Set<string>();
    let total = 0;
    const walk = async (path: string): Promise<void> => {
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) throw failure('symlink', 'Symlink in publication');
      if (stat.isDirectory()) {
        for (const child of await readdir(path)) await walk(join(path, child));
      } else if (stat.isFile() && stat.nlink === 1) {
        total += stat.size;
        files.add(relative(directory, path).split(sep).join('/'));
        if (total > 64 * 1024 * 1024 || files.size > 10002)
          throw failure('limits_exceeded', 'Publication exceeds limits');
      } else throw failure('unsafe_file', 'Unsafe publication file');
    };
    await walk(directory);
    const raw = await readFile(join(directory, 'manifest.json'));
    if (hash(raw) !== selection.manifestSha256)
      throw failure('manifest_changed', 'Publication manifest changed');
    const manifest = Manifest.parse(JSON.parse(raw.toString()));
    const source = this.config.source;
    let spokes: ReturnType<typeof parsePortableSpokePolicy> | undefined;
    if (source.spokePolicy) {
      if (
        !manifest.spokePolicy ||
        manifest.spokePolicy.path !== source.spokePolicy.path ||
        hash(manifest.spokePolicy.content) !== manifest.spokePolicy.sha256
      )
        throw failure(
          'policy_mismatch',
          'Publication portable policy differs from enrolled source',
        );
      spokes = parsePortableSpokePolicyText(
        manifest.spokePolicy.content,
        source.spokePolicy.requiredPrivateRoots,
      );
    } else if (manifest.spokePolicy) {
      throw failure('policy_not_enrolled', 'Publication portable policy is not enrolled');
    }
    const optionalPaths = spokes
      ? [...(source.optionalPaths ?? []), ...portableSpokePaths(spokes)]
      : source.optionalPaths;
    if (
      manifest.revision !== selection.revision ||
      manifest.source !== source.id ||
      manifest.acceptedRef !== source.ref ||
      manifest.sourceIdentity !== hash(JSON.stringify(source)) ||
      JSON.stringify(manifest.paths) !== JSON.stringify(source.paths) ||
      JSON.stringify(manifest.optionalPaths) !== JSON.stringify(optionalPaths) ||
      JSON.stringify(manifest.excludePaths) !== JSON.stringify(source.excludePaths) ||
      JSON.stringify(manifest.excludePathSegments) !== JSON.stringify(source.excludePathSegments) ||
      manifest.excludeHiddenPaths !== source.excludeHiddenPaths
    )
      throw failure('provenance_mismatch', 'Publication provenance differs from configured source');
    const selected = (path: string, policy: string) =>
      policy.endsWith('/') ? path.startsWith(policy) : path === policy;
    if (
      !manifest.files.length ||
      manifest.files.some(
        (file) =>
          !file.path.endsWith('.md') ||
          (![...source.paths, ...(source.optionalPaths ?? [])].some((policy) =>
            selected(file.path, policy),
          ) &&
            !(spokes && portableSpokePathSelected(spokes, file.path))) ||
          (spokes && !portableSpokePathPermitted(spokes, file.path)) ||
          source.excludePaths?.some((policy) => selected(file.path, policy)) ||
          file.path.split('/').some((part) => source.excludePathSegments?.includes(part)) ||
          (source.excludeHiddenPaths && file.path.split('/').some((part) => part.startsWith('.'))),
      ) ||
      source.paths.some((policy) => !manifest.files.some((file) => selected(file.path, policy)))
    )
      throw failure('paths_mismatch', 'Publication files differ from configured source paths');
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
      throw failure('file_set_changed', 'Publication file set changed');
    // Independent source reads share the already-verified manifest and file-set
    // budget. Bound buffers and settle the entire wave before admission exits,
    // including failure/cancellation; report the first error in manifest order.
    for (let offset = 0; offset < manifest.files.length; offset += 8) {
      signal.throwIfAborted();
      const reads = await Promise.allSettled(
        manifest.files.slice(offset, offset + 8).map(async (file) => {
          const raw = await readFile(join(directory, 'source', file.path));
          if (raw.length !== file.bytes || hash(raw) !== file.sha256)
            throw failure('content_changed', 'Publication content changed');
        }),
      );
      for (const read of reads) if (read.status === 'rejected') throw read.reason;
      signal.throwIfAborted();
    }
    if (hash(await readFile(join(directory, 'context.json'))) !== manifest.contextSha256)
      throw failure('context_changed', 'Publication context changed');
    return manifest;
  }
}
