import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const publisherRepo = process.env.MITZO_KNOWLEDGE_PUBLISHER_REPO;
const builderRepo = resolve(fileURLToPath(new URL('../..', import.meta.url)));

// MGMT owns the real publisher, generator and offline fixtures. Public Mitzo
// CI has no private checkout; the required paired CI job sets this explicitly.
it.skipIf(publisherRepo === undefined)(
  'publishes A then knowledge-only B through the real MGMT publisher and current Mitzo consumer',
  () => {
    expect(
      publisherRepo,
      'MITZO_KNOWLEDGE_PUBLISHER_REPO must be an absolute checkout path',
    ).toBeTruthy();
    expect(isAbsolute(publisherRepo!)).toBe(true);
    const publisher = resolve(publisherRepo!);
    const fixture = join(publisher, 'tests/test_openshell_publication_contract.py');
    for (const path of [
      join(publisher, 'scripts/update_openshell_seed.sh'),
      join(publisher, 'memory/scripts/build_index.py'),
      fixture,
      ...[
        'prepare-mgmt-seed.sh',
        'prepare-mgmt-knowledge.sh',
        'runtime-resolution-contract.py',
      ].map((name) => join(builderRepo, 'docs/spikes/openshell-codex', name)),
    ]) {
      expect(
        existsSync(path) && statSync(path).isFile(),
        `Required actual component is missing: ${path}`,
      ).toBe(true);
    }

    const python = process.env.PYTHON ?? 'python';
    const interpreter = execFileSync(python, ['-c', 'import sys; print(sys.executable)'], {
      encoding: 'utf8',
      timeout: 10_000,
    }).trim();
    expect(isAbsolute(interpreter), 'PYTHON must resolve to an actual interpreter').toBe(true);
    const env = {
      ...process.env,
      MITZO_KNOWLEDGE_BUILDER_REPO: builderRepo,
      PATH: `${dirname(interpreter)}${delimiter}${process.env.PATH ?? ''}`,
    };
    const temporary = mkdtempSync(join(tmpdir(), 'mitzo-publisher-integration-'));
    const report = join(temporary, 'pytest.xml');
    try {
      // execFileSync throws for every nonzero exit, including no collected
      // tests. A JUnit check also rejects a successful run that skipped work.
      execFileSync(interpreter, ['-m', 'pytest', '-q', fixture, `--junitxml=${report}`], {
        cwd: publisher,
        env,
        timeout: 150_000,
        maxBuffer: 4 * 1024 * 1024,
        stdio: 'pipe',
      });
      const result = JSON.parse(
        execFileSync(
          interpreter,
          [
            '-c',
            `
import json, sys, xml.etree.ElementTree as ET
root = ET.parse(sys.argv[1]).getroot()
cases = list(root.iter('testcase'))
suites = list(root.iter('testsuite'))
print(json.dumps({
    'tests': len(cases),
    **{name: sum(int(suite.get(name, '0')) for suite in suites)
       + sum(case.find(element) is not None for case in cases)
       for name, element in [('skipped', 'skipped'), ('failures', 'failure'), ('errors', 'error')]},
}))
`,
            report,
          ],
          { encoding: 'utf8', env, timeout: 10_000 },
        ),
      );
      expect(
        result.tests,
        'The actual paired fixture must execute at least one test',
      ).toBeGreaterThan(0);
      expect(result.skipped, 'Required publication acceptance must not skip tests').toBe(0);
      expect(result.failures).toBe(0);
      expect(result.errors).toBe(0);
      console.info(
        `Actual MGMT publication contract: ${result.tests} tests; zero skipped, failures or errors.`,
      );
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  },
  180_000,
);
