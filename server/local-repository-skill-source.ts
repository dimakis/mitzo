import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { readOnlyGitExecutable } from './read-only-git.js';
import type { LocalRepositorySource } from './local-repository-worktree.js';
import { SKILL_SIZE_LIMIT } from './skills.js';

const execute = promisify(execFile);
const unavailable = () => Error('Pinned repository skills unavailable');

/** Only committed skill bytes enter this temporary read view. No checkout,
 * hooks, filters, source writes, branch changes or lazy network acquisition. */
export async function withPinnedRepositorySkills<T>(
  source: LocalRepositorySource,
  baseOid: string,
  signal: AbortSignal,
  read: (directory: string) => T | Promise<T>,
): Promise<T> {
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(baseOid)) throw unavailable();
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
  const git = async (args: string[], maxBuffer = 262144) => {
    bounded.throwIfAborted();
    const { stdout } = await execute(
      readOnlyGitExecutable(),
      [
        '--no-replace-objects',
        '--no-optional-locks',
        '--git-dir=' + source.commonDirectory,
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.hooksPath=/dev/null',
        ...args,
      ],
      {
        encoding: 'buffer',
        timeout: 5000,
        maxBuffer,
        signal: bounded,
        env: {
          PATH: '/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin',
          HOME: '/nonexistent',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_SYSTEM: '/dev/null',
          GIT_NO_LAZY_FETCH: '1',
          GIT_NO_REPLACE_OBJECTS: '1',
          GIT_TERMINAL_PROMPT: '0',
        },
      },
    );
    return stdout;
  };
  const tree = async (ref: string, path?: string) => {
    const output = await git(['ls-tree', '-z', ref, ...(path ? ['--', path] : [])]);
    return output
      .toString('utf8')
      .split('\0')
      .filter(Boolean)
      .map((row) => {
        const match = /^(\d{6}) (tree|blob) ([a-f0-9]{40}(?:[a-f0-9]{24})?)\t([^\0]+)$/.exec(row);
        if (!match) throw unavailable();
        return { mode: match[1], oid: match[3], name: match[4] };
      });
  };
  const directory = await mkdtemp(join(tmpdir(), 'mitzo-pinned-skills-'));
  try {
    const root = (await tree(baseOid, '.mitzo'))[0];
    if (root && root.mode !== '040000') throw unavailable();
    const skills = root && (await tree(baseOid + ':.mitzo', 'skills'))[0];
    if (skills && skills.mode !== '040000') throw unavailable();
    const entries = skills ? await tree(baseOid + ':.mitzo/skills') : [];
    if (entries.length > 1000) throw unavailable();
    let bytes = 0;
    for (const entry of entries) {
      if (entry.mode === '120000') throw unavailable();
      if (entry.mode !== '040000' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(entry.name)) continue;
      const file = (await tree(baseOid + ':.mitzo/skills/' + entry.name, 'SKILL.md'))[0];
      if (!file) continue;
      if (!['100644', '100755'].includes(file.mode)) throw unavailable();
      const body = await git(['cat-file', 'blob', file.oid], SKILL_SIZE_LIMIT + 1);
      bytes += body.length;
      if (body.length > SKILL_SIZE_LIMIT || bytes > 2 * 1024 * 1024) throw unavailable();
      const target = join(directory, '.mitzo', 'skills', entry.name);
      await mkdir(target, { recursive: true, mode: 0o700 });
      await writeFile(join(target, 'SKILL.md'), body, { mode: 0o600, flag: 'wx' });
    }
    bounded.throwIfAborted();
    const result = await read(directory);
    bounded.throwIfAborted();
    return result;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
