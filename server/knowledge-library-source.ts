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
) {
  const child = exec('git', ['-C', directory, ...args], {
    env: { ...knowledgeGitEnvironment(), ...(indexFile ? { GIT_INDEX_FILE: indexFile } : {}) },
    maxBuffer: 8 * 1024 * 1024,
    timeout: 30_000,
  });
  if (input !== undefined) child.child.stdin?.end(input);
  try {
    return (await child).stdout;
  } catch {
    throw new Error('Knowledge Git operation failed');
  }
}
export function safeKnowledgePath(path: string): boolean {
  return (
    path.length <= 512 &&
    /^[\p{L}\p{N}_ /().-]+\.md$/u.test(path) &&
    path
      .split('/')
      .every(
        (p) =>
          p &&
          p !== '.' &&
          p !== '..' &&
          !p.startsWith('.') &&
          !['__pycache__', 'node_modules', 'scripts', 'tests', 'worktrees', 'dist'].includes(p),
      )
  );
}
const oid = /^[a-f0-9]{40,64}$/;
/** Reads Git objects only. It never checks out, reads dirty files or enumerates worktrees. */
export class AcceptedKnowledgeSource {
  private cached?: { revision: string; documents: { path: string; title: string; area: string }[] };
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
      this.paths.some((scope) => path === scope || path.startsWith(scope + '/'))
    );
  }
  async revision() {
    const sha = (
      await knowledgeGit(this.directory, ['rev-parse', '--verify', this.acceptedRef + '^{commit}'])
    ).trim();
    if (!oid.test(sha)) throw new Error('Accepted knowledge revision is invalid');
    return sha;
  }
  async catalog() {
    const revision = await this.revision();
    if (this.cached?.revision === revision) return this.cached;
    const tree = await knowledgeGit(this.directory, ['ls-tree', '-r', '-z', revision]);
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
    return (this.cached = { revision, documents });
  }
  async read(path: string, revision: string) {
    if (!oid.test(revision)) throw new Error('Knowledge revision is invalid');
    if (!this.allowed(path)) throw new Error('Document is outside the library');
    // Old accepted revisions stay addressable. Arbitrary task commits do not.
    await knowledgeGit(this.directory, ['merge-base', '--is-ancestor', revision, this.acceptedRef]);
    const entry = await knowledgeGit(this.directory, ['ls-tree', '-z', revision, '--', path]);
    const [meta, name] = entry.replace(/\0$/, '').split('\t');
    if (name !== path || !meta?.startsWith('100644 blob '))
      throw new Error('Document is outside the library');
    const blob = meta.split(' ')[2]!;
    const size = Number((await knowledgeGit(this.directory, ['cat-file', '-s', blob])).trim());
    if (!Number.isSafeInteger(size) || size > 5 * 1024 * 1024)
      throw new Error('Document exceeds the editor limit');
    const content = await knowledgeGit(this.directory, ['cat-file', 'blob', blob]);
    if (content.includes('\0') || content.includes('\uFFFD'))
      throw new Error('Document is not UTF-8 text');
    return { path, revision, content };
  }
}
