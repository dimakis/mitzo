import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ManagedSession } from '@mitzo/harness';
import { agentToolCatalog } from './agent-tool-catalog.js';
import { codexPrivateDirectory } from './codex-private-path.js';
import { executeSandboxedCommand } from './sandboxed-command.js';
import { ToolBuilderStore } from './tool-builder-store.js';
import {
  ToolBuilderService,
  type ToolBuilderCatalog,
  type ToolBuilderWorkspace,
} from './tool-builder.js';
import { apiToolTemplate } from './api-tool-template.js';

let active: { path: string; store: ToolBuilderStore } | undefined;
export function getToolBuilderStore() {
  const directory = codexPrivateDirectory();
  const path = join(directory, 'tool-builder.db');
  if (!active || active.path !== path) {
    active?.store.close();
    active = { path, store: new ToolBuilderStore(path) };
  }
  return active.store;
}

function normalize(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
function score(query: string, label: string) {
  const words = normalize(query)
    .split(/\s+/)
    .filter((word) => word.length > 2);
  if (!words.length) return 0;
  const haystack = ` ${normalize(label)} `;
  return words.filter((word) => haystack.includes(` ${word} `)).length / words.length;
}
function escapeShellArgument(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
function containment(root: string, path: string) {
  const rel = relative(root, path);
  return (
    rel === '' ||
    (!isAbsolute(rel) &&
      rel !== '..' &&
      !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))
  );
}

export async function createToolBuilderWorkspace(worktree: string): Promise<ToolBuilderWorkspace> {
  const base = await realpath(worktree);
  const root = await mkdtemp(join(base, '.mitzo-tool-builder-'));
  const canonicalRoot = await realpath(root);
  if (!containment(base, canonicalRoot) || base === canonicalRoot) {
    await rm(root, { recursive: true, force: true });
    throw new Error('Tool Builder workspace authority is invalid');
  }
  const pathFor = (value: string) => {
    const parts = value.split('/');
    if (
      !value ||
      isAbsolute(value) ||
      parts.some((part) => part === '' || part === '.' || part === '..') ||
      value.includes('\\') ||
      value.includes('\0')
    )
      throw new Error('Tool file path is outside the authorized workspace');
    const path = resolve(canonicalRoot, ...parts);
    if (!containment(canonicalRoot, path))
      throw new Error('Tool file path is outside the authorized workspace');
    return { path, parts };
  };
  async function parentDirectory(parts: string[]) {
    let current = canonicalRoot;
    for (const part of parts.slice(0, -1)) {
      current = join(current, part);
      await mkdir(current, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      });
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(current)) !== current)
        throw new Error('Tool workspace contains an unsafe directory');
    }
    return current;
  }
  return {
    id: randomUUID(),
    root: canonicalRoot,
    async write(value, content) {
      const { path, parts } = pathFor(value);
      const parent = await parentDirectory(parts);
      if (!(await realpath(parent)).startsWith(canonicalRoot + '/'))
        throw new Error('Tool workspace authority changed');
      const file = await open(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await file.writeFile(content, 'utf8');
      } finally {
        await file.close();
      }
    },
    async read(value) {
      const { path, parts } = pathFor(value);
      const parent = await parentDirectory(parts);
      if (!(await realpath(parent)).startsWith(canonicalRoot + '/'))
        throw new Error('Tool workspace authority changed');
      const before = await lstat(path);
      if (!before.isFile() || before.isSymbolicLink())
        throw new Error('Tool workspace file is unsafe');
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const after = await file.stat();
        if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size)
          throw new Error('Tool workspace file changed while reading');
        return await readFile(file, 'utf8');
      } finally {
        await file.close();
      }
    },
    async discard() {
      if ((await realpath(canonicalRoot)) !== canonicalRoot)
        throw new Error('Tool workspace identity changed before cleanup');
      await rm(canonicalRoot, { recursive: true, force: true });
    },
  };
}

