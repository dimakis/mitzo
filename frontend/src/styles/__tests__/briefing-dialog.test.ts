import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

const css = readFileSync(resolve(__dirname, '../briefing.css'), 'utf8');
it('centers the native briefing dialog despite the global reset and stretches long account names', () => {
  const dialog = css.match(/\.briefing-minion-dialog\s*\{([^}]+)\}/)?.[1];
  expect(dialog).toMatch(/margin:\s*auto;/);
  const selects = css.match(/\.briefing-minion-picker\s+\.chat-model-select\s*\{([^}]+)\}/)?.[1];
  expect(selects).toMatch(/width:\s*100%;/);
  expect(selects).toMatch(/max-width:\s*none;/);
});
