import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillRegistry } from '../skills.js';
import { ordinarySkillEntries, resolveOrdinarySkillPrompt, captureOrdinarySkillPrompt } from '../ordinary-composer-skills.js';
import { EventStore } from '../event-store.js';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ordinary-skills-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  function skill(name: string, body: string, frontmatter = '') {
    mkdirSync(join(root, name), { recursive: true });
    writeFileSync(join(root, name, 'SKILL.md'), `---\ndescription: ${name} skill\n${frontmatter}---\n${body}`);
  }
  skill('mockup', 'Create a mockup for $ARGUMENTS');
  skill('restricted', 'Read only', 'allowed-tools:\n  - Read\n');
  skill('alias', 'Use the helper', 'requires-skills:\n  - restricted\n');
  return { registry: new SkillRegistry({ bundledDir: root }), skill };
}
it('renders supported skills and arguments while refusing tool ceilings, aliases and controller commands', () => {
  const { registry } = fixture();
  expect(resolveOrdinarySkillPrompt('/mockup a dashboard', registry)).toContain('Create a mockup for a dashboard');
  expect(resolveOrdinarySkillPrompt('normal prompt', registry)).toBeUndefined();
  expect(() => resolveOrdinarySkillPrompt('/restricted', registry)).toThrow(/tool restrictions/i);
  expect(() => resolveOrdinarySkillPrompt('/alias', registry)).toThrow(/tool restrictions/i);
  expect(() => resolveOrdinarySkillPrompt('/models', registry)).toThrow(/Chat settings/);
  expect(() => resolveOrdinarySkillPrompt('/unknown', registry)).toThrow(/Unknown command/);
  expect(ordinarySkillEntries(registry)).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: 'mockup', unavailableReason: undefined }),
    expect.objectContaining({ name: 'restricted', unavailableReason: expect.stringMatching(/tool restrictions/i) }),
    expect.objectContaining({ name: 'alias', unavailableReason: expect.stringMatching(/tool restrictions/i) }),
  ]));
});
it('freezes the provider prompt for recovery without changing the original command', () => {
  const { registry, skill } = fixture();
  const store = new EventStore(':memory:');
  cleanups.push(() => store.close());
  store.upsertSession({ sessionId: 'chat' });
  const text = '/mockup a dashboard';
  const first = captureOrdinarySkillPrompt(store, 'chat', 'command', text, registry);
  skill('mockup', 'Changed body');
  registry.invalidate();
  expect(captureOrdinarySkillPrompt(store, 'chat', 'command', text, registry)).toBe(first);
  expect(store.getEventsOfType('chat', 'ordinary_skill_context')).toHaveLength(1);
  expect(() => captureOrdinarySkillPrompt(store, 'chat', 'command', '/mockup different', registry)).toThrow(/changed/);
  expect(text).toBe('/mockup a dashboard');
});
