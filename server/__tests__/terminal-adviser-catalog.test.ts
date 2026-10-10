import { expect, it } from 'vitest';
import { terminalAdviserCatalog } from '../terminal-adviser-catalog.js';
it('offers only Gemini thinking modes supported by the text-only adviser adapter', () => {
  const accounts = terminalAdviserCatalog([
    {
      id: 'google',
      provider: 'google-vertex',
      models: [
        {
          id: 'gemini-3-flash-preview',
          reasoningEfforts: ['minimal', 'low', 'medium', 'high', 'xhigh'],
        },
        { id: 'gemini-2.5-pro', reasoningEfforts: ['none', 'low', 'high'] },
        { id: 'gemini-2.0-flash', reasoningEfforts: ['low', 'high'] },
      ],
    },
    {
      id: 'work',
      provider: 'openai',
      models: [{ id: 'gpt-6-luna', reasoningEfforts: ['low', 'high'] }],
    },
    { id: 'personal', provider: 'openai-codex', models: [{ id: 'gpt-6-luna' }] },
  ]);
  expect(accounts).toHaveLength(2);
  expect(accounts[0].models.map((model) => model.reasoningEfforts)).toEqual([
    ['low', 'medium', 'high'],
    ['low', 'high'],
    [],
  ]);
  expect(accounts[1].models[0].reasoningEfforts).toEqual(['low', 'high']);
});
