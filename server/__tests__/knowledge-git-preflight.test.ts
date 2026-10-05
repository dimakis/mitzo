import { afterEach, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  verifyKnowledgeGit,
  loadServiceGitEnvironment,
  main,
} from '../../scripts/verify-openshell-production.mjs';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
function fixture(broken = false, helper = true) {
  const root = mkdtempSync(join(tmpdir(), 'knowledge-git-'));
  roots.push(root);
  const execPath = join(root, 'libexec');
  mkdirSync(execPath);
  writeFileSync(
    join(root, 'git'),
    broken
      ? '#!/bin/sh\necho "license failure and private data" >&2\nexit 69\n'
      : `#!/bin/sh\ncase "$1" in\n--version) echo 'git version 2.50.0';;\n--exec-path) echo '${execPath}';;\nesac\n`,
  );
  chmodSync(join(root, 'git'), 0o755);
  if (helper) {
    writeFileSync(join(execPath, 'git-remote-https'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(execPath, 'git-remote-https'), 0o755);
  }
  return { MITZO_KNOWLEDGE_STORE_CONFIG: '/host/knowledge-store.json', PATH: root };
}
it('accepts working Git with its HTTPS helper for enrolled knowledge', () => {
  expect(() => verifyKnowledgeGit(fixture())).not.toThrow();
});
it.each([
  [true, true],
  [false, false],
])('rejects unusable Git or missing HTTPS support before deployment', (broken, helper) => {
  expect(() => verifyKnowledgeGit(fixture(broken, helper))).toThrow(
    'Knowledge publication requires working Git with HTTPS support in the service PATH. Repair Git before deployment.',
  );
});
it('does not require Git for deployments without a knowledge store', () => {
  expect(() => verifyKnowledgeGit({ PATH: '/missing' })).not.toThrow();
});

it('uses the candidate launchd PATH instead of an operator shell with working Git', () => {
  const shell = fixture();
  const service = fixture(true);
  const plist = join(roots[roots.length - 1], 'service.plist');
  writeFileSync(
    plist,
    `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>EnvironmentVariables</key><dict><key>PATH</key><string>${service.PATH}</string></dict></dict></plist>`,
  );
  const environment = loadServiceGitEnvironment(plist, {
    ...process.env,
    PATH: shell.PATH + ':' + process.env.PATH,
  });
  expect(environment.PATH).toBe(service.PATH);
  expect(() => verifyKnowledgeGit(shell, environment)).toThrow('Repair Git before deployment.');
});
it('rejects a candidate service without an explicit PATH', () => {
  fixture();
  const plist = join(roots[roots.length - 1], 'service.plist');
  writeFileSync(plist, '<plist version="1.0"><dict/></plist>');
  expect(() => loadServiceGitEnvironment(plist, process.env)).toThrow(
    'Candidate service Git environment is unavailable.',
  );
});

it('excludes shell-only toolchain overrides but honors release and service settings', () => {
  const git = fixture();
  const plist = join(roots[roots.length - 1], 'service.plist');
  const xml = (extra: string) =>
    `<plist version="1.0"><dict><key>EnvironmentVariables</key><dict><key>PATH</key><string>${git.PATH}</string>${extra}</dict></dict></plist>`;
  writeFileSync(plist, xml(''));
  const caller = { ...process.env, DEVELOPER_DIR: '/operator/tools', SHELL_ONLY: 'operator' };
  const service = loadServiceGitEnvironment(plist, caller);
  expect(service).not.toHaveProperty('DEVELOPER_DIR');
  expect(service).not.toHaveProperty('SHELL_ONLY');
  expect(
    loadServiceGitEnvironment(plist, caller, { DEVELOPER_DIR: '/release/tools' }).DEVELOPER_DIR,
  ).toBe('/release/tools');
  writeFileSync(plist, xml('<key>DEVELOPER_DIR</key><string>/service/tools</string>'));
  expect(
    loadServiceGitEnvironment(plist, caller, { DEVELOPER_DIR: '/release/tools' }).DEVELOPER_DIR,
  ).toBe('/service/tools');
});

it.each(['release', 'service'])(
  'checks plist-only knowledge enrollment with OpenShell enabled by %s',
  (enabledBy) => {
    const service = fixture(true);
    const root = roots[roots.length - 1];
    const plist = join(root, 'service.plist');
    const envPath = join(root, '.env');
    writeFileSync(envPath, enabledBy === 'release' ? 'MITZO_OPENSHELL_ENABLED=1\n' : '');
    writeFileSync(
      plist,
      `<plist version="1.0"><dict><key>EnvironmentVariables</key><dict><key>PATH</key><string>${service.PATH}</string>${enabledBy === 'service' ? '<key>MITZO_OPENSHELL_ENABLED</key><string>1</string>' : ''}<key>MITZO_KNOWLEDGE_STORE_CONFIG</key><string>/host/store.json</string></dict></dict></plist>`,
    );
    const caller = { ...process.env };
    delete caller.MITZO_KNOWLEDGE_STORE_CONFIG;
    expect(() => main([envPath, '--service-plist', plist], caller)).toThrow(
      'Repair Git before deployment.',
    );
  },
);
