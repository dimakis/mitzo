import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, renameSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  readHostWorkspaceDocument,
  createSessionWorkspaceDocumentReader,
} from '../workspace-document-reader.js';
const execute = promisify(execFile),
  dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));
function setup() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'workspace-document-')));
  dirs.push(dir);
  const primary = join(dir, 'primary'),
    secondary = join(dir, 'secondary');
  mkdirSync(primary);
  mkdirSync(secondary);
  writeFileSync(join(primary, 'report.md'), 'PRIMARY');
  writeFileSync(join(secondary, 'report.md'), 'SECONDARY');
  return { dir, primary, secondary };
}
it('rejects a real directory replacement with unchanged conversation metadata', async () => {
  const { primary } = setup();
  await expect(
    readHostWorkspaceDocument(
      primary,
      join(primary, 'report.md'),
      () => {},
      async (command, args, _env, signal) => {
        renameSync(primary, primary + '-old');
        mkdirSync(primary);
        writeFileSync(join(primary, 'report.md'), 'OTHER-OWNER');
        return (await execute(command, [...args], { signal })).stdout;
      },
    ),
  ).rejects.toThrow();
});
it('reads only selected session-owned primary/secondary roots and renews authority after capture', async () => {
  const { primary, secondary, dir } = setup();
  let allowed = true;
  const reader = createSessionWorkspaceDocumentReader({
    remote: () => false,
    readRemote: async () => {
      throw Error('No remote');
    },
    resolve: (_id, path) => resolve(primary, path),
    root: (_id, path) => (path.startsWith(secondary + '/') ? secondary : primary),
    allowed: () => allowed,
  });
  expect((await reader('chat', join(secondary, 'report.md'))).bytes.toString()).toBe('SECONDARY');
  await expect(reader('chat', join(dir, 'other', 'report.md'))).rejects.toThrow();
  const file = await reader('chat', 'report.md');
  allowed = false;
  expect(() => file.assertCurrentSync?.()).toThrow();
});
