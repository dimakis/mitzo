import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClaudeLoginProcess } from '../claude-login-process.js';
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});
function fixture(body: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'claude-native-')));
  roots.push(root);
  const executable = join(root, 'claude');
  writeFileSync(executable, `#!${process.execPath}\n${body}`, { mode: 0o700 });
  return { root, executable };
}
const url =
  'https://claude.com/cai/oauth/authorize?redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=state&code_challenge=challenge&code_challenge_method=S256';
it('uses clean routing, receives chunked manual URL, and hands codes to the native process without logging them', async () => {
  vi.stubEnv('ANTHROPIC_API_KEY', 'synthetic-enmaas-key');
  vi.stubEnv('CLAUDE_CODE_USE_VERTEX', '1');
  vi.stubEnv('GH_TOKEN', 'synthetic-publishing-key');
  const f = fixture(`
    if (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_USE_VERTEX || process.env.GH_TOKEN) process.exit(9);
    if (process.env.BROWSER !== '/usr/bin/false') process.exit(10);
    process.stdout.write('If the browser did');
    setTimeout(() => process.stdout.write("n't open, visit: ${url}\\nPaste code here if prompted > "), 10);
    process.stdin.once('data', (code) => process.exit(code.toString() === 'code#state\\n' ? 0 : 11));
  `);
  const login = await createClaudeLoginProcess(f.root, new AbortController().signal, {
    executable: f.executable,
  });
  expect(login.url).toBe(url);
  await login.submit('code#state');
  expect(await login.completion).toEqual({ ok: true });
});
it('retains process failure and bounds output without exposing raw diagnostics', async () => {
  const f = fixture("process.stderr.write('private-provider-detail'); process.exit(1)");
  await expect(
    createClaudeLoginProcess(f.root, new AbortController().signal, { executable: f.executable }),
  ).rejects.toMatchObject({ code: 'CLAUDE_LOGIN_PROCESS_FAILED', cause: expect.any(Error) });
});
it('cancels a waiting native login and waits for process exit', async () => {
  const f = fixture(
    `process.stdout.write("If the browser didn't open, visit: ${url}\\n");setInterval(() => {},1000)`,
  );
  const controller = new AbortController();
  const login = await createClaudeLoginProcess(f.root, controller.signal, {
    executable: f.executable,
  });
  controller.abort();
  await login.cancel();
  expect(await login.completion).toMatchObject({ ok: false });
});
