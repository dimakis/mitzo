// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { ToolPill } from '../ToolPill';
import { ChatArea } from '../ChatArea';
import { telosWorkerReceipt } from '../TelosWorkerReceiptCard';
import type { FinishedBlock } from '../../types/chat';

afterEach(cleanup);
const receipt = {
  version: 1,
  state: 'chat_ready',
  execution: 'not_started',
  workerConversationId: 'worker',
  workerPath: '/chat/worker',
  itemPath: '/todos/child',
  leadPath: '/chat/lead',
  attempt: {
    version: 1,
    requestId: 'request',
    attemptId: 'attempt',
    predecessorAttemptId: null,
    leadConversationId: 'lead',
    childItemId: 'child',
    contextSnapshotId: 'snapshot',
    state: 'chat_ready',
    workerConversationId: 'worker',
    allocationReceiptId: 'allocation',
    executionTaskId: 'task',
    accountingGoalId: null,
    turnCommandId: null,
  },
  workerDisplay: {
    title: 'Plan recording setup',
    profile: 'Research',
    account: 'Personal',
    model: 'Luna',
    thinking: 'High',
    target: 'Independent workspace',
  },
};
const block = (result = receipt): FinishedBlock => ({
  blockId: 'receipt',
  blockType: 'tool_use',
  content: '',
  toolName: 'TelosStartSlice',
  toolInput: JSON.stringify({ childItemId: 'child', requestId: 'request' }),
  toolResult: JSON.stringify(result),
});
function Location() {
  return <output data-testid="location">{useLocation().pathname}</output>;
}
it('renders the worker row in the lead transcript and navigates only after its link is activated', () => {
  render(
    <MemoryRouter initialEntries={['/chat/lead']}>
      <ToolPill block={block()} sessionId="lead" />
      <Location />
    </MemoryRouter>,
  );
  const link = screen.getByRole('link', { name: /Plan recording setup/ });
  expect(link.getAttribute('href')).toBe('/chat/worker');
  expect(link.querySelector('[data-icon="messagesSquare"]')).toBeTruthy();
  expect(link.querySelector('[data-icon="arrowUpRight"]')).toBeTruthy();
  expect(link.textContent).not.toContain('High');
  expect(screen.getByText(/Research · Personal · Luna · Independent workspace/)).toBeTruthy();
  expect(screen.getByText('Worker chat · created from this lead conversation')).toBeTruthy();
  expect(screen.queryByText(/Running|Completed|Work has not started/)).toBeNull();
  expect(screen.getByTestId('location').textContent).toBe('/chat/lead');
  expect(screen.queryByRole('button', { name: /execute|start work/i })).toBeNull();
  fireEvent.click(link);
  expect(screen.getByTestId('location').textContent).toBe('/chat/worker');
});
it('refuses wrong lead, child, worker, paths, malformed payload and failed tool results', () => {
  expect(telosWorkerReceipt(block(), 'other-lead')).toBeNull();
  expect(telosWorkerReceipt(block(), undefined)).toBeNull();
  for (const changed of [
    { itemPath: '/todos/other' },
    { workerPath: 'https://outside.test/chat/worker' },
    { leadPath: '/chat/other' },
    { workerConversationId: 'lead' },
    { attempt: { ...receipt.attempt, childItemId: 'other' }, itemPath: '/todos/other' },
    { attempt: { ...receipt.attempt, workerConversationId: 'other' } },
    { attempt: { ...receipt.attempt, state: 'requested' } },
  ])
    expect(telosWorkerReceipt(block({ ...receipt, ...changed }), 'lead')).toBeNull();
  expect(telosWorkerReceipt({ ...block(), toolResult: '{' }, 'lead')).toBeNull();
  expect(telosWorkerReceipt({ ...block(), toolError: true }, 'lead')).toBeNull();
  expect(telosWorkerReceipt({ ...block(), toolName: 'Bash' }, 'lead')).toBeNull();
});
it('keeps historical receipts useful without inventing display metadata', () => {
  const historical = { ...receipt, workerDisplay: undefined };
  render(
    <MemoryRouter>
      <ToolPill block={block(historical as typeof receipt)} sessionId="lead" />
    </MemoryRouter>,
  );
  expect(screen.getByRole('link', { name: /Worker conversation/ })).toBeTruthy();
  expect(screen.queryByText(/Research/)).toBeNull();
});

it('keeps native and actual Telos MCP receipts visible in the grouped transcript for request aliases', () => {
  for (const toolName of ['TelosStartSlice', 'mcp__telos__TelosStartSlice']) {
    const result = render(
      <MemoryRouter>
        <ChatArea
          sessionId="lead"
          messages={[
            {
              messageId: toolName,
              role: 'assistant',
              blocks: [
                {
                  ...block(),
                  toolName,
                  toolInput: JSON.stringify({ childItemId: 'child', requestId: 'retry-alias' }),
                },
                {
                  blockId: 'other',
                  blockType: 'tool_use',
                  content: '',
                  toolName: 'Read',
                  toolResult: 'ordinary result',
                },
              ],
            },
          ]}
          current={null}
          running={false}
          permission={null}
          onPermissionRespond={() => {}}
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: /Plan recording setup/ })).toBeTruthy();
    result.unmount();
  }
});
