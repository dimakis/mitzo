// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import type { SymposiumProfileRecipe } from '@mitzo/protocol';
import { SymposiumProfileRecipeEditor } from '../SymposiumProfileRecipeEditor';
afterEach(cleanup);
it('allows an existing recipe to opt into personal Claude without changing its other providers', () => {
  const save = vi.fn();
  function Editor() {
    const [value, setValue] = useState<SymposiumProfileRecipe>({
      version: 1,
      context: { include: ['task'], sources: ['workspace'] },
      skillRefs: [],
      toolDefaults: { mode: 'read-only', preferredTools: [] },
      compatibleProviders: ['anthropic-vertex'],
      reviewerTemplate: 'general',
    });
    return (
      <SymposiumProfileRecipeEditor
        value={value}
        onChange={(next) => {
          save(next);
          if (next) setValue(next);
        }}
      />
    );
  }
  render(<Editor />);
  const checkbox = screen.getByRole('checkbox', { name: 'Claude subscription' });
  expect(checkbox).toHaveProperty('checked', false);
  fireEvent.click(checkbox);
  expect(save).toHaveBeenLastCalledWith(
    expect.objectContaining({ compatibleProviders: ['anthropic-vertex', 'anthropic-claude'] }),
  );
  fireEvent.click(checkbox);
  expect(save).toHaveBeenLastCalledWith(
    expect.objectContaining({ compatibleProviders: ['anthropic-vertex'] }),
  );
});
