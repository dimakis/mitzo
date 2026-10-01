import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  linkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OPEN_SHELL_ARTIFACT_HELPER,
  readOpenShellArtifact,
  type ArtifactCommandRunner,
} from '../openshell-artifact-reader.js';

const roots: string[] = [];
function workspace() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mitzo-artifact-read-')));
  roots.push(root);
  mkdirSync(join(root, 'outputs'));
  writeFileSync(join(root, 'outputs/report.md'), Buffer.from([0, 1, 128, 255]));
  return root;
}
function helper(root: string, path: string) {
  return JSON.parse(
    execFileSync('/usr/bin/python3', ['-I', '-c', OPEN_SHELL_ARTIFACT_HELPER, root, path], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    }),
  );
}
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe('workspace artifact helper', () => {
  it('returns exact bytes and normalized absolute path for relative and absolute requests', () => {
    const root = workspace();
    for (const path of ['./outputs/report.md', `${root}/outputs/report.md`]) {
      expect(helper(root, path)).toEqual({ path: `${root}/outputs/report.md`, data: 'AAGA/w==' });
    }
  });
  it.each([
    '../outside.md',
    '/etc/passwd',
    'outputs/../../outside.md',
    '.codex/auth.json',
    '.env',
    '.config/gws/credentials.json',
    '.cursor/mcp.json',
    '.docker/config.json',
    '.kube/config',
    '.git/config',
    String.raw`outputs\report.md`,
  ])('rejects private or escaping path %s', (path) => {
    const root = workspace();
    expect(helper(root, path).error).toBe('forbidden');
  });
  it('rejects file/directory symlinks and hard links', () => {
    const root = workspace();
    symlinkSync('outputs/report.md', join(root, 'link.md'));
    symlinkSync('outputs', join(root, 'linked'));
    linkSync(join(root, 'outputs/report.md'), join(root, 'hard.md'));
    for (const path of ['link.md', 'linked/report.md', 'hard.md'])
      expect(helper(root, path).error).toBe('forbidden');
  });
  it('rejects a symlinked workspace root', () => {
    const root = workspace();
    symlinkSync('outputs', join(root, 'root-link'));
    expect(helper(join(root, 'root-link'), 'report.md').error).toBe('forbidden');
  });
  it('returns an empty file and accepts exactly 5 MiB', () => {
    const root = workspace();
    writeFileSync(join(root, 'empty.md'), '');
    writeFileSync(join(root, 'limit.md'), Buffer.alloc(5 * 1024 * 1024, 255));
    expect(helper(root, 'empty.md').data).toBe('');
    expect(Buffer.from(helper(root, 'limit.md').data, 'base64').length).toBe(5 * 1024 * 1024);
  });
  it('rejects a FIFO without blocking on a reader', () => {
    const root = workspace();
    execFileSync('mkfifo', [join(root, 'pipe.md')]);
    expect(helper(root, 'pipe.md').error).toBe('not_file');
  });
  it('limits size, reports missing files, and rejects directories', () => {
    const root = workspace();
    writeFileSync(join(root, 'large.md'), Buffer.alloc(5 * 1024 * 1024 + 1));
    expect(helper(root, 'large.md').error).toBe('too_large');
    expect(helper(root, 'missing.md').error).toBe('not_found');
    expect(helper(root, 'outputs').error).toBe('not_file');
  });
});

