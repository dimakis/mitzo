// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { StreamingBlock } from '../../types/chat';
import { ToolPill } from '../ToolPill';
import { ToolGroup } from '../ToolGroup';
import { AgentActivity } from '../AgentActivity';

afterEach(cleanup);
const tool = (patch: Partial<StreamingBlock> = {}): StreamingBlock => ({
  blockId: 'owned-tool',
  blockType: 'tool_use',
  content: '',
  done: false,
  toolName: 'Bash',
  toolInput: 'review the retained command',
  ...patch,
});
const wrap = (content: React.ReactNode) => <MemoryRouter>{content}</MemoryRouter>;

describe('interrupted tool consumers', () => {
  it('shows a neutral interrupted missing reply while retaining its real input disclosure', () => {
    const { container } = render(
      wrap(<ToolPill block={tool({ done: true, toolInterrupted: true })} />),
    );
    const toggle = screen.getByRole('button', { name: /Bash.*Interrupted/ });
    expect(container.querySelector('.tool-pill-dot--interrupted')).toBeTruthy();
    expect(
      container.querySelector(
        '.tool-pill--running,.tool-pill--done,.tool-pill--error,.tool-pill-dot--pending',
      ),
    ).toBeNull();
    expect(screen.queryByText(/Running|Failed/)).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('review the retained command', { selector: 'pre' })).toBeTruthy();
    expect(screen.queryByText('Result', { exact: true })).toBeNull();
  });
  it('overrides the web-specific request-in-progress label without inventing an access outcome', () => {
    render(
      wrap(
        <ToolPill
          block={tool({
            toolName: 'RequestWebAccess',
            toolInput: JSON.stringify({ operation: 'fetch', url: 'https://example.test/review' }),
            toolInterrupted: true,
          })}
        />,
      ),
    );
    expect(screen.getByRole('button', { name: /Website read.*Interrupted/ })).toBeTruthy();
    expect(
      screen.queryByText(/Request in progress|Access granted|Read complete|Failed/),
    ).toBeNull();
  });
  it.each([
    { toolResult: '', toolError: false },
    { toolResult: 'A real late reply', toolError: false },
    { toolResult: 'A real late failure', toolError: true },
    { toolResultImages: [{ id: 'late-image', mediaType: 'image/png' }], toolError: false },
  ])('keeps expansion and returns to the real outcome when a late reply arrives (%j)', (reply) => {
    const { rerender, container } = render(wrap(<ToolPill block={tool()} />));
    const toggle = screen.getByRole('button', { name: /Bash.*Running/ });
    fireEvent.click(toggle);
    rerender(wrap(<ToolPill block={tool({ done: true, toolInterrupted: true })} />));
    expect(screen.getByText('Interrupted', { exact: true })).toBeTruthy();
    rerender(wrap(<ToolPill block={tool({ toolInterrupted: true, ...reply })} />));
    expect(screen.queryByText('Interrupted', { exact: true })).toBeNull();
    expect(
      container.querySelector(reply.toolError ? '.tool-pill--error' : '.tool-pill--done'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: /Bash/ }).getAttribute('aria-expanded')).toBe('true');
  });
  it('counts real replies, interrupted calls and genuinely running calls independently', () => {
    const { container } = render(
      wrap(
        <ToolGroup
          tools={[
            tool({ blockId: 'ok', toolResult: 'ok' }),
            tool({ blockId: 'failed', toolResult: 'failure', toolError: true }),
            tool({ blockId: 'stopped', toolInterrupted: true }),
            tool({ blockId: 'live' }),
          ]}
        />,
      ),
    );
    expect(
      screen.getByRole('button', { name: /2\/4 complete · 1 running · 1 interrupted · 1 failed/ }),
    ).toBeTruthy();
    expect(container.querySelectorAll('.tool-pill-dot--pending').length).toBe(1);
    expect(container.querySelectorAll('.tool-pill-dot--interrupted').length).toBe(1);
  });
  it('does not label a group of missing interrupted replies complete or failed', () => {
    const { container } = render(
      wrap(
        <ToolGroup
          tools={[
            tool({ toolInterrupted: true }),
            tool({ blockId: 'second', toolInterrupted: true }),
          ]}
        />,
      ),
    );
    expect(screen.getByRole('button', { name: /2 tool calls · 2 interrupted/ })).toBeTruthy();
    expect(screen.queryByText(/complete|running|failed/i)).toBeNull();
    expect(container.querySelectorAll('.tool-pill-dot--interrupted').length).toBe(2);
  });
  it.each([false, true])(
    'stops interrupted Bash activity despite streaming row and block.done=%s, and retains focus restoration',
    (done) => {
      const block = tool({ done, toolInterrupted: true, toolError: true });
      render(
        wrap(
          <AgentActivity
            rows={[
              {
                key: 'owned',
                scope: 'original-seat',
                block,
                streaming: true,
                attribution: <span>Original seat</span>,
                value: <ToolPill block={block} />,
              },
            ]}
            replied={false}
          />,
        ),
      );
      const activity = screen.getByRole('button', { name: /^Activity:/ });
      expect(activity.textContent).toContain('Command interrupted');
      expect(activity.textContent).toContain('1 interrupted');
      expect(activity.getAttribute('aria-label')).not.toMatch(/Running|completed|failed/);
      expect(screen.getByText('Original seat')).toBeTruthy();
      screen.getByRole('button', { name: /Bash.*Interrupted/ }).focus();
      fireEvent.click(activity);
      expect(document.activeElement).toBe(activity);
      expect(activity.getAttribute('aria-expanded')).toBe('false');
    },
  );
  it('keeps a genuinely running delegate visible beside its interrupted parent tool', () => {
    const block = tool({
      toolInterrupted: true,
      subagent: {
        messageId: 'independent-delegate',
        running: true,
        blocks: new Map(),
        blockOrder: [],
      },
    });
    render(
      wrap(
        <AgentActivity
          rows={[
            {
              key: 'owned',
              scope: 'original-seat',
              block,
              streaming: true,
              value: <span>Retained delegated activity</span>,
            },
          ]}
          replied={false}
        />,
      ),
    );
    const activity = screen.getByRole('button', { name: /^Agents at work:/ });
    expect(activity.textContent).toContain('1 delegated · 1 running');
    expect(activity.textContent).toContain('1 interrupted');
    expect(activity.getAttribute('aria-label')).toContain('Running');
  });
});
