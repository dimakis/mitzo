import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  realpathSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
  linkSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARTIFACT_WRITE_HELPER, writeOpenShellArtifact } from '../artifact-writer.js';
const roots: string[] = [];
function workspace() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mitzo-edit-')));
  roots.push(root);
  writeFileSync(join(root, 'report.md'), 'original', { mode: 0o640 });
  return root;
}
function helper(root: string, path: string, content = 'updated', expectedContent = 'original') {
  return JSON.parse(
    execFileSync('/usr/bin/python3', ['-I', '-c', ARTIFACT_WRITE_HELPER, root, path], {
      input: JSON.stringify({ content, expectedContent }),
      encoding: 'utf8',
    }),
  );
}
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
describe('atomic artifact editing', () => {
  it('updates the file atomically and preserves its mode', () => {
    const root = workspace();
    expect(helper(root, 'report.md')).toEqual({ path: join(root, 'report.md'), ok: true });
    expect(readFileSync(join(root, 'report.md'), 'utf8')).toBe('updated');
    expect(statSync(join(root, 'report.md')).mode & 0o777).toBe(0o640);
  });
  it('refuses a stale save without changing the document', () => {
    const root = workspace();
    writeFileSync(join(root, 'report.md'), 'agent version');
    expect(helper(root, 'report.md').error).toBe('conflict');
    expect(readFileSync(join(root, 'report.md'), 'utf8')).toBe('agent version');
  });
  it.each(['../outside.md', '.env', '.codex/auth.json', '/etc/passwd'])('refuses %s', (path) => {
    expect(helper(workspace(), path).error).toBe('forbidden');
  });
  it('refuses symlinks, hardlinks, missing files and directories', () => {
    const root = workspace();
    symlinkSync('report.md', join(root, 'link.md'));
    linkSync(join(root, 'report.md'), join(root, 'hard.md'));
    expect(helper(root, 'link.md').error).toBe('forbidden');
    expect(helper(root, 'hard.md').error).toBe('forbidden');
    expect(helper(root, 'missing.md').error).toBe('not_found');
  });
  it('requires the original content and bounds replacement bytes', () => {
    const root = workspace();
    expect(helper(root, 'report.md', 'x'.repeat(5 * 1024 * 1024 + 1)).error).toBe('too_large');
  });
  it('verifies sandbox identity around the write and sends content over stdin', async () => {
    const verify = vi.fn(async () => {});
    const run = vi.fn(async () =>
      JSON.stringify({ path: '/sandbox/workspaces/mgmt/report.md', ok: true }),
    );
    const runtime = {
      cli: 'openshell',
      gateway: 'local',
      workspace: 'default',
      sandboxName: 'conversation-1',
      sandboxId: 'physical-id',
      workdir: '/sandbox/workspaces/mgmt',
      appServerCommand: '/sandbox/run-mitzo-app-server' as const,
    };
    await writeOpenShellArtifact(
      runtime,
      'report.md',
      'updated',
      'original',
      verify,
      undefined,
      run,
    );
    expect(verify).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0][4]).toBe(
      JSON.stringify({ content: 'updated', expectedContent: 'original' }),
    );
  });
});