const runtime = {
  sandboxName: 'conversation-1',
  sandboxId: 'physical-id',
  workdir: '/sandbox/workspaces/mgmt',
  appServerCommand: '/sandbox/run-mitzo-app-server' as const,
  cli: 'openshell',
  gateway: 'gateway',
  workspace: 'workspace',
  gatewayInsecure: false,
};
describe('trusted artifact transport', () => {
  it('verifies identity before and after exact SSH argv and preserves binary bytes', async () => {
    const events: string[] = [];
    const verify = vi.fn(async () => {
      events.push('verify');
    });
    const run = vi.fn<ArtifactCommandRunner>(async () => {
      events.push('ssh');
      return JSON.stringify({ path: '/sandbox/workspaces/mgmt/report.md', data: 'AAGA/w==' });
    });
    const result = await readOpenShellArtifact(runtime, 'report.md', verify, undefined, run);
    expect(result.path).toBe('/sandbox/workspaces/mgmt/report.md');
    expect([...result.bytes]).toEqual([0, 1, 128, 255]);
    expect(events).toEqual(['verify', 'ssh', 'verify']);
    expect(run.mock.calls[0][0]).toBe('ssh');
    expect(run.mock.calls[0][1].at(-1)).toContain("'/usr/bin/python3' '-I' '-c'");
    expect(run.mock.calls[0][1].join(' ')).toContain('conversation-1');
  });
  it('accepts the exact size boundary without recursive base64 validation', async () => {
    const bytes = Buffer.alloc(5 * 1024 * 1024, 255);
    const run = vi.fn<ArtifactCommandRunner>().mockResolvedValue(
      JSON.stringify({
        path: '/sandbox/workspaces/mgmt/report.md',
        data: bytes.toString('base64'),
      }),
    );
    expect(
      (
        await readOpenShellArtifact(runtime, 'report.md', async () => {}, undefined, run)
      ).bytes.equals(bytes),
    ).toBe(true);
  });
  it('never dispatches an artifact read when persisted identity verification fails', async () => {
    const run = vi.fn<ArtifactCommandRunner>();
    const verify = vi.fn(async () => {
      throw Object.assign(new Error('Sandbox is stopped or replaced'), { status: 503 });
    });
    await expect(
      readOpenShellArtifact(runtime, 'report.md', verify, undefined, run),
    ).rejects.toMatchObject({ status: 503 });
    expect(run).not.toHaveBeenCalled();
  });
  it('discards bytes if physical identity verification fails after reading', async () => {
    const run = vi
      .fn<ArtifactCommandRunner>()
      .mockResolvedValue(
        JSON.stringify({ path: '/sandbox/workspaces/mgmt/report.md', data: 'eA==' }),
      );
    const verify = vi
      .fn<() => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(Object.assign(new Error('Physical sandbox changed'), { status: 503 }));
    await expect(
      readOpenShellArtifact(runtime, 'report.md', verify, undefined, run),
    ).rejects.toMatchObject({ status: 503 });
  });
  it('maps helper refusal and rejects malformed or out-of-scope success responses', async () => {
    for (const response of [
      { error: 'forbidden' },
      { path: '/etc/passwd', data: 'eA==' },
      { path: '/sandbox/workspaces/mgmt/report.md', data: 'invalid!!' },
    ]) {
      const run = vi.fn<ArtifactCommandRunner>().mockResolvedValue(JSON.stringify(response));
      await expect(
        readOpenShellArtifact(runtime, 'report.md', async () => {}, undefined, run),
      ).rejects.toBeInstanceOf(Error);
    }
  });
});

it.each(['before', 'after'])('preserves actionable identity refusal %s reading', async (when) => {
  const refusal = Object.assign(new Error('Resume this conversation to access its files'), {
    status: 409,
  });
  const verify = vi.fn<() => Promise<void>>();
  if (when === 'before') verify.mockRejectedValueOnce(refusal);
  else verify.mockResolvedValueOnce(undefined).mockRejectedValueOnce(refusal);
  const run = vi
    .fn<ArtifactCommandRunner>()
    .mockResolvedValue(
      JSON.stringify({ path: '/sandbox/workspaces/mgmt/report.md', data: 'eA==' }),
    );
  await expect(readOpenShellArtifact(runtime, 'report.md', verify, undefined, run)).rejects.toBe(
    refusal,
  );
  expect(run).toHaveBeenCalledTimes(when === 'before' ? 0 : 1);
});

it('isolates helper imports from hostile workspace modules and PYTHONPATH', () => {
  const root = workspace();
  writeFileSync(join(root, 'json.py'), 'raise RuntimeError("workspace module imported")');
  writeFileSync(
    join(root, 'sitecustomize.py'),
    'raise RuntimeError("workspace sitecustomize imported")',
  );
  const response = execFileSync(
    '/usr/bin/python3',
    ['-I', '-c', OPEN_SHELL_ARTIFACT_HELPER, root, 'outputs/report.md'],
    { cwd: root, env: { ...process.env, PYTHONPATH: root }, encoding: 'utf8' },
  );
  expect(JSON.parse(response)).toEqual({ path: `${root}/outputs/report.md`, data: 'AAGA/w==' });
});
