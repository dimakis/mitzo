import './fixtures/offline-user-home.js';
import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { credentialSdkBoundary } from '../credential-sdk-boundary.js';
import { createProtectedSdkCommandRunner } from '../protected-sdk-command.js';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it.runIf(process.env.MITZO_TEST_OS_SANDBOX === '1')(
  'allows native development in the owned repository and denies writes in sibling checkouts and authority',
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'sdk-development-')));
    roots.push(root);
    const workspace = join(root, 'owned'),
      other = join(root, 'other'),
      account = join(root, 'account');
    for (const path of [workspace, other, account]) await mkdir(path);
    const executable = join(root, 'claude');
    await writeFile(executable, 'protected executable');
    execFileSync('/usr/bin/git', ['init', '--template=', '-b', 'mitzo/offline', workspace]);
    // Exercise the actual OS filesystem adapter without a network proxy or model.
    vi.stubEnv('MITZO_KEYCHAIN_CONNECTIONS_ENABLED', '0');
    vi.stubEnv('MITZO_SECRET_RELAY_ENABLED', '0');
    const runner = createProtectedSdkCommandRunner(credentialSdkBoundary('darwin', [executable])!);
    const script = `
      const fs = require('node:fs'), cp = require('node:child_process'), path = require('node:path');
      fs.writeFileSync('code.txt', 'implemented');
      cp.execFileSync('/usr/bin/git', ['add', 'code.txt']);
      cp.execFileSync('/usr/bin/git', ['-c', 'user.name=Offline', '-c', 'user.email=offline@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'offline native development']);
      fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'history.json'), '{}');
      const scratch = fs.mkdtempSync(path.join(process.env.TMPDIR, 'child-'));
      fs.writeFileSync(path.join(scratch, 'result.txt'), 'readable');
      if (fs.readFileSync(path.join(scratch, 'result.txt'), 'utf8') !== 'readable') throw Error('scratch unreadable');
      for (const target of ${JSON.stringify([join(other, 'code.txt'), executable])}) {
        try { fs.writeFileSync(target, 'escaped'); throw Error('write escaped: ' + target); }
        catch (e) { if (!['EPERM', 'EACCES'].includes(e.code)) throw e; }
      }
      process.stdout.write('native-development-and-boundaries-ok');
    `;
    const result = await runner(process.execPath, ['-e', script], {
      cwd: workspace,
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', CLAUDE_CONFIG_DIR: account },
      signal: new AbortController().signal,
      timeout: 20000,
    }).catch((cause: unknown) => {
      const stderr =
        cause && typeof cause === 'object' && 'stderr' in cause ? String(cause.stderr) : '';
      throw new Error(`Native sandbox probe failed: ${stderr}`, { cause });
    });
    expect(result.stdout).toBe('native-development-and-boundaries-ok');
    expect(await readFile(executable, 'utf8')).toBe('protected executable');
    expect(
      execFileSync('/usr/bin/git', ['-C', workspace, 'status', '--porcelain'], {
        encoding: 'utf8',
      }),
    ).toBe('');
  },
  30000,
);
