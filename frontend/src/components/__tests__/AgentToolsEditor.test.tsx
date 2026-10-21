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
it('distinguishes configured sources and retains the exact opaque discovery revision', () => {
  const change = vi.fn();
  const configured = ['one', 'two'].map((source, i) => ({
    ...tools[0],
    id: `mcp:${i}`,
    source,
    name: 'search',
    revision: '11111111-1111-4111-8111-111111111111',
  }));
  const { rerender } = render(
    <AgentToolsEditor tools={configured} value={[]} onChange={change} disabled={false} />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Add tools' }));
  fireEvent.click(screen.getByRole('button', { name: 'Add search from one' }));
  expect(change).toHaveBeenLastCalledWith([
    { id: 'mcp:0', version: 1, revision: configured[0].revision },
  ]);
  rerender(
    <AgentToolsEditor
      tools={configured}
      value={[{ id: 'mcp:0', version: 1, revision: '22222222-2222-4222-8222-222222222222' }]}
      onChange={change}
      disabled={false}
    />,
  );
  expect(screen.getByText(/missing from the installed catalog/i)).toBeTruthy();
});

it.each(['codex', 'codex-owned-local'])(
  'selects supported %s tools through the original editor without treating selection as access',
  (route) => {
    const change = vi.fn();
    const tool = {
      ...tools[0],
      id: 'mitzo:TaskStatus',
      name: 'TaskStatus',
      routes: [route],
      requirement: 'Original delegated task and permission required.',
    };
    render(
      <AgentToolsEditor
        tools={[
          tool,
          { ...tools[0], id: 'mitzo:Unsupported', name: 'Unsupported', routes: ['future-unknown'] },
        ]}
        value={[]}
        onChange={change}
        disabled={false}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add tools' }));
    expect(screen.getByRole('button', { name: 'Add TaskStatus' })).toHaveProperty(
      'disabled',
      false,
    );
    expect(screen.getByText(/Local Codex chats/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add Unsupported' })).toHaveProperty(
      'disabled',
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add TaskStatus' }));
    expect(change).toHaveBeenCalledWith([{ id: 'mitzo:TaskStatus', version: 1 }]);
    expect(screen.getByText(/Selection grants no access/)).toBeTruthy();
  },
);
