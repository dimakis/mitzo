import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';

const exec = promisify(execFile);
export const knowledgeGitEnvironment = () => ({
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  HOME: process.env.HOME ?? '',
  TMPDIR: process.env.TMPDIR ?? tmpdir(),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_NO_REPLACE_OBJECTS: '1',
  GIT_NO_LAZY_FETCH: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'core.hooksPath',
  GIT_CONFIG_VALUE_0: '/dev/null',
  GIT_CONFIG_KEY_1: 'core.fsmonitor',
  GIT_CONFIG_VALUE_1: 'false',
});
export async function knowledgeGit(
  directory: string,
  args: string[],
  input?: string,
  indexFile?: string,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const child = exec('git', ['-C', directory, ...args], {
    env: { ...knowledgeGitEnvironment(), ...(indexFile ? { GIT_INDEX_FILE: indexFile } : {}) },
    maxBuffer: 8 * 1024 * 1024,
    timeout: 30_000,
    signal,
  });
  if (input !== undefined) child.child.stdin?.end(input);
  try {
    return (await child).stdout;
  } catch {
    throw new Error('Knowledge Git operation failed');
  }
}
async function knowledgeGitBlob(
  directory: string,
  blob: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  signal?.throwIfAborted();
  try {
    return (
      await exec('git', ['-C', directory, 'cat-file', 'blob', blob], {
        env: knowledgeGitEnvironment(),
        encoding: 'buffer',
        maxBuffer: 8 * 1024 * 1024,
        timeout: 30_000,
        signal,
      })
    ).stdout;
  } catch {
    throw new Error('Knowledge Git operation failed');
  }
}
const reservedSegments = new Set([
  '__pycache__',
  'node_modules',
  'scripts',
  'tests',
  'worktrees',
  'dist',
  'runtime',
  'logs',
  'coverage',
  'build',
]);
export function safeKnowledgeDirectory(path: string): boolean {
  return (
    path.length <= 512 &&
    /^[\p{L}\p{N}_ /().-]+$/u.test(path) &&
    path
      .split('/')
      .every(
        (p) =>
          p &&
          Buffer.byteLength(p, 'utf8') <= 255 &&
          p.trim() === p &&
          p !== '.' &&
          p !== '..' &&
          !p.startsWith('.') &&
          !reservedSegments.has(p.toLowerCase()),
      )
  );
}
export function safeKnowledgePath(path: string): boolean {
  return path.endsWith('.md') && safeKnowledgeDirectory(path);
}
const oid = /^[a-f0-9]{40,64}$/;
/** Reads Git objects only. It never checks out, reads dirty files or enumerates worktrees. */
export class AcceptedKnowledgeSource {
  private cached?: {
    revision: string;
    documents: { path: string; title: string; area: string }[];
    directories: string[];
    documentPaths: string[];
  };
  constructor(
    readonly directory: string,
    readonly acceptedRef: string,
    readonly paths: string[],
  ) {
    if (
      !/^refs\/(heads|remotes)\/[A-Za-z0-9_./-]+$/.test(acceptedRef) ||
      acceptedRef.includes('..')
    )
      throw new Error('Accepted knowledge ref is invalid');
    if (
      !paths.length ||
      paths.some((p) => !safeKnowledgePath(p.endsWith('.md') ? p : p + '/document.md'))
    )
      throw new Error('Knowledge document scopes are invalid');
  }
  allowed(path: string) {
    return (
      safeKnowledgePath(path) &&
      this.paths.some(
        (scope) => path === scope || (!scope.endsWith('.md') && path.startsWith(scope + '/')),
      )
    );
  }
  allowedDirectory(path: string) {
    return (
      safeKnowledgeDirectory(path) &&
      this.paths.some(
        (scope) => !scope.endsWith('.md') && (path === scope || path.startsWith(scope + '/')),
      )
    );
  }
  allowedMove(from: string, to: string) {
    if (this.paths.some((scope) => scope.endsWith('.md') && scope === from)) return false;
    const owner = (path: string) =>
      this.paths
        .filter((scope) => !scope.endsWith('.md') && path.startsWith(scope + '/'))
        .sort((a, b) => b.length - a.length)[0];
    const privateBoundary = (path: string) => {
      const parts = path.split('/');
      const index = parts.findIndex((part) => /^private(?:[_-]|$)/i.test(part));
      return index < 0 ? '' : parts.slice(0, index + 1).join('/');
    };
    return (
      from !== to &&
      this.allowed(from) &&
      this.allowed(to) &&
      privateBoundary(from) === privateBoundary(to) &&
      from.split('/')[0] === to.split('/')[0] &&
      Boolean(owner(from)) &&
      owner(from) === owner(to)
    );
  }
  private async entries(revision: string, signal?: AbortSignal) {
    if (!oid.test(revision)) throw new Error('Knowledge revision is invalid');
    await knowledgeGit(
      this.directory,
      ['merge-base', '--is-ancestor', revision, this.acceptedRef],
      undefined,
      undefined,
      signal,
    );
    const tree = await knowledgeGit(
      this.directory,
      ['ls-tree', '-r', '-t', '-z', revision],
      undefined,
      undefined,
      signal,
    );
    return new Map(
      tree.split('\0').flatMap((row) => {
        const [meta, path] = row.split('\t');
        return path && meta ? [[path, meta] as const] : [];
      }),
    );
  }
  async validateStructure(
    revision: string,
    documents: { path: string; sourcePath?: string }[],
    directories: string[] = [],
    signal?: AbortSignal,
  ) {
    const entries = await this.entries(revision, signal);
    const parents = (path: string) =>
      path
        .split('/')
        .slice(0, -1)
        .map((_, i, parts) => parts.slice(0, i + 1).join('/'));
    for (const document of documents) {
      if (
        !this.allowed(document.path) ||
        (document.sourcePath && !this.allowedMove(document.sourcePath, document.path))
      )
        throw new Error('Move is outside the library area');
      if (document.sourcePath && entries.has(document.path))
        throw new Error('Move destination is already occupied');
      for (const parent of parents(document.path)) {
        const entry = entries.get(parent);
        if (entry && !entry.startsWith('040000 tree '))
          throw new Error('Document parent is not a directory');
      }
    }
    for (const directory of directories) {
      if (
        !this.allowedDirectory(directory) ||
        !this.paths.some((scope) => !scope.endsWith('.md') && directory.startsWith(scope + '/'))
      )
        throw new Error('Folder is outside the library');
      if (entries.has(directory)) throw new Error('Folder destination is already occupied');
      for (const parent of parents(directory)) {
        const entry = entries.get(parent);
        if (entry && !entry.startsWith('040000 tree '))
          throw new Error('Folder parent is not a directory');
      }
    }
  }
  async revision(signal?: AbortSignal) {
    const sha = (
      await knowledgeGit(
        this.directory,
        ['rev-parse', '--verify', this.acceptedRef + '^{commit}'],
        undefined,
        undefined,
        signal,
      )
    ).trim();
    if (!oid.test(sha)) throw new Error('Accepted knowledge revision is invalid');
    return sha;
  }
  async catalog(signal?: AbortSignal) {
    const revision = await this.revision(signal);
    if (this.cached?.revision === revision) return this.cached;
    const tree = await knowledgeGit(
      this.directory,
      ['ls-tree', '-r', '-z', revision],
      undefined,
      undefined,
      signal,
    );
    const documents = tree.split('\0').flatMap((row) => {
      const [meta, path] = row.split('\t');
      if (!path || !meta?.startsWith('100644 blob ') || !this.allowed(path)) return [];
      return [
        {
          path,
          title: path.split('/').at(-1)!.replace(/\.md$/, '').replace(/[_-]/g, ' '),
          area: path.includes('/') ? path.split('/')[0]! : 'Essentials',
        },
      ];
    });
    const directories = new Set<string>();
    const addAncestors = (path: string) => {
      const parts = path.split('/');
      for (let i = 1; i < parts.length; i++) {
        const directory = parts.slice(0, i).join('/');
        if (this.allowedDirectory(directory)) directories.add(directory);
      }
    };
    for (const document of documents) addAncestors(document.path);
    for (const row of tree.split('\0')) {
      const [meta, path] = row.split('\t');
      if (
        !path?.endsWith('/.gitkeep') ||
        !meta?.startsWith('100644 blob ') ||
        !this.allowedDirectory(path.slice(0, -9))
      )
        continue;
      const size = (
        await knowledgeGit(
          this.directory,
          ['cat-file', '-s', meta.split(' ')[2]!],
          undefined,
          undefined,
          signal,
        )
      ).trim();
      if (size === '0') addAncestors(path);
    }
    return (this.cached = {
      revision,
      documents,
      directories: [...directories].sort(),
      documentPaths: [...this.paths],
    });
  }
  async read(path: string, revision: string, signal?: AbortSignal) {
    if (!oid.test(revision)) throw new Error('Knowledge revision is invalid');
    if (!this.allowed(path)) throw new Error('Document is outside the library');
    // Old accepted revisions stay addressable. Arbitrary task commits do not.
    await knowledgeGit(
      this.directory,
      ['merge-base', '--is-ancestor', revision, this.acceptedRef],
      undefined,
      undefined,
      signal,
    );
    const entry = await knowledgeGit(
      this.directory,
      ['ls-tree', '-z', revision, '--', path],
      undefined,
      undefined,
      signal,
    );
    const [meta, name] = entry.replace(/\0$/, '').split('\t');
    if (name !== path || !meta?.startsWith('100644 blob '))
      throw new Error('Document is outside the library');
    const blob = meta.split(' ')[2]!;
    const size = Number(
      (
        await knowledgeGit(this.directory, ['cat-file', '-s', blob], undefined, undefined, signal)
      ).trim(),
    );
    if (!Number.isSafeInteger(size) || size > 5 * 1024 * 1024)
      throw new Error('Document exceeds the editor limit');
    const bytes = await knowledgeGitBlob(this.directory, blob, signal);
    let content: string;
    try {
      // Decode the original bytes strictly. Literal U+FFFD and a BOM are valid text;
      // only malformed byte sequences and NUL fail the editor's text contract.
      content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      if (content.includes('\0')) throw new Error('NUL text');
    } catch {
      throw new Error('Document is not UTF-8 text');
    }
    return { path, revision, content };
  }
}
