import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { compile } from 'contexgin';

let root = '';
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

it('the released compiler includes tracked AGENTS guidance once and suppresses the legacy copy', async () => {
  root = mkdtempSync(join(tmpdir(), 'knowledge-instructions-'));
  writeFileSync(
    join(root, 'AGENTS.md'),
    '# Project guidance\n\n## Knowledge freshness\nUse the verified accepted knowledge revision.\n',
  );
  writeFileSync(
    join(root, 'CLAUDE.md'),
    '# Legacy\n\n## Required\nLegacy duplicate must not be injected.\n',
  );
  const result = await compile({ workspaceRoot: root, tokenBudget: 12000 });
  expect(result.bootPayload).toContain('Use the verified accepted knowledge revision.');
  expect(result.bootPayload).not.toContain('Legacy duplicate must not be injected.');
  expect(result.sources.filter((s) => s.relativePath === 'AGENTS.md')).toHaveLength(1);
});
