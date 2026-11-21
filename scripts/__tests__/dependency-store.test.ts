import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { it } from 'vitest';

it('passes the dependency-free offline store contract', async () => {
  await promisify(execFile)(process.execPath, [
    '--test', '--test-concurrency=1', join(import.meta.dirname, 'dependency-store.node-test.mjs'),
  ], { env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=1024' } });
}, 60_000);
