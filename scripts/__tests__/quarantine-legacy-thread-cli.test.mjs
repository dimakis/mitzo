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
