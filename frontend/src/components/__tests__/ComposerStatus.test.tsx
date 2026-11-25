// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import {
  ComposerStatusProvider,
  ComposerStatusRail,
  ComposerStatusNotice,
} from '../ComposerStatus';
import { ChatStatusMessage } from '../ChatStatusMessage';
import {
  ConversationAgentsPanelContext,
  type ConversationAgentsPanel,
} from '../../lib/conversation-agents-panel';

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.removeAttribute('open');
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('keeps one mounted summary while notices change and exposes every action in details', () => {
  const retry = vi.fn();
  function Fixture({ error }: { error?: string }) {
    return (
      <ComposerStatusProvider>
        <ChatStatusMessage status="Connecting to a very long provider name" busy />
        <ChatStatusMessage error={error} action={{ label: 'Retry correction', onClick: retry }} />
        <ComposerStatusRail running />
        <textarea aria-label="Next draft" defaultValue="Keep this draft" />
      </ComposerStatusProvider>
    );
  }
  const view = render(<Fixture />);
  const rail = screen.getByRole('region', { name: 'Conversation status' });
  view.rerender(<Fixture error="Correction delivery failed" />);
  expect(screen.getByRole('region', { name: 'Conversation status' })).toBe(rail);
  expect(within(rail).getByRole('alert').textContent).toContain('Correction delivery failed');
  expect(within(rail).getByRole('button', { name: 'Retry correction' })).toBeTruthy();
  fireEvent.click(within(rail).getByRole('button', { name: 'Conversation status details' }));
  const dialog = screen.getByRole('dialog', { name: 'Conversation status' });
  expect(within(dialog).getByText('Connecting to a very long provider name')).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Retry correction' }));
  expect(retry).toHaveBeenCalledOnce();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
  expect(screen.getByLabelText('Next draft')).toHaveProperty('value', 'Keep this draft');
});

it('keeps equal-priority status sources in their mounted order when their content rerenders', () => {
  function Fixture({ count }: { count: number }) {
    return (
      <ComposerStatusProvider>
        <ComposerStatusNotice message="Checking original request">
          <span>Details {count}</span>
        </ComposerStatusNotice>
        <ComposerStatusNotice message="Refreshing agent activity" />
        <ComposerStatusRail />
      </ComposerStatusProvider>
    );
  }
  const h = render(<Fixture count={1} />);
  expect(screen.getByRole('status').textContent).toBe('Checking original request');
  h.rerender(<Fixture count={2} />);
  expect(screen.getByRole('status').textContent).toBe('Checking original request');
});

it('combines simultaneous problems and retains the remaining problem after one clears', () => {
  function Fixture({ first = true }: { first?: boolean }) {
    return (
      <ComposerStatusProvider>
        {first && <ComposerStatusNotice message="Approval required" tone="warning" />}
        <ComposerStatusNotice message="Draft not saved" tone="danger" />
        <ComposerStatusRail running />
      </ComposerStatusProvider>
    );
  }
  const view = render(<Fixture />);
  expect(screen.getByRole('alert').textContent).toBe('Needs attention · 2 issues');
  view.rerender(<Fixture first={false} />);
  expect(screen.getByRole('alert').textContent).toBe('Draft not saved');
});

it('opens the existing queued controls from the count without mounting another status row', () => {
  const edit = vi.fn();
  render(
    <ComposerStatusProvider>
      <ComposerStatusNotice message="Up next" queued={2}>
        <button onClick={edit}>Edit queued prompt</button>
      </ComposerStatusNotice>
      <ComposerStatusRail running />
    </ComposerStatusProvider>,
  );
  expect(screen.getByRole('status').textContent).toBe('Working');
  fireEvent.click(screen.getByRole('button', { name: '2 queued messages' }));
  fireEvent.click(screen.getByRole('button', { name: 'Edit queued prompt' }));
  expect(edit).toHaveBeenCalledOnce();
  expect(screen.getAllByRole('region', { name: 'Conversation status' })).toHaveLength(1);
});

it('retains standalone feedback when there is no composer to own the rail', () => {
  render(
    <ComposerStatusProvider>
      <ChatStatusMessage error="Failed admission" />
    </ComposerStatusProvider>,
  );
  expect(screen.getByRole('alert').textContent).toBe('Failed admission');
});

