/** Opt-in credential-free physical lane. Runs the production preparation ledger and
 * initializer against the pinned local image, then its actual native controller.
 * No gateway/login/model call. Never touches existing fixtures or volumes. */
import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { TESTED_SYMPOSIUM_NATIVE_BUILD } from '../symposium-production-gate.js';
import { SymposiumSessionArtifacts } from '../symposium-session-artifacts.js';
import {
  artifactGitContract,
  createArtifactGitVolume,
  initializeArtifactGit,
} from '../symposium-artifact-initializer.js';
import { symposiumArtifactOwner } from '../symposium-artifact-owner.js';
import { SYMPOSIUM_ARTIFACT_TARGET as target } from '../symposium-artifact-lease.js';
const image = TESTED_SYMPOSIUM_NATIVE_BUILD.image;
const physical = process.env.MITZO_ARTIFACT_PHYSICAL_CONTRACT === '1';
it.skipIf(!physical)(
  'prepares fresh Git, native writer commits, independent RO reviewer reads and cannot mutate',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'mitzo-git-contract-'));
    const session = randomUUID();
    const owner = symposiumArtifactOwner(image);
    const env = { HOME: process.env.HOME, PATH: process.env.PATH };
    const run = (args: readonly string[]) =>
      execFileSync(process.env.MITZO_CONTRACT_PODMAN ?? 'podman', [...args], {
        env,
        encoding: 'utf8',
        timeout: 60000,
        maxBuffer: 1024 * 1024,
      });
    const command = async (args: readonly string[]) => run(args);
    const inspect = async (name: string) => {
      const rows = JSON.parse(
        run(['volume', 'ls', '--filter', `name=^${name}$`, '--format', 'json']),
      );
      if (!rows.length) return null;
      const [v] = JSON.parse(run(['volume', 'inspect', name]));
      return { name: v.Name, driver: v.Driver, labels: v.Labels, options: v.Options ?? {} };
    };
    const store = new SymposiumSessionArtifacts(
      join(root, 'ledger.db'),
      'contract',
      root,
      () => {},
      {
        initializationContract: artifactGitContract(owner),
        initializerRequired: true,
        inspect,
        create: (name, labels, receipt) =>
          createArtifactGitVolume(name, labels, owner, command, () => {}, receipt),
      },
    );
    const checks: unknown[] = [];
    let cleanupComplete = false;
    try {
      const measured = run([
        'run',
        '--rm',
        '--pull=never',
        '--network=none',
        '--read-only',
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        '--timeout=20',
        '--entrypoint=/usr/bin/sha256sum',
        image,
        ...Object.keys(TESTED_SYMPOSIUM_NATIVE_BUILD.nativeArtifacts),
      ])
        .trim()
        .split('\n');
      expect(
        Object.fromEntries(
          measured.map((line) => {
            const [hash, path] = line.split(/\s+/);
            return [path, hash];
          }),
        ),
      ).toEqual(TESTED_SYMPOSIUM_NATIVE_BUILD.nativeArtifacts);
      checks.push({ nativeArtifacts: TESTED_SYMPOSIUM_NATIVE_BUILD.nativeArtifacts });
      expect(await store.ensure(session)).toEqual({ state: 'ready' });
      const mapping = store.getReady(session)!;
      expect(await store.ensure(session)).toEqual({ state: 'ready' });
      const db = new Database(join(root, 'ledger.db'), { readonly: true });
      const preparation = db
        .prepare(
          'SELECT initializer_name,initializer_id,initializer_removed,initialization_contract FROM symposium_session_artifacts',
        )
        .get() as Record<string, unknown>;
      db.close();
      expect(preparation.initializer_removed).toBe(1);
      const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
      const native = (
        mount: 'rw' | 'ro',
        access: 'read' | 'write',
        code: string,
        expected: number,
      ) => {
        const claim = createHash('sha256').update(randomUUID()).digest('hex');
        const name = `mitzo-git-contract-${randomUUID()}`;
        const script = `set -eu; /usr/local/bin/symposium-attempt-controller run ${claim} ${access} /usr/bin/python3 -I -B -c ${quote(code)}; /usr/bin/cat /sandbox/.symposium-control/${claim}.done`;
        const lines = run([
          'run',
          '--rm',
          '--name',
          name,
          '--pull=never',
          '--network=none',
          '--read-only',
          '--cap-drop=ALL',
          '--security-opt=no-new-privileges',
          '--timeout=20',
          '--user',
          'sandbox',
          '--tmpfs',
          '/sandbox:rw,mode=1777',
          '--volume',
          `${mapping.volumeName}:${target}:${mount}`,
          '--entrypoint=/bin/bash',
          image,
          '-c',
          script,
        ])
          .trim()
          .split('\n');
        const receipt = JSON.parse(lines.pop()!);
        expect(receipt).toMatchObject({ claim, terminal: true, signal: 0, exit_code: expected });
        checks.push({ mount, access, receipt, output: lines });
        return lines;
      };
      const git = `import subprocess,os\nenv={'PATH':'/usr/bin:/bin','HOME':'/nonexistent','GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':'/dev/null'}\ndef git(*args):\n return subprocess.check_output(['/usr/bin/git','-C','${target}',*args],env=env,text=True).strip()\n`;
      const writer = native(
        'rw',
        'write',
        git +
          `from pathlib import Path\nPath('${target}/proof.txt').write_text('NATIVE_WRITER_CONTENT')\ngit('add','proof.txt')\ngit('-c','user.name=Contract Test','-c','user.email=contract@example.invalid','-c','commit.gpgsign=false','commit','--quiet','-m','Physical contract')\nprint(git('rev-parse','HEAD'))`,
        0,
      );
      expect(writer[0]).toMatch(/^[a-f0-9]{40}$/);
      const reader = native(
        'ro',
        'read',
        git +
          `from pathlib import Path\nprint(Path('${target}/proof.txt').read_text())\nprint(git('rev-parse','HEAD'))`,
        0,
      );
      expect(reader).toEqual(['NATIVE_WRITER_CONTENT', writer[0]]);
      const denied = `from pathlib import Path\ntry:\n Path('${target}/forbidden').write_text('bad')\nexcept OSError as e:\n print('DENIED_'+str(e.errno))\n raise SystemExit(1)\nraise SystemExit(0)`;
      expect(native('ro', 'write', denied, 1)[0]).toMatch(/^DENIED_(13|30)$/);
      expect(native('rw', 'read', denied, 1)[0]).toBe('DENIED_13');
      let rejectedId = '';
      await expect(
        initializeArtifactGit(mapping.volumeName, owner, command, () => {}, {
          intent: () => {},
          created: (id) => {
            rejectedId = id;
          },
          removed: () => {},
        }),
      ).rejects.toThrow();
      expect(rejectedId).toMatch(/^[a-f0-9]{64}$/);
      const [helper] = JSON.parse(run(['inspect', rejectedId]));
      expect(helper.State.Running).toBe(false);
      run(['rm', rejectedId]);
      expect(native('ro', 'read', git + `print(git('rev-parse','HEAD'))`, 0)).toEqual(writer);
      const volume = await inspect(mapping.volumeName);
      expect(volume?.labels['mitzo.symposium.session']).toBe(session);
      run(['volume', 'rm', mapping.volumeName]);
      cleanupComplete = true;
      writeFileSync(
        join(root, 'evidence.json'),
        JSON.stringify(
          {
            completed: true,
            image,
            target,
            session,
            mapping,
            preparation,
            checks,
            cleanupComplete,
            modelCalls: 0,
            applicationCredentials: false,
            source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
          },
          null,
          2,
        ),
      );
      console.log(`Physical artifact evidence: ${root}/evidence.json`);
    } finally {
      store.close();
      if (!cleanupComplete) console.error(`Retained exact contract fixture for recovery: ${root}`);
    }
  },
  180000,
);
