import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../ci-browser-gate.mjs', import.meta.url));
function run(selection: string, browser: string, offline: string, changes = 'success') {
  return spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CI_BROWSER_NEEDS: JSON.stringify({
        changes: { result: changes, outputs: { browser: selection } },
        browser: { result: browser },
        offline: { result: offline },
      }),
    },
  });
}

describe('required browser validation gate', () => {
  it('accepts both complete suites, or an explicit no-dependent-changes selection', () => {
    expect(run('true', 'success', 'success').status).toBe(0);
    expect(run('false', 'skipped', 'skipped').status).toBe(0);
  });

  it.each(['failure', 'cancelled', 'skipped', ''])(
    'rejects a required suite with result %j',
    (result) => {
      for (const [browser, offline] of [
        [result, 'success'],
        ['success', result],
      ]) {
        const outcome = run('true', browser, offline);
        expect(outcome.status).toBe(1);
        expect(outcome.stderr).toContain('Browser validation incomplete');
      }
    },
  );

  it.each(['failure', 'cancelled', 'skipped'])(
    'rejects unsuccessful job selection: %s',
    (changes) => {
      const outcome = run('false', 'skipped', 'skipped', changes);
      expect(outcome.status).toBe(1);
      expect(outcome.stderr).toContain('CI job selection did not succeed');
    },
  );

  it('rejects missing selection and unexpected skipped-path executions', () => {
    expect(run('', 'skipped', 'skipped').status).toBe(1);
    expect(run('false', 'failure', 'skipped').status).toBe(1);
    expect(run('false', 'success', 'success').status).toBe(1);
    const outcome = spawnSync(process.execPath, [script], {
      encoding: 'utf8',
      env: { ...process.env, CI_BROWSER_NEEDS: '{}' },
    });
    expect(outcome.status).toBe(1);
  });
});
