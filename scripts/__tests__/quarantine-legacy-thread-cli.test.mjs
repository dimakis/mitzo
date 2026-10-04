import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  realpathSync,
  mkdirSync,
  copyFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';

const cli = fileURLToPath(new URL('../quarantine-legacy-thread.mjs', import.meta.url));
function invalidRun(extra) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'quarantine-cli-')));
  try {
    const native = join(root, 'native.db');
    const db = new Database(native);
    db.exec(
      "CREATE TABLE immutable_marker(value TEXT); INSERT INTO immutable_marker VALUES ('preserve-history');",
    );
    db.close();
    const before = createHash('sha256').update(readFileSync(native)).digest('hex');
    const calls = join(root, 'forbidden-call.json');
    const preload = join(root, 'guard.mjs');
    writeFileSync(
      preload,
      `import cp from 'node:child_process';import {writeFileSync} from 'node:fs';import {syncBuiltinESMExports} from 'node:module';for(const name of ['execFileSync','spawnSync','spawn','execFile'])cp[name]=()=>{writeFileSync(${JSON.stringify(calls)},JSON.stringify({name}));throw new Error('forbidden operational call');};syncBuiltinESMExports();`,
    );
    const out = join(root, 'snapshot.json');
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        preload,
        cli,
        '--accepted-head',
        'a'.repeat(40),
        '--database',
        native,
        '--env',
        join(root, 'private.env'),
        '--events-database',
        native,
        '--conversation',
        'b6482bac-5144-4afc-b042-af148a339e9b',
        '--confirmed-held-inputs',
        ...extra(out),
      ],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toContain('do-not-echo');
    expect(createHash('sha256').update(readFileSync(native)).digest('hex')).toBe(before);
    expect(existsSync(out)).toBe(false);
    // Git, service/lock commands and native RPC probes are all behind this barrier.
    expect(existsSync(calls), 'invalid arguments reached an operational subprocess').toBe(false);
    expect(JSON.parse(result.stderr)).toMatchObject({
      error: 'quarantine_cli_options_invalid',
      modelCalls: 0,
      serviceActions: 0,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
describe('quarantine CLI validates arguments before every operational boundary', () => {
  it('rejects --apply with --snapshot-out before touching state or running any probe', () =>
    invalidRun((out) => ['--apply', '--snapshot-out', out]));
  it('rejects duplicate apply flags before touching state', () =>
    invalidRun(() => ['--apply', '--apply']));
  it('rejects duplicate value flags before touching state', () =>
    invalidRun(() => ['--accepted-head', 'b'.repeat(40)]));
  it('rejects unknown flags before touching state', () =>
    invalidRun(() => ['--unknown-private-value', 'do-not-echo']));
  it('rejects missing values before touching state', () => invalidRun(() => ['--env']));
});

function authorityRun({
  fallback = false,
  copy = false,
  copiedEnv = false,
  plistOverride = false,
  rejectedControl,
  badProgram = false,
  launchdOverride = false,
  emptyNative = false,
}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'quarantine-authority-')));
  try {
    const directory =
      fallback || emptyNative ? join(root, '.mitzo/private/codex') : join(root, 'native-private');
    mkdirSync(directory, { recursive: true });
    const canonical = join(directory, 'conversations.db');
    const original = new Database(canonical);
    original.exec(
      "CREATE TABLE immutable_marker(value TEXT); INSERT INTO immutable_marker VALUES ('preserve-history');",
    );
    original.close();
    const overridden = join(root, 'overridden-native');
    if (plistOverride || launchdOverride) {
      mkdirSync(overridden);
      copyFileSync(canonical, join(overridden, 'conversations.db'));
    }
    const supplied = copy
      ? join(root, 'owned-copy.db')
      : plistOverride || launchdOverride
        ? join(overridden, 'conversations.db')
        : canonical;
    if (copy) copyFileSync(canonical, supplied);
    const hashes = [canonical, supplied].map((path) =>
      createHash('sha256').update(readFileSync(path)).digest('hex'),
    );
    const env = join(root, 'private.env');
    writeFileSync(
      env,
      `REPO_PATH=${root}\n${fallback ? '' : `MITZO_CODEX_PRIVATE_DIR=${emptyNative ? join(root, 'authored-ignored') : directory}\n`}`,
      { mode: 0o600 },
    );
    const installed = join(root, 'installed-release');
    mkdirSync(installed);
    copyFileSync(env, join(installed, '.env'));
    if (copiedEnv)
      writeFileSync(env, `REPO_PATH=${root}\nMITZO_CODEX_PRIVATE_DIR=${root}\n`, { mode: 0o600 });
    const plistDirectory = join(root, 'Library/LaunchAgents');
    mkdirSync(plistDirectory, { recursive: true });
    writeFileSync(join(plistDirectory, 'com.mitzo.server.plist'), 'fixture', { mode: 0o600 });
    const plist = {
      Label: 'com.mitzo.server',
      WorkingDirectory: installed,
      ProgramArguments: [join(installed, 'scripts/start.sh')],
      EnvironmentVariables: plistOverride ? { MITZO_CODEX_PRIVATE_DIR: overridden } : {},
    };
    if (badProgram) plist.Program = '/bin/false';
    const expected = join(root, 'expected.json');
    writeFileSync(expected, '{}', { mode: 0o600 });
    const events = join(root, '.mitzo/events.db');
    mkdirSync(join(root, '.mitzo'), { recursive: true });
    const eventDb = new Database(events);
    eventDb.close();
    const calls = join(root, 'calls.json');
    const preload = join(root, 'authority-guard.mjs');
    writeFileSync(
      preload,
      `import cp from 'node:child_process';import os from 'node:os';import {writeFileSync} from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
os.userInfo=()=>({homedir:${JSON.stringify(root)}});
cp.execFileSync=(command,args)=>{if(command==='/usr/bin/plutil')return ${JSON.stringify(JSON.stringify(plist))};if(command==='git'){if(args.includes('rev-parse'))return '${'a'.repeat(40)}\\n';if(args.includes('status')||args.includes('branch'))return '';if(args.includes('get-url'))return 'https://github.com/dimakis/mitzo.git\\n';if(args.includes('ls-remote'))return '${'a'.repeat(40)}\\trefs/heads/main\\n';}writeFileSync(${JSON.stringify(calls)},JSON.stringify({boundary:command}));throw new Error('operational boundary');};
cp.spawnSync=(command,args)=>{if(command==='/bin/launchctl'&&args[0]==='print'&&!args[1].includes('/com.mitzo.server'))return {status:0,stdout:${JSON.stringify('gui = {\n\tenvironment = {\n' + (rejectedControl ? '\t\t' + rejectedControl + ' => fixture\n' : '') + (launchdOverride || emptyNative ? '\t\tMITZO_CODEX_PRIVATE_DIR => fixture\n' : '') + '\t}\n}\n')},stderr:''};if(command==='/bin/launchctl'&&args[0]==='getenv'){if(args[1]===${JSON.stringify(rejectedControl ?? '')})return {status:0,stdout:'unsupported-control\\n',stderr:''};if(args[1]==='MITZO_CODEX_PRIVATE_DIR'&&${JSON.stringify(launchdOverride || emptyNative)})return {status:0,stdout:${JSON.stringify(emptyNative ? '' : overridden + '\n')},stderr:''};return {status:0,stdout:'',stderr:''};}if(command==='/bin/launchctl')return {status:1,stderr:'Could not find service'};if(command==='/usr/sbin/lsof')return {status:1};throw new Error('unexpected native command');};syncBuiltinESMExports();`,
    );
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        preload,
        cli,
        '--accepted-head',
        'a'.repeat(40),
        '--env',
        env,
        '--database',
        supplied,
        '--events-database',
        events,
        '--conversation',
        'b6482bac-5144-4afc-b042-af148a339e9b',
        '--confirmed-held-inputs',
        '--apply',
        '--expected',
        expected,
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: join(root, 'caller-forged-home'),
          MITZO_CODEX_PRIVATE_DIR: join(root, 'ambient-ignored'),
        },
      },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toContain(root);
    expect(
      [canonical, supplied].map((path) =>
        createHash('sha256').update(readFileSync(path)).digest('hex'),
      ),
    ).toEqual(hashes);
    if (copy || copiedEnv || rejectedControl || badProgram) {
      expect(existsSync(calls), 'owned copied DB reached apply boundary').toBe(false);
      expect(JSON.parse(result.stderr).error).toBe(
        copiedEnv || rejectedControl || badProgram
          ? 'quarantine_precondition_or_cas_failed'
          : 'authoritative_native_database_required',
      );
    } else {
      // Stop at lock acquisition, before mutation/native probes.
      expect(JSON.parse(readFileSync(calls)).boundary).toBe('/usr/bin/shlock');
      expect(JSON.parse(result.stderr).error).toBe('quarantine_precondition_or_cas_failed');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
describe('quarantine CLI binds the actual server native ledger', () => {
  it('rejects an owned byte-identical copy before apply', () => authorityRun({ copy: true }));
  it('accepts the explicit environment native path through authority preconditions', () =>
    authorityRun({}));
  for (const rejectedControl of [
    'DOTENV_CONFIG_ENCODING',
    'DOTENV_CONFIG_DOTENV_KEY',
    'DOTENV_KEY',
  ])
    it(`rejects inherited ${rejectedControl} before DB/lock/probes`, () =>
      authorityRun({ rejectedControl }));
  it('rejects a differing plist Program executable', () => authorityRun({ badProgram: true }));
  it('rejects a copied environment that redefines native authority', () =>
    authorityRun({ copiedEnv: true }));
  it('honors an explicitly present launchd native override', () =>
    authorityRun({ launchdOverride: true }));
  it('preserves an explicitly present empty launchd override and uses host fallback', () =>
    authorityRun({ emptyNative: true }));
  it('honors the installed plist native-directory precedence', () =>
    authorityRun({ plistOverride: true }));
  it('uses the server HOME fallback and ignores ambient private-dir overrides', () =>
    authorityRun({ fallback: true }));
});
