import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillRegistry } from '../skills.js';
import {
  ordinarySkillEntries,
  resolveOrdinarySkillPrompt,
  captureOrdinarySkillPrompt,
  ordinaryWorkspaceSkillEntries,
  freezeOrdinarySkillCommand,
} from '../ordinary-composer-skills.js';
import { EventStore } from '../event-store.js';
import { assembleCommandPrompt } from '../message-reply-context.js';
import * as registries from '../skill-registry-runtime.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) cleanup();
});
it('freezes native passthrough and commands queued before skill-context capture', () => {
  const { registry, skill } = fixture();
  const store = new EventStore(':memory:');
  cleanups.push(() => store.close());
  store.upsertSession({ sessionId: 'chat' });
  const text = '/native-only question';
  expect(captureOrdinarySkillPrompt(store, 'chat', 'new', text, registry)).toBe(text);
  expect(store.getOrdinarySkillContext('chat', 'new')).toEqual({ text, prompt: text });
  vi.spyOn(store, 'getSendCommand').mockReturnValue({
    clientMsgId: 'old',
    sessionId: 'chat',
    payload: { text },
    error: null,
  });
  skill('native-only', 'New replacement instructions');
  registry.invalidate();
  expect(captureOrdinarySkillPrompt(store, 'chat', 'new', text, registry)).toBe(text);
  expect(captureOrdinarySkillPrompt(store, 'chat', 'old', text, registry)).toBe(text);
});
it('rolls back a rejected command together with its skill decision', () => {
  const { registry } = fixture();
  vi.spyOn(registries, 'buildSkillRegistry').mockReturnValue(registry);
  const store = new EventStore(':memory:');
  cleanups.push(() => store.close());
  expect(() =>
    freezeOrdinarySkillCommand(
      store,
      { sessionId: 'rejected', cwd: '/task' },
      'command',
      { text: '/mockup dashboard' },
      () => {
        store.upsertSession({ sessionId: 'rejected' });
        throw Error('Admission refused');
      },
    ),
  ).toThrow('Admission refused');
  expect(store.getSession('rejected')).toBeNull();
  expect(store.getOrdinarySkillContext('rejected', 'command')).toBeUndefined();
});

