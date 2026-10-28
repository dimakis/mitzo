import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, posix } from 'node:path';
import { promisify } from 'node:util';
import type { GithubPublicationReviewInput } from './connections/capabilities/github-publish-pr.js';
import { GithubPublicationReviewError } from './github-publication-review-failure.js';
import { isGitBranchName } from './git-branch.js';

const exec = promisify(execFile);
export const PUBLICATION_REVIEW_MAX_EVIDENCE_BYTES = 800000;
const MAX_AUTOMATIC_CONTEXT_BYTES = 48000;
const MAX_AUTOMATIC_FILE_BYTES = 12000;
const MAX_DISCOVERY_PATHS = 128;
const oid = /^[a-f0-9]{40,64}$/;
export function publicationReviewUnavailable(reason: string): never {
  throw new GithubPublicationReviewError('PUBLICATION_REVIEW_UNAVAILABLE', { reason });
}
function digest(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
/** All arguments are host-owned Git object operations. No checkout, filters,
 * lazy fetch, ambient Git configuration, network or credentials are available. */
async function git(input: GithubPublicationReviewInput, args: string[], allowNoMatch = false) {
  input.signal.throwIfAborted();
  try {
    const result = await exec(
      '/usr/bin/git',
      [
        '-C',
        input.directory,
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'core.fsmonitor=false',
        ...args,
      ],
      {
        signal: input.signal,
        maxBuffer: PUBLICATION_REVIEW_MAX_EVIDENCE_BYTES + 1,
        encoding: 'buffer',
        env: {
          PATH: '/usr/bin:/bin',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_NO_REPLACE_OBJECTS: '1',
          GIT_NO_LAZY_FETCH: '1',
          GIT_TERMINAL_PROMPT: '0',
          GIT_PROTOCOL_FROM_USER: '0',
          GIT_ALTERNATE_OBJECT_DIRECTORIES: '',
        },
      },
    );
    if (result.stdout.length > PUBLICATION_REVIEW_MAX_EVIDENCE_BYTES)
      publicationReviewUnavailable('evidence_limit');
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(result.stdout);
    } catch {
      return publicationReviewUnavailable('non_text_evidence');
    }
  } catch (error) {
    if (error instanceof GithubPublicationReviewError) throw error;
    input.signal.throwIfAborted();
    if (allowNoMatch && (error as { code?: unknown }).code === 1) return '';
    if ((error as NodeJS.ErrnoException).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
      publicationReviewUnavailable('evidence_limit');
    publicationReviewUnavailable('committed_evidence_unavailable');
  }
}
function ancestors(path: string, all: Set<string>) {
  const result: string[] = [];
  let parent = posix.dirname(path);
  while (true) {
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      const candidate = parent === '.' ? name : `${parent}/${name}`;
      if (all.has(candidate)) result.push(candidate);
    }
    if (parent === '.') return result;
    parent = posix.dirname(parent);
  }
}
function linkedPaths(path: string, content: string, all: Set<string>) {
  const links = [
    ...[...content.matchAll(/\[[^\]\n]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/g)].map((match) => match[1]),
    ...[...content.matchAll(/`([^`\n]+\.md)`/g)].map((match) => match[1]),
  ];
  const result = new Set<string>();
  for (const link of links) {
    if (/^[a-z][a-z0-9+.-]*:|^#|^\/\//i.test(link)) continue;
    let decoded: string;
    try {
      decoded = decodeURIComponent(link.split(/[?#]/, 1)[0]);
    } catch {
      continue;
    }
    const candidate = posix.normalize(
      decoded.startsWith('/') ? decoded.slice(1) : posix.join(posix.dirname(path), decoded),
    );
    if (all.has(candidate)) result.add(candidate);
  }
  return result;
}
function importTargets(path: string, content: string, all: Set<string>) {
  const targets = new Set<string>();
  for (const match of content.matchAll(
    /(?:\bfrom\s*|\bimport\s*\(|\brequire\s*\(|\bimport\s*)['"]([^'"\n]+)['"]/g,
  )) {
    if (!match[1].startsWith('.')) continue;
    const target = posix.normalize(posix.join(posix.dirname(path), match[1]));
    const stem = target.replace(/\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts)$/, '');
    for (const candidate of [
      target,
      ...[
        '.ts',
        '.tsx',
        '.js',
        '.mts',
        '.mjs',
        '.cts',
        '.cjs',
        '/index.ts',
        '/index.tsx',
        '/index.js',
      ].map((extension) => stem + extension),
    ])
      if (all.has(candidate)) targets.add(candidate);
  }
  return targets;
}
export interface PublicationContextRead {
  path: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  remainingBefore: number;
  remainingAfter: number;
  complete: boolean;
}
export type PublicationContextRequest =
  | { kind: 'read'; path: string; startLine?: number; endLine?: number }
  | { kind: 'search'; query: string; pathPrefix?: string };
export interface PublicationContextSearch {
  query: string;
  pathPrefix?: string;
  matchedPaths: string[];
}
export async function capturePublicationReviewEvidence(rawInput: GithubPublicationReviewInput) {
  const assertBatchCurrent = async () => {
    rawInput.signal.throwIfAborted();
    await rawInput.assertRuntimeCurrent?.();
    rawInput.signal.throwIfAborted();
  };
  await assertBatchCurrent();
  if (
    !isAbsolute(rawInput.directory) ||
    !oid.test(rawInput.sourceOid) ||
    !isGitBranchName(rawInput.baseBranch) ||
    !isGitBranchName(rawInput.sourceBranch)
  )
    publicationReviewUnavailable('committed_identity_unavailable');
  const directory = await lstat(rawInput.directory);
  const metadata = await lstat(join(rawInput.directory, '.git'));
  const canonicalDirectory = await realpath(rawInput.directory);
  if (
    !directory.isDirectory() ||
    !metadata.isDirectory() ||
    (await realpath(join(rawInput.directory, '.git'))) !== join(canonicalDirectory, '.git')
  )
    publicationReviewUnavailable('committed_identity_unavailable');
  const input = { ...rawInput, directory: canonicalDirectory };
  const source = (
    await git(input, ['rev-parse', '--verify', `refs/heads/${input.sourceBranch}^{commit}`])
  ).trim();
  const base = (
    await git(input, ['rev-parse', '--verify', `refs/remotes/origin/${input.baseBranch}^{commit}`])
  ).trim();
  if (source !== input.sourceOid || !oid.test(base))
    publicationReviewUnavailable('committed_identity_unavailable');
  const changedPaths = (await git(input, ['diff', '--name-only', '-z', base, source, '--']))
    .split('\0')
    .filter(Boolean);
  if (!changedPaths.length || changedPaths.length > 64)
    publicationReviewUnavailable('changed_file_scope');
  const all = new Set(
    (await git(input, ['ls-tree', '-r', '--name-only', '-z', source])).split('\0').filter(Boolean),
  );
  const files = new Set(changedPaths);
  for (const path of changedPaths) for (const policy of ancestors(path, all)) files.add(policy);
  if (all.has('skills/land-pr/SKILL.md')) files.add('skills/land-pr/SKILL.md');
  const diff = await git(input, [
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--binary',
    base,
    source,
    '--',
  ]);
  const contents: Array<{ path: string; revision: 'source' | 'base'; content: string }> = [];
  let bytes = Buffer.byteLength(diff, 'utf8');
  const read = async (path: string, revision = source) =>
    git(input, ['show', '--no-ext-diff', '--no-textconv', `${revision}:${path}`]);
  const add = async (path: string) => {
    const revision = all.has(path) ? ('source' as const) : ('base' as const);
    const content = await read(path, revision === 'source' ? source : base);
    bytes += Buffer.byteLength(content, 'utf8');
    if (bytes > PUBLICATION_REVIEW_MAX_EVIDENCE_BYTES)
      publicationReviewUnavailable('evidence_limit');
    contents.push({ path, revision, content });
    return content;
  };
  for (const path of [...files].sort()) await add(path);
  const candidates = new Map<string, string>();
  const candidate = (path: string, reason: string) => {
    if (!files.has(path) && all.has(path) && !candidates.has(path)) candidates.set(path, reason);
  };
  for (const file of contents) {
    for (const path of importTargets(file.path, file.content, all)) candidate(path, 'dependency');
    if (/(?:^|\/)(?:AGENTS|CLAUDE)\.md$|(?:^|\/)SKILL\.md$/.test(file.path))
      for (const path of linkedPaths(file.path, file.content, all))
        candidate(path, 'linked_requirement');
  }
  for (const path of ['package.json', 'tsconfig.json']) candidate(path, 'build_contract');
  const references = async (paths: string[]) => {
    const queries = [
      ...new Set(
        paths.flatMap((path) => {
          const stem = posix.basename(path).replace(/\.[^.]+$/, '');
          return stem.length >= 3 && /\.(?:[cm]?[jt]sx?|py|rs|go)$/.test(path)
            ? [`/${stem}`, `${stem}.js`, `${stem}.ts`]
            : [];
        }),
      ),
    ];
    if (!queries.length) return [];
    const result = await git(
      input,
      ['grep', '-l', '-z', '-I', '-F', ...queries.flatMap((query) => ['-e', query]), source, '--'],
      true,
    );
    return result
      .split('\0')
      .filter(Boolean)
      .map((entry) => entry.slice(source.length + 1))
      .filter((path) => all.has(path));
  };
  const direct = await references(changedPaths);
  for (const path of direct) candidate(path, 'affected_caller_or_test');
  for (const path of await references(
    direct.filter((path) => !files.has(path)).slice(0, MAX_DISCOVERY_PATHS),
  ))
    candidate(path, 'caller_test_or_integration');
  const contextCandidates: Array<{
    path: string;
    reason: string;
    bytes: number;
    included: boolean;
  }> = [];
  let automaticBytes = 0;
  // Requirements precede implementation context. Full contents are never
  // silently truncated: larger candidates remain explicitly available by range.
  const ordered = [...candidates].sort(
    ([a, reasonA], [b, reasonB]) =>
      (reasonA === 'linked_requirement' ? -1 : 0) - (reasonB === 'linked_requirement' ? -1 : 0) ||
      a.localeCompare(b),
  );
  for (const [path, reason] of ordered.slice(0, MAX_DISCOVERY_PATHS)) {
    const size = Number((await git(input, ['cat-file', '-s', `${source}:${path}`])).trim());
    const included =
      Number.isSafeInteger(size) &&
      size <= MAX_AUTOMATIC_FILE_BYTES &&
      automaticBytes + size <= MAX_AUTOMATIC_CONTEXT_BYTES;
    contextCandidates.push({ path, reason, bytes: size, included });
    if (included) {
      const content = await add(path);
      files.add(path);
      for (const policy of ancestors(path, all))
        if (!files.has(policy)) {
          const policyText = await add(policy);
          files.add(policy);
          for (const linked of linkedPaths(policy, policyText, all))
            candidate(linked, 'linked_requirement');
        }
      automaticBytes += size;
      if (reason === 'linked_requirement')
        for (const linked of linkedPaths(path, content, all))
          candidate(linked, 'linked_requirement');
    }
  }
  const packet = {
    repository: input.repository,
    baseBranch: input.baseBranch,
    baseOid: base,
    sourceBranch: input.sourceBranch,
    sourceOid: source,
    changedPaths,
    diff,
    contents,
    contextDiscovery: {
      candidates: contextCandidates,
      additionalCandidateCount: Math.max(0, candidates.size - contextCandidates.length),
      note: 'Full unchanged files and literal searches remain available through structured context requests. Included files are complete; excluded files have not been read.',
    },
  };
  const text = JSON.stringify(packet);
  if (Buffer.byteLength(text, 'utf8') > PUBLICATION_REVIEW_MAX_EVIDENCE_BYTES)
    publicationReviewUnavailable('evidence_limit');
  const pathAllowed = (path: string) =>
    typeof path === 'string' &&
    path.length <= 400 &&
    posix.normalize(path) === path &&
    !path.startsWith('/') &&
    path !== '..' &&
    !path.startsWith('../') &&
    all.has(path);
  // These credential-free reads address pinned objects in the private host
  // reconstruction. Requalify the owning runtime around the whole read batch;
  // no inference, publication or mutable task operation occurs inside it.
  await assertBatchCurrent();
  return {
    packet,
    text,
    digest: digest(packet),
    fullContextPaths: [...files].sort(),
    async context(
      requests: PublicationContextRequest[],
      knownInstructions: ReadonlySet<string> = new Set(),
    ) {
      await assertBatchCurrent();
      const reads: PublicationContextRead[] = [],
        searches: PublicationContextSearch[] = [];
      const response: Array<unknown> = [];
      const instructionPaths = new Set<string>();
      for (const request of requests) {
        if (request.kind === 'read') {
          if (!pathAllowed(request.path)) publicationReviewUnavailable('context_path_unavailable');
          const content = await read(request.path);
          const lines = content.split('\n');
          if (lines.at(-1) === '') lines.pop();
          const totalLines = lines.length;
          const startLine = request.startLine ?? 1,
            endLine = request.endLine ?? totalLines;
          if (
            !Number.isSafeInteger(startLine) ||
            !Number.isSafeInteger(endLine) ||
            startLine < 1 ||
            endLine < startLine ||
            endLine > totalLines ||
            ((request.startLine !== undefined || request.endLine !== undefined) &&
              endLine - startLine >= 400)
          )
            publicationReviewUnavailable('context_range_unavailable');
          const coverage = {
            path: request.path,
            startLine,
            endLine,
            totalLines,
            remainingBefore: startLine - 1,
            remainingAfter: totalLines - endLine,
            complete: startLine === 1 && endLine === totalLines,
          };
          reads.push(coverage);
          const instructions = [];
          for (const path of ancestors(request.path, all))
            if (!knownInstructions.has(path) && !instructionPaths.has(path)) {
              instructions.push({ path, content: await read(path) });
              instructionPaths.add(path);
            }
          response.push({
            kind: 'read',
            ...coverage,
            content: lines.slice(startLine - 1, endLine).join('\n'),
            instructions,
          });
        } else {
          const prefix = request.pathPrefix;
          if (
            !request.query ||
            request.query.length > 120 ||
            request.query.includes('\0') ||
            (prefix !== undefined &&
              (posix.normalize(prefix) !== prefix ||
                prefix.startsWith('/') ||
                prefix === '..' ||
                prefix.startsWith('../') ||
                ![...all].some((path) => path === prefix || path.startsWith(prefix + '/'))))
          )
            publicationReviewUnavailable('context_search_unavailable');
          const found = await git(
            input,
            [
              'grep',
              '-l',
              '-z',
              '-I',
              '-F',
              '-e',
              request.query,
              source,
              '--',
              ...(prefix ? [`:(literal)${prefix}`] : []),
            ],
            true,
          );
          const matchedPaths = found
            .split('\0')
            .filter(Boolean)
            .map((entry) => entry.slice(source.length + 1));
          if (
            matchedPaths.length > MAX_DISCOVERY_PATHS ||
            matchedPaths.some((path) => !all.has(path))
          )
            publicationReviewUnavailable('context_search_limit');
          const search = {
            query: request.query,
            ...(prefix ? { pathPrefix: prefix } : {}),
            matchedPaths,
          };
          searches.push(search);
          response.push({
            kind: 'search',
            ...search,
            complete: true,
            matchCount: matchedPaths.length,
          });
        }
      }
      await assertBatchCurrent();
      return { response, reads, searches, instructionPaths: [...instructionPaths] };
    },
  };
}
