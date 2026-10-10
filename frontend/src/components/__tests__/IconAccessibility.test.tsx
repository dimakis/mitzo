// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ChatInput } from '../ChatInput';
import { ContextPanel } from '../ContextPanel';
import { ContextPicker } from '../ContextPicker';
import { ProgressWidget } from '../ProgressWidget';
import { TodoCard } from '../TodoCard';
import { TelosSection } from '../TelosSection';
import { SessionBanner } from '../SessionBanner';
import { MarkdownPreviewCard } from '../MarkdownPreviewCard';
import { HtmlPreviewCard } from '../HtmlPreviewCard';
import type { TodoItem } from '../../types/todo';

vi.mock('../SlashPicker', () => ({ SlashPicker: () => null }));
vi.mock('../SessionTray', () => ({ SessionTray: () => null }));
const outcomes: TodoItem[] = [];
vi.mock('../../hooks/useTodoData', () => ({
  useTodoData: () => ({
    loading: false,
    error: null,
    items: outcomes,
    profiles: [],
    ack: vi.fn(),
    done: vi.fn(),
    create: vi.fn(),
    refresh: vi.fn(),
  }),
}));

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        contextBlocks: { guide: { path: '/context/guide.md', sizeBytes: 100 } },
        content: 'Preview content',
      }),
    }),
  );
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  outcomes.length = 0;
  vi.unstubAllGlobals();
});

it('names queued-message removal and removes only the selected message', () => {
  localStorage.setItem(
    'mitzo-queue-new',
    JSON.stringify([
      { text: 'First queued draft', contextBlocks: [] },
      { text: 'Second queued draft', contextBlocks: [] },
    ]),
  );
  render(<ChatInput running onSend={() => true} onStop={vi.fn()} />);
  expect(screen.getByRole('button', { name: 'Remove queued message 2' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Remove queued message 1' }));
  expect(screen.queryByText('First queued draft')).toBeNull();
  expect(screen.getByText('Second queued draft')).toBeTruthy();
});

it('exposes controlled context selection in the panel', () => {
  const onToggle = vi.fn();
  const props = {
    loaded: true,
    blocks: [{ name: 'guide', path: '/context/guide.md', sizeBytes: 100 }],
    onToggle,
  };
  const view = render(<ContextPanel {...props} selected={['guide']} />);
  fireEvent.click(screen.getByRole('button', { name: /guide/, pressed: true }));
  expect(onToggle).toHaveBeenCalledWith('guide');
  view.rerender(<ContextPanel {...props} selected={[]} />);
  expect(screen.getByRole('button', { name: /guide/, pressed: false })).toBeTruthy();
});

it('exposes controlled context selection in the picker', async () => {
  const props = { onToggle: vi.fn(), onClose: vi.fn() };
  const view = render(<ContextPicker {...props} selected={['guide']} />);
  expect(await screen.findByRole('button', { name: /guide/, pressed: true })).toBeTruthy();
  view.rerender(<ContextPicker {...props} selected={[]} />);
  expect(screen.getByRole('button', { name: /guide/, pressed: false })).toBeTruthy();
});

it('exposes every progress item status independently of its decorative SVG', () => {
  render(
    <ProgressWidget
      items={[
        { id: 'pending', title: 'Prepare notes', status: 'pending' },
        { id: 'working', title: 'Review notes', status: 'in_progress' },
        { id: 'done', title: 'Save notes', status: 'done' },
      ]}
    />,
  );
  for (const status of ['pending', 'in progress', 'done']) {
    expect(screen.getByRole('img', { name: `Status: ${status}` })).toBeTruthy();
  }
});

function outcome(status: TodoItem['status'], starred = false): TodoItem {
  return {
    id: status,
    summary: 'Prepare the review',
    status,
    starred,
    profile: 'work',
    urgency: 0.8,
    ageDays: 0,
    parentId: null,
    children: [],
    childCount: 0,
    completedChildCount: 0,
    sources: [],
    links: [],
    goalId: null,
    contextHints: {
      repos: [],
      paths: [],
      issues: [],
      docIds: [],
      people: [],
      jiraKeys: [],
      keywords: [],
      taskHint: '',
    },
  };
}

it.each(['active', 'acknowledged', 'snoozed', 'completed'] as const)(
  'exposes outcome status %s',
  (status) => {
    render(
      <TodoCard
        item={outcome(status)}
        onAck={vi.fn()}
        onDone={vi.fn()}
        onTap={vi.fn()}
        onAddChild={vi.fn()}
        onStar={vi.fn()}
        onStartSession={vi.fn()}
      />,
    );
    expect(screen.getByRole('img', { name: `Status: ${status}` })).toBeTruthy();
  },
);

it('keeps both pinning and outcome status accessible in the focus card', () => {
  outcomes.push(outcome('active', true));
  render(
    <MemoryRouter>
      <TelosSection />
    </MemoryRouter>,
  );
  expect(screen.getByRole('img', { name: 'Pinned; Status: active' })).toBeTruthy();
});

it.each([
  ['session context', <SessionBanner sessionContext="Selected project context" />],
  ['Markdown preview', <MarkdownPreviewCard filePath="notes.md" />],
  ['HTML preview', <HtmlPreviewCard filePath="preview.html" />],
] as const)('exposes collapsed and expanded state for %s', async (_name, component) => {
  render(<MemoryRouter>{component}</MemoryRouter>);
  const control = screen.getByRole('button', { expanded: false });
  fireEvent.click(control);
  expect(await screen.findByRole('button', { expanded: true })).toBe(control);
});