it('qualifies the selected ready host workspace before loading its repository overrides', async () => {
  const { registry } = fixture();
  vi.spyOn(registries, 'buildSkillRegistry').mockReturnValue(registry);
  const record = { state: 'ready', binding: { accountId: 'work' } };
  const service = {
    get: vi.fn(() => record),
    readPreparedHostSource: vi.fn(
      async (_id: string, _binding: unknown, read: (directory: string) => unknown) =>
        read('/selected/source'),
    ),
  };
  expect(
    await ordinaryWorkspaceSkillEntries(
      service as never,
      'workspace',
      () => record.binding as never,
    ),
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: 'restricted', unavailableReason: expect.any(String) }),
    ]),
  );
  expect(service.readPreparedHostSource).toHaveBeenCalledWith(
    'workspace',
    record.binding,
    expect.any(Function),
  );
  expect(registries.buildSkillRegistry).toHaveBeenCalledWith('/selected/source');
  service.readPreparedHostSource.mockRejectedValueOnce(Error('Changed workspace'));
  await expect(
    ordinaryWorkspaceSkillEntries(service as never, 'workspace', () => record.binding as never),
  ).rejects.toThrow();
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ordinary-skills-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  function skill(name: string, body: string, frontmatter = '') {
    mkdirSync(join(root, name), { recursive: true });
    writeFileSync(
      join(root, name, 'SKILL.md'),
      `---\ndescription: ${name} skill\n${frontmatter}---\n${body}`,
    );
  }
  skill('mockup', 'Create a mockup for $ARGUMENTS');
  skill('restricted', 'Read only', 'allowed-tools:\n  - Read\n');
  skill('scalar-restricted', 'Read only', 'allowed-tools: Read\n');
  skill('alias', 'Use the helper', 'requires-skills:\n  - restricted\n');
  return { registry: new SkillRegistry({ bundledDir: root }), skill };
}
it('renders supported skills and arguments while refusing tool ceilings, aliases and controller commands', () => {
  const { registry } = fixture();
  expect(resolveOrdinarySkillPrompt('/mockup a dashboard', registry)).toContain(
    'Create a mockup for a dashboard',
  );
  expect(resolveOrdinarySkillPrompt('normal prompt', registry)).toBeUndefined();
  expect(() => resolveOrdinarySkillPrompt('/restricted', registry)).toThrow(/tool restrictions/i);
  expect(() => resolveOrdinarySkillPrompt('/scalar-restricted', registry)).toThrow(
    /tool restrictions/i,
  );
  expect(resolveOrdinarySkillPrompt('/Users/example/source.ts', registry)).toBeUndefined();
  expect(() => resolveOrdinarySkillPrompt('/alias', registry)).toThrow(/tool restrictions/i);
  expect(() => resolveOrdinarySkillPrompt('/models', registry)).toThrow(/Chat settings/);
  // Native runtime skills have their own catalogue. Do not intercept their names.
  expect(resolveOrdinarySkillPrompt('/native-only use its native skill', registry)).toBeUndefined();
  expect(ordinarySkillEntries(registry)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: 'mockup', unavailableReason: undefined }),
      expect.objectContaining({
        name: 'restricted',
        unavailableReason: expect.stringMatching(/tool restrictions/i),
      }),
      expect.objectContaining({
        name: 'alias',
        unavailableReason: expect.stringMatching(/tool restrictions/i),
      }),
    ]),
  );
});
it('freezes the provider prompt for recovery without changing the original command', () => {
  const { registry, skill } = fixture();
  const store = new EventStore(':memory:');
  cleanups.push(() => store.close());
  store.upsertSession({ sessionId: 'chat' });
  const text = '/mockup a dashboard';
  const first = captureOrdinarySkillPrompt(store, 'chat', 'command', text, registry);
  for (let i = 0; i < 520; i++)
    store.append('chat', 'ordinary_skill_context', {
      messageId: `other-${i}`,
      text,
      prompt: 'Other skill',
    });
  skill('mockup', 'Changed body');
  registry.invalidate();
  expect(captureOrdinarySkillPrompt(store, 'chat', 'command', text, registry)).toBe(first);
  expect(store.getOrdinarySkillContext('chat', 'command')).toEqual({ text, prompt: first });
  expect(() =>
    captureOrdinarySkillPrompt(store, 'chat', 'command', '/mockup different', registry),
  ).toThrow(/changed/);
  expect(text).toBe('/mockup a dashboard');
});
it('expands only ordinary host skills at final prompt assembly, retaining original user text', () => {
  const { registry } = fixture();
  vi.spyOn(registries, 'buildSkillRegistry').mockReturnValue(registry);
  const store = new EventStore(':memory:');
  cleanups.push(() => store.close());
  store.upsertSession({ sessionId: 'chat', cwd: '/host/task' });
  const binding = vi
    .spyOn(store, 'getSessionRuntimeBinding')
    .mockReturnValue({ version: 2, execution: { location: 'local' } } as never);
  const payload = { text: '/mockup a dashboard' };
  expect(assembleCommandPrompt(store, 'chat', 'first', payload)).toContain(
    'Create a mockup for a dashboard',
  );
  expect(payload.text).toBe('/mockup a dashboard');
  binding.mockReturnValue({ version: 2, execution: { location: 'openshell' } } as never);
  expect(assembleCommandPrompt(store, 'chat', 'remote', payload)).toBe(payload.text);
  binding.mockReturnValue(undefined);
  expect(assembleCommandPrompt(store, 'chat', 'legacy', payload)).toBe(payload.text);
});
