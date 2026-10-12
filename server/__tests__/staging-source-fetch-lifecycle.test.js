import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { expect, it } from 'vitest';
import { monitorBoundedSourceHistoryFetch } from '../../scripts/lib/staging-source-acceptance-witness.mjs';

it('refusal closes a descendant-held pipe after its original fetch parent has exited', async () => {
  // A tiny owned subprocess fixture, never Git/network, VM, staging or inference.
  const childCode = 'process.stderr.write("descendant-ready");setInterval(()=>{},1000)';
  const parentCode = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:['ignore','ignore',process.stderr]});console.log(child.pid);setTimeout(()=>process.exit(0),100);`;
  const parent = spawn(process.execPath, ['-e', parentCode], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: '/usr/bin:/bin' },
  });
  let descendant, cleanupError;
  parent.stdout.on('data', (bytes) => {
    descendant = Number(bytes.toString().trim());
  });
  const began = performance.now();
  try {
    await expect(
      monitorBoundedSourceHistoryFetch(parent, {
        assertScratch() {},
        timeoutMs: 400,
      }),
    ).rejects.toThrow(/source acceptance/);
    expect(performance.now() - began).toBeLessThan(2000);
    expect(Number.isSafeInteger(descendant)).toBe(true);
    const observed = spawnSync('/bin/ps', ['-p', String(descendant), '-o', 'stat='], {
      encoding: 'utf8',
      timeout: 1000,
    });
    expect(observed.error).toBeUndefined();
    // Linux CI may briefly retain an already-terminated orphan as a zombie.
    expect(observed.status === 1 || /^Z/.test(observed.stdout.trim())).toBe(true);
  } finally {
    try {
      process.kill(-parent.pid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') cleanupError = error;
    }
  }
  expect(cleanupError).toBeUndefined();
});
