// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import type { AgentContextRecipe } from '@mitzo/protocol';
import { AgentContextRecipeEditor } from '../AgentContextRecipeEditor';
afterEach(cleanup);
function Editor({ disabled = false }: { disabled?: boolean }) {
  const [value, setValue] = useState<AgentContextRecipe>();
  return <AgentContextRecipeEditor value={value} onChange={setValue} disabled={disabled} />;
}
it('makes compilation opt-in and lets the author choose documents and a bounded budget', () => {
  render(<Editor />);
  expect(screen.queryByLabelText('Context source')).toBeNull();
  fireEvent.click(screen.getByLabelText('Compile chat context'));
  expect(screen.getByLabelText('Context source')).toHaveProperty('value', 'workspace');
  expect(screen.getByLabelText('Token budget')).toHaveProperty('value', '12000');
  fireEvent.change(screen.getByLabelText('Documents (one per line)'), {
    target: { value: 'docs/design.md\nREADME.md' },
  });
  expect(screen.getByLabelText('Documents (one per line)')).toHaveProperty(
    'value',
    'docs/design.md\nREADME.md',
  );
  fireEvent.click(screen.getByLabelText('Compile chat context'));
  expect(screen.queryByLabelText('Documents (one per line)')).toBeNull();
});
it('preserves spaces, separators and newlines during actual section-selector typing', async () => {
  render(<Editor />);
  fireEvent.click(screen.getByLabelText('Compile chat context'));
  const user = userEvent.setup();
  const field = screen.getByLabelText('Required sections (one per line)');
  await user.type(field, 'docs/design.md > Design > Architecture notes\n README.md ');
  expect(field).toHaveProperty(
    'value',
    'docs/design.md > Design > Architecture notes\n README.md ',
  );
});
it('selects a named preset without exposing a server URL, host path or permission setting', () => {
  render(<Editor />);
  fireEvent.click(screen.getByLabelText('Compile chat context'));
  fireEvent.change(screen.getByLabelText('Context source'), { target: { value: 'contexgin' } });
  fireEvent.change(screen.getByLabelText('ContexGin preset'), { target: { value: 'architect' } });
  expect(screen.getByLabelText('ContexGin preset')).toHaveProperty('value', 'architect');
  expect(screen.queryByLabelText('Token budget')).toBeNull();
  expect(screen.queryByLabelText(/server URL/i)).toBeNull();
});
it('disables compilation controls with the containing editor', () => {
  render(<Editor disabled />);
  expect(screen.getByLabelText('Compile chat context')).toHaveProperty('disabled', true);
});
it('selects immutable published pack revisions and leaves workspace choices available', async () => {
  const original = global.fetch;
  global.fetch = async () =>
    ({
      ok: true,
      json: async () => ({
        packs: [
          {
            revision: 2,
            hash: 'a'.repeat(64),
            definition: { id: 'mitzo-reviewer', name: 'Mitzo reviewer' },
          },
        ],
        drafts: [],
      }),
    }) as Response;
  try {
    render(<Editor />);
    fireEvent.click(screen.getByLabelText('Compile chat context'));
    fireEvent.change(screen.getByLabelText('Context source'), { target: { value: 'packs' } });
    expect(await screen.findByLabelText('Published context pack')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add pack revision' }));
    expect(screen.getByText(/mitzo-reviewer · revision 2/)).toBeTruthy();
    expect(screen.getByLabelText('Token budget')).toHaveProperty('value', '12000');
    fireEvent.change(screen.getByLabelText('Context source'), { target: { value: 'workspace' } });
    expect(screen.getByLabelText('Documents (one per line)')).toBeTruthy();
  } finally {
    global.fetch = original;
  }
});
it('resolves the selected historical pack name without upgrading its pin', async () => {
  const original = global.fetch;
  const onChange = () => {
    throw Error('Historical lookup must not change the recipe');
  };
  const hash = 'b'.repeat(64);
  global.fetch = async (input) =>
    ({
      ok: true,
      json: async () =>
        String(input).endsWith('/revisions/2')
          ? {
              pack: {
                id: 'review',
                revision: 2,
                hash,
                definition: { id: 'review', name: 'Previous reviewer' },
              },
            }
          : {
              packs: [
                {
                  id: 'review',
                  revision: 3,
                  hash: 'a'.repeat(64),
                  definition: { id: 'review', name: 'Latest reviewer' },
                },
              ],
              drafts: [],
            },
    }) as Response;
  try {
    render(
      <AgentContextRecipeEditor
        value={{
          version: 2,
          source: 'packs',
          packs: [{ id: 'review', revision: 2, hash }],
          tokenBudget: 4000,
        }}
        onChange={onChange}
      />,
    );
    expect(await screen.findByText('Previous reviewer · revision 2')).toBeTruthy();
  } finally {
    global.fetch = original;
  }
});
