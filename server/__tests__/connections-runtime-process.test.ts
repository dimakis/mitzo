import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createConnectionsRuntime } from '../connections-runtime.js';

describe('connections runtime process execution', () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });

  it('closes OpenShell stdin so sandbox exec commands waiting for EOF can run', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'connections-runtime-process-'));
    directories.push(directory);
    const cli = join(directory, 'fake-openshell');
    writeFileSync(
      cli,
      `#!/usr/bin/env node
setTimeout(() => process.exit(1), 1000);
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify([{ id: 'provider-1', name: 'legacy', workspace: 'default', type: 'jira-readonly', credential_keys: ['JIRA_API_TOKEN'] }]));
  process.exit(0);
});
`,
    );
    chmodSync(cli, 0o700);
    const runtime = createConnectionsRuntime({
      directory,
      cli,
      workspace: 'default',
      eligibleAccountIds: () => [],
      legacyProviders: ['legacy'],
    });
    await expect(runtime.legacyProviders()).resolves.toEqual([
      { name: 'legacy', type: 'jira-readonly' },
    ]);
    runtime.store.close();
  });
});