it('shows the existing approval state and returns to working after it clears', () => {
  const view = render(
    <ComposerStatusProvider>
      <ComposerStatusRail running awaitingApproval />
    </ComposerStatusProvider>,
  );
  expect(screen.getByRole('alert').textContent).toBe('Needs your approval');
  view.rerender(
    <ComposerStatusProvider>
      <ComposerStatusRail running />
    </ComposerStatusProvider>,
  );
  expect(screen.getByRole('status').textContent).toBe('Working');
});

function sharedPanel(canOpen: boolean, open = vi.fn()): ConversationAgentsPanel {
  return {
    scope: 'shared',
    active: true,
    canOpen,
    agents: [
      { id: 'architect', name: 'Architect', state: 'Working', activityState: 'working' },
      { id: 'reviewer', name: 'Reviewer', state: 'Idle' },
    ],
    register: () => () => {},
    open,
  };
}

it('keeps the conversation’s own sending and turn status beside the shared roster', () => {
  render(
    <ConversationAgentsPanelContext.Provider value={sharedPanel(true)}>
      <ComposerStatusProvider>
        <ChatStatusMessage status="Sending your message" busy />
        <ComposerStatusRail running />
      </ComposerStatusProvider>
    </ConversationAgentsPanelContext.Provider>,
  );
  const rail = screen.getByRole('region', { name: 'Conversation status' });
  // The live region announces only this conversation's own status, not the roster.
  expect(within(rail).getByRole('status').textContent).toBe('Working');
  const opener = within(rail).getByRole('button', { name: /^Open Agents,/ });
  expect(opener.getAttribute('aria-label')).toBe('Open Agents, 2 agents · 1 working');
  expect(within(opener).queryByRole('status')).toBeNull();
  expect(within(opener).queryByRole('alert')).toBeNull();
});

it('keeps a shared issue in the alert outside the Agents control', () => {
  render(
    <ConversationAgentsPanelContext.Provider value={sharedPanel(true)}>
      <ComposerStatusProvider>
        <ChatStatusMessage error="Delivery to Reviewer failed" />
        <ComposerStatusRail />
      </ComposerStatusProvider>
    </ConversationAgentsPanelContext.Provider>,
  );
  const rail = screen.getByRole('region', { name: 'Conversation status' });
  expect(within(rail).getByRole('alert').textContent).toBe('Delivery to Reviewer failed');
  expect(
    within(within(rail).getByRole('button', { name: /^Open Agents,/ })).queryByRole('alert'),
  ).toBeNull();
});

it('keeps its own running status when a peer needs attention and marks only the Agents summary', () => {
  const panel = sharedPanel(true);
  panel.agents = [
    ...panel.agents,
    { id: 'unavailable', name: 'Unavailable', state: 'Not observed', diagnostic: 'Unavailable' },
  ];
  render(
    <ConversationAgentsPanelContext.Provider value={panel}>
      <ComposerStatusProvider>
        <ComposerStatusRail running />
      </ComposerStatusProvider>
    </ConversationAgentsPanelContext.Provider>,
  );
  const rail = screen.getByRole('region', { name: 'Conversation status' });
  expect(rail.getAttribute('data-tone')).toBe('normal');
  expect(within(rail).getByRole('status').textContent).toBe('Working');
  const opener = within(rail).getByRole('button', { name: /^Open Agents,/ });
  expect(opener.getAttribute('data-attention')).toBe('true');
  expect(opener.getAttribute('aria-label')).toContain('1 need attention');
});

it('shows the shared roster without a dead Open Agents control when no panel can open', () => {
  const open = vi.fn();
  render(
    <ConversationAgentsPanelContext.Provider value={sharedPanel(false, open)}>
      <ComposerStatusProvider>
        <ComposerStatusRail />
      </ComposerStatusProvider>
    </ConversationAgentsPanelContext.Provider>,
  );
  const rail = screen.getByRole('region', { name: 'Conversation status' });
  expect(within(rail).queryByRole('button', { name: /^Open Agents/ })).toBeNull();
  expect(rail.textContent).toContain('Architect: Working; Reviewer: Idle');
  expect(open).not.toHaveBeenCalled();
});
