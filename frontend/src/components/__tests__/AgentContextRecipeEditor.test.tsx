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
