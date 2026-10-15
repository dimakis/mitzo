// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AgentToolsEditor } from '../AgentToolsEditor';
const tools = [
  {
    id: 'mitzo:Read',
    version: 1,
    name: 'Read',
    description: 'Read files',
    source: 'Workspace',
    required: false,
    behavior: 'read' as const,
    routes: ['local-api'],
    requirement: 'Workspace permissions apply',
  },
  {
    id: 'mitzo:ConnectionRequest',
    version: 1,
    name: 'ConnectionRequest',
    description: 'Request data',
    source: 'Connections',
    required: false,
    behavior: 'mixed' as const,
    routes: ['local-api'],
    requirement: 'Requires a configured connection and approval',
  },
  {
    id: 'mitzo:AskUserQuestion',
    version: 1,
    name: 'AskUserQuestion',
    description: 'Ask',
    source: 'Platform',
    required: true,
    behavior: 'interaction' as const,
    routes: ['local-api'],
    requirement: 'Questions grant no access',
  },
];
afterEach(cleanup);
it('makes legacy and explicit empty semantics visible, searches tools, and adds only a portable reference', () => {
  const change = vi.fn();
  const { rerender } = render(
    <AgentToolsEditor tools={tools} value={undefined} onChange={change} disabled={false} />,
  );
  expect(screen.getByText(/legacy.*catalog/i)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Choose specific tools' }));
  expect(change).toHaveBeenLastCalledWith([]);
  rerender(<AgentToolsEditor tools={tools} value={[]} onChange={change} disabled={false} />);
  expect(screen.getByText(/no optional tools/i)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Add tools' }));
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search tools' }), {
    target: { value: 'connection' },
  });
  expect(screen.queryByRole('button', { name: 'Add Read' })).toBeNull();
  expect(screen.getByText(/configured connection and approval/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Add ConnectionRequest' }));
  expect(change).toHaveBeenLastCalledWith([{ id: 'mitzo:ConnectionRequest', version: 1 }]);
});
it('removes optional references and keeps required platform tools visible', () => {
  const change = vi.fn();
  render(
    <AgentToolsEditor
      tools={tools}
      value={[{ id: 'mitzo:Read', version: 1 }]}
      onChange={change}
      disabled={false}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Remove Read' }));
  expect(change).toHaveBeenCalledWith([]);
  expect(screen.getByText(/required platform tools/i)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Remove AskUserQuestion' })).toBeNull();
});
