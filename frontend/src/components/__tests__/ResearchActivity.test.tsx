// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AgentActivity } from '../AgentActivity';
import { ChatArea } from '../ChatArea';
import type { ChatBlock } from '../../lib/groupMessages';

afterEach(cleanup);
const thought: ChatBlock = {
  blockId: 'reason',
  blockType: 'thinking',
  content: '**Exploring GitHub**\n\nSpeculative internal planning that should stay in details.',
};
const read: ChatBlock = {
  blockId: 'read',
  blockType: 'tool_use',
  content: '',
  toolId: 'read',
  toolName: 'RequestWebAccess',
  toolInput: JSON.stringify({
    operation: 'fetch',
    url: 'https://api.github.com/repos/example/project/issues',
  }),
  toolResult: 'External source (untrusted): records',
};

it('labels ordinary work as Activity and previews a clean reasoning heading', () => {
  render(
    <AgentActivity
      rows={[{ key: 'reason', scope: 'a', block: thought, value: <span>Reasoning detail</span> }]}
      replied={false}
    />,
  );
  const header = screen.getByRole('button', { name: /^Activity:/ });
  expect(header.textContent).toContain('Exploring GitHub');
  expect(header.textContent).not.toContain('**');
  expect(header.textContent).not.toContain('Speculative');
  expect(screen.queryByText('Agents at work')).toBeNull();
});

it('previews the latest tool rather than subsequent speculative reasoning', () => {
  render(
    <AgentActivity
      rows={[
        { key: 'read', scope: 'a', block: read, value: <span>Read detail</span> },
        { key: 'reason', scope: 'a', block: thought, value: <span>Reasoning detail</span> },
      ]}
      replied={false}
    />,
  );
  const header = screen.getByRole('button', { name: /^Activity:/ });
  expect(header.textContent).toContain('Website read');
  expect(header.textContent).toContain('https://api.github.com/repos/example/project/issues');
  expect(header.textContent).not.toContain('operation');
  expect(header.textContent).not.toContain('Speculative');
});

it('collapses reasoning and completed reads but keeps pending reads and errors visible', () => {
  render(
    <MemoryRouter>
      <ChatArea
        messages={[{ messageId: 'research', role: 'assistant', blocks: [thought, read] }]}
        current={null}
        running={false}
        permission={null}
        onPermissionRespond={() => {}}
      />
    </MemoryRouter>,
  );
  const activity = screen.getByRole('button', { name: /^Activity:/ });
  expect(activity.textContent).toContain('Website read');
  expect(screen.getByRole('button', { name: /^Thought/ }).getAttribute('aria-expanded')).toBe(
    'false',
  );
  expect(screen.queryByText(/Speculative internal/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /^Thought/ }));
  expect(screen.getByText(/Speculative internal/)).toBeTruthy();
  fireEvent.click(activity);
  expect(screen.queryByRole('button', { name: /^Website read/ })).toBeNull();
});

it.each([
  { ...read, toolResult: undefined },
  { ...read, toolResult: 'Website refused access', toolError: true },
  {
    ...read,
    toolInput: JSON.stringify({ operation: 'request_access', url: 'https://example.com' }),
  },
  { ...read, toolInput: JSON.stringify({ operation: 'search', query: 'Research' }) },
])('keeps unfinished, failed, access and search rows outside activity', (block) => {
  const { container } = render(
    <MemoryRouter>
      <ChatArea
        messages={[{ messageId: 'research', role: 'assistant', blocks: [thought, block] }]}
        current={null}
        running={false}
        permission={null}
        onPermissionRespond={() => {}}
      />
    </MemoryRouter>,
  );
  expect(
    container.querySelectorAll('.agent-activity .tool-pill:not(.tool-pill--thinking)'),
  ).toHaveLength(0);
  expect(container.querySelectorAll('.tool-pill:not(.tool-pill--thinking)')).toHaveLength(1);
});
