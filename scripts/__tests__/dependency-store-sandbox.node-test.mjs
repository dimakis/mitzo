import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { dependencyStoreRoot } from '../lib/dependency-store.mjs';

// Run through an actual task executor. This does not create a nested sandbox
// (macOS refuses sandbox_init twice), and never installs or prunes host data.
it(
  'the actual task sandbox denies host store publication',
  {
    skip: process.env.MITZO_TEST_TASK_SANDBOX !== '1',
  },
  async () => {
    const store = dependencyStoreRoot();
    const marker = join(store, `.sandbox-probe-${randomUUID()}`);
    let created = false;
    let failure;
    try {
      await mkdir(store, { recursive: true });
      await writeFile(marker, 'exclusive test marker', { flag: 'wx' });
      created = true;
    } catch (cause) {
      failure = cause;
    } finally {
      if (created) await rm(marker);
    }
    assert.ok(
      ['EACCES', 'EPERM'].includes(failure?.code),
      'The host store must be denied by the task sandbox, not merely absent',
    );
  },
);
import process from 'node:process';
