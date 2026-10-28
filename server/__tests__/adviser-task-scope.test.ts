import { expect, it, vi } from 'vitest';
import { AdviserTaskScope } from '../adviser-task-scope.js';

const input = () => ({
  authSessionId: 'operator',
  feature: { kind: 'terminal' as const, terminalId: 'terminal' },
  accountId: 'work',
  model: 'gpt-6-luna',
  reasoningEffort: 'low',
  instructions: 'Explain the reviewed text.',
  messages: [{ role: 'user' as const, content: 'Reviewed only' }],
});
it('freezes the complete reviewed snapshot and binds exact account, model and feature', () => {
  const raw = input();
  const current = vi.fn();
  const scope = new AdviserTaskScope(raw, current, new AbortController().signal);
  raw.messages[0].content = 'mutated';
  expect(scope.prompt()).toContain('Reviewed only');
  expect(scope.prompt()).not.toContain('mutated');
  expect(scope.instructions()).toBe(raw.instructions);
  scope.assertSelection({ accountId: 'work', model: 'gpt-6-luna' }, 'low');
  expect(() => scope.assertSelection({ accountId: 'other', model: 'gpt-6-luna' }, 'low')).toThrow();
  expect(() => scope.assertSelection({ accountId: 'work', model: 'other' }, 'low')).toThrow();
  expect(() => scope.assertSelection({ accountId: 'work', model: 'gpt-6-luna' }, 'high')).toThrow();
  expect(current).toHaveBeenCalled();
});
it('suppresses cancelled and revoked output and refuses oversized context', () => {
  const controller = new AbortController();
  const current = vi.fn();
  const scope = new AdviserTaskScope(input(), current, controller.signal);
  current.mockImplementation(() => {
    throw Error('revoked');
  });
  expect(() => scope.assertCurrent()).toThrow('revoked');
  controller.abort();
  expect(() => scope.assertCurrent()).toThrow();
  expect(
    () =>
      new AdviserTaskScope(
        {
          ...input(),
          messages: Array.from({ length: 13 }, () => ({ role: 'user' as const, content: 'x' })),
        },
        () => {},
        new AbortController().signal,
      ),
  ).toThrow();
});
it('bounds accumulated text and requires a nonempty successful response', () => {
  const scope = new AdviserTaskScope(input(), () => {}, new AbortController().signal);
  expect(() => scope.result('')).toThrow();
  expect(() => scope.result('x'.repeat(32769))).toThrow();
  expect(scope.result('Advice')).toEqual({ text: 'Advice' });
});
it('pins an independent publication review to its host operation', () => {
  const scope = new AdviserTaskScope(
    { ...input(), feature: { kind: 'github-publication', operationId: 'publication' } },
    () => {},
    new AbortController().signal,
  );
  expect(scope.feature()).toEqual({ kind: 'github-publication', operationId: 'publication' });
  expect(scope.sdkPolicy().tools).toEqual([]);
});
it('constrains SDK settings and every tool effect, including apparently safe reads', async () => {
  const scope = new AdviserTaskScope(input(), () => {}, new AbortController().signal);
  const settings = scope.sdkPolicy();
  expect(settings.tools).toEqual([]);
  expect(settings.settingSources).toEqual([]);
  expect(settings.mcpServers).toEqual({});
  expect(settings.hooks).toEqual({});
  const canUseTool = settings.canUseTool;
  if (!canUseTool) throw Error('Scoped SDK tool guard required');
  expect(
    await canUseTool(
      'Read',
      { file_path: '/private' },
      { signal: new AbortController().signal, toolUseID: 'scope-test-tool' },
    ),
  ).toMatchObject({
    behavior: 'deny',
  });
});
it('disables inherited native skills and projects only task directory reads', () => {
  const scope = new AdviserTaskScope(input(), () => {}, new AbortController().signal);
  expect(scope.codexConfig([{ path: '/private/SKILL.md' }])).toMatchObject({
    web_search: 'disabled',
    project_doc_max_bytes: 0,
    'skills.config': [{ path: '/private/SKILL.md', enabled: false }],
  });
  expect(() => scope.codexConfig([{ path: 'relative' }])).toThrow();
  expect(scope.nativeReadRoots('/task')).toEqual(['/task']);
});
