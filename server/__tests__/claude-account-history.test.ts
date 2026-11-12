import { afterEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readClaudeAccountHistory } from '../claude-account-history.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it('uses the SDK to read only the selected account history without changing the controller environment', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'claude-history-')));
  roots.push(root);
  const cwd = join(root, 'task'),
    config = join(root, 'personal'),
    id = randomUUID();
  mkdirSync(cwd);
  const project = join(config, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(project, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(project, id + '.jsonl'),
    JSON.stringify({
      type: 'user',
      uuid: randomUUID(),
      parentUuid: null,
      sessionId: id,
      cwd,
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: 'Personal history' },
    }) + '\n',
  );
  const original = process.env.CLAUDE_CONFIG_DIR;
  const result = await readClaudeAccountHistory(id, cwd, config);
  expect(result.info).toMatchObject({ sessionId: id, cwd });
  expect(result.messages).toHaveLength(1);
  expect(process.env.CLAUDE_CONFIG_DIR).toBe(original);
  const other = join(root, 'other');
  mkdirSync(other, { mode: 0o700 });
  expect((await readClaudeAccountHistory(id, cwd, other)).messages).toEqual([]);
});
