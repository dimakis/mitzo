import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const roots: string[] = [];
function root() {
  const selected = mkdtempSync(join(tmpdir(), 'mitzo-idle-agent-stores-'));
  mkdirSync(join(selected, '.mitzo'));
  roots.push(selected);
  return selected;
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const selected of roots.splice(0)) rmSync(selected, { recursive: true, force: true });
});

it('closes the actual opened library store without consulting a changed repository path', async () => {
  const owner = await import('../agent-library-runtime.js');
  expect(owner.closeAgentLibrary).toBeTypeOf('function');
  vi.stubEnv('REPO_PATH', root());
  const original = owner.getAgentLibrary();
  const changed = root();
  vi.stubEnv('REPO_PATH', changed);
  try {
    owner.closeAgentLibrary();
    expect(() => original.list('operator')).toThrow(/closed|open/i);
    expect(existsSync(join(changed, '.mitzo', 'events.db'))).toBe(false);
    owner.closeAgentLibrary();
    expect(existsSync(join(changed, '.mitzo', 'events.db'))).toBe(false);
  } finally {
    owner.closeAgentLibrary();
  }
});

it('closes the actual opened task store without consulting a changed repository path', async () => {
  const owner = await import('../agent-task-runtime.js');
  expect(owner.closeAgentTasks).toBeTypeOf('function');
  vi.stubEnv('REPO_PATH', root());
  const original = owner.getAgentTasks();
  const changed = root();
  vi.stubEnv('REPO_PATH', changed);
  try {
    owner.closeAgentTasks();
    expect(() => original.list('operator')).toThrow(/closed|open/i);
    expect(existsSync(join(changed, '.mitzo', 'events.db'))).toBe(false);
    owner.closeAgentTasks();
    expect(existsSync(join(changed, '.mitzo', 'events.db'))).toBe(false);
  } finally {
    owner.closeAgentTasks();
  }
});
