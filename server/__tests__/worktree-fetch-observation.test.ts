import { afterAll, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { fetchWorktreeBase } from '../worktree.js';

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
provider.register();
afterAll(() => provider.shutdown());

it('times the actual fetch separately while selecting the current remote commit', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'offline-fetch-timing-')));
  const source = join(root, 'source'),
    remote = join(root, 'remote.git');
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      encoding: 'utf8',
      stdio: 'pipe',
      env: {
        PATH: process.env.PATH,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
      },
    }).trim();
  try {
    git('init', '-q', '-b', 'main', source);
    writeFileSync(join(source, 'source.txt'), 'offline');
    git('-C', source, 'add', 'source.txt');
    git(
      '-C',
      source,
      '-c',
      'user.name=Offline',
      '-c',
      'user.email=offline@example.test',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '-qm',
      'source',
    );
    const current = git('-C', source, 'rev-parse', 'HEAD');
    git('clone', '--bare', source, remote);
    git('-C', source, 'remote', 'add', 'origin', remote);
    exporter.reset();
    expect(await fetchWorktreeBase(source)).toBe(current);
    const spans = exporter
      .getFinishedSpans()
      .filter((s) => s.name === 'local_codex.repository_fetch');
    expect(spans).toHaveLength(1);
    expect(spans[0].status.code).toBe(1);
    expect(JSON.stringify(spans[0].attributes)).not.toContain(root);
    expect(git('-C', source, 'rev-parse', 'HEAD')).toBe(current);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