function builderCatalog(): ToolBuilderCatalog {
  const entries = agentToolCatalog();
  return {
    async search(query) {
      const candidates = [
        ...entries.map((entry) => ({ ...entry, kind: 'installed' })),
        {
          id: `template:${apiToolTemplate.id}`,
          version: 1,
          name: apiToolTemplate.label,
          description: apiToolTemplate.description,
          source: apiToolTemplate.source,
          kind: 'reviewed-template',
        },
      ];
      return candidates
        .map((entry) => ({
          ...entry,
          equivalent: score(query, `${entry.name} ${entry.description}`) >= 0.8,
        }))
        .filter((entry) => score(query, `${entry.name} ${entry.description}`) > 0)
        .sort((a, b) => Number(b.equivalent) - Number(a.equivalent) || b.version - a.version)
        .slice(0, 30);
    },
    readContract(id, version) {
      if (id === `template:${apiToolTemplate.id}` && version === 1)
        return { kind: 'reviewed-template', ...apiToolTemplate };
      const entry = entries.find(
        (candidate) => candidate.id === id && candidate.version === version,
      );
      if (!entry) throw new Error('Installed tool contract was not found');
      return entry;
    },
  };
}

export function createToolBuilderService(sessionId: string, session: ManagedSession) {
  const authorId = session.ordinaryRuntimeOwner?.authSessionId ?? session.ownedLocalAuthSessionId;
  return new ToolBuilderService({
    catalog: builderCatalog(),
    allocateWorkspace: async () => {
      if (session.mode === 'ask') throw new Error('Tool Builder requires Agent or Auto mode');
      if (!authorId)
        throw new Error('An authenticated runtime owner is required to prepare drafts');
      const primary = session.worktreePaths.get('primary')?.path;
      if (!primary)
        throw new Error('An isolated session worktree is required to prepare tool drafts');
      return createToolBuilderWorkspace(primary);
    },
    executor: {
      async run({ workspace, signal, examples }) {
        signal.throwIfAborted();
        const common = {
          cwd: workspace.root,
          writableRoots: [workspace.root],
          deniedRoots: [
            codexPrivateDirectory(),
            join(homedir(), '.codex'),
            join(homedir(), '.ssh'),
            join(homedir(), '.aws'),
            join(homedir(), '.config', 'gcloud'),
            join(homedir(), '.config', 'gh'),
            join(process.cwd(), '.env'),
            join(process.cwd(), '.mitzo'),
          ],
          env: { PATH: '/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin', LANG: 'C' },
          signal,
          timeoutMs: 60_000,
          maxOutputBytes: 32_000,
        };
        const tests = await executeSandboxedCommand({ ...common, command: 'node --test' });
        if (tests.isError)
          return {
            passed: false,
            complete: !signal.aborted,
            summary: 'Unit tests failed',
            examples: [],
          };
        const runner = fileURLToPath(new URL('./tool-builder-example-runner.mjs', import.meta.url));
        const entry = join(workspace.root, 'src', 'index.mjs');
        const examplesArg = Buffer.from(JSON.stringify(examples), 'utf8').toString('base64url');
        const run = await executeSandboxedCommand({
          ...common,
          command: `node ${escapeShellArgument(runner)} ${escapeShellArgument(entry)} ${escapeShellArgument(examplesArg)}`,
        });
        if (run.isError)
          return {
            passed: false,
            complete: !signal.aborted,
            summary: 'Example checks failed',
            examples: [],
          };
        const result = JSON.parse(run.content) as {
          complete: boolean;
          results: Array<{ actual: Record<string, unknown>; passed: boolean }>;
        };
        return {
          passed:
            result.complete &&
            result.results.length === examples.length &&
            result.results.every((row) => row.passed),
          complete: result.complete,
          summary: `Unit tests passed; ${result.results.length} examples checked`,
          examples: result.results,
        };
      },
    },
    store: getToolBuilderStore(),
    authorId,
  });
}
