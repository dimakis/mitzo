import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { SDKSessionInfo, SessionMessage } from '@anthropic-ai/claude-agent-sdk';

const execute = promisify(execFile);
// The SDK's filesystem readers use process-global CLAUDE_CONFIG_DIR. A short-lived
// reader keeps concurrent accounts isolated while the SDK owns transcript parsing.
const reader = `
const sdk = await import(process.argv[1]);
const [id, dir, limit] = process.argv.slice(2);
const info = await sdk.getSessionInfo(id, { dir });
const messages = info ? await sdk.getSessionMessages(id, { dir, limit: Number(limit) }) : [];
process.stdout.write(JSON.stringify({ info, messages }));
`;
export async function readClaudeAccountHistory(
  sessionId: string,
  cwd: string,
  configDirectory: string,
  limit = 1,
) {
  z.uuid().parse(sessionId);
  const { stdout } = await execute(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      reader,
      createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk'),
      sessionId,
      cwd,
      String(z.number().int().min(1).max(10_000).parse(limit)),
    ],
    {
      env: {
        HOME: process.env.HOME,
        PATH: process.env.PATH,
        TMPDIR: process.env.TMPDIR,
        CLAUDE_CONFIG_DIR: configDirectory,
      },
      timeout: 10_000,
      maxBuffer: 8 * 1024 * 1024,
      encoding: 'utf8',
    },
  );
  return JSON.parse(stdout) as { info?: SDKSessionInfo; messages: SessionMessage[] };
}
