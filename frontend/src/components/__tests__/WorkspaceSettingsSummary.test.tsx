// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { WorkspaceControls } from '../WorkspaceControls';
import type { WorkspaceSummary } from '../../types/workspace';
import { AccountModelPicker } from '../AccountModelPicker';
import { apiFetch } from '../../lib/api-fetch';

vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const models = [
  { id: 'luna', label: 'Luna', reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'low' },
  { id: 'sonnet', label: 'Sonnet 5' },
];
const metadata = {
  accountBinding: { accountId: 'work', accountLabel: 'Work Vertex', model: 'sonnet' },
  modelSelection: { model: 'luna', reasoningEffort: 'high', models },
};
function Harness({ sessionId = 'saved' }: { sessionId?: string | null }) {
  const [summary, setSummary] = useState<WorkspaceSummary | null>(null);
  return (
    <WorkspaceControls status="Ready" summary={summary}>
      <AccountModelPicker
        sessionId={sessionId}
        preferredModel="wrong"
        onChange={() => {}}
        onSummaryChange={setSummary}
      />
    </WorkspaceControls>
  );
}
function toggle() {
  return screen.getByRole('button', { name: /Workspace controls/ });
}

it('shows the restored profile, current model and thinking without expanding settings', async () => {
  vi.mocked(apiFetch).mockResolvedValue({ ok: true, json: async () => metadata } as Response);
  render(<Harness />);
  expect(await within(toggle()).findByText('Work Vertex')).toBeTruthy();
  expect(within(toggle()).getByText('Luna')).toBeTruthy();
  expect(within(toggle()).getByText('Thinking: high')).toBeTruthy();
  expect(toggle().getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByRole('combobox')).toBeNull();
});

it('keeps the summary in sync with model, thinking and profile alias edits', async () => {
  vi.mocked(apiFetch).mockImplementation(
    async (path) =>
      ({
        ok: true,
        json: async () => (String(path).endsWith('/alias') ? { label: 'Personal' } : metadata),
      }) as Response,
  );
  render(<Harness />);
  await within(toggle()).findByText('Luna');
  fireEvent.click(toggle());
  fireEvent.change(screen.getByLabelText('Thinking'), { target: { value: '' } });
  expect(await within(toggle()).findByText('Thinking: model default')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'sonnet' } });
  expect(await within(toggle()).findByText('Sonnet 5')).toBeTruthy();
  expect(within(toggle()).getByText('Thinking: not configurable')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Edit account alias' }));
  fireEvent.change(screen.getByLabelText('Account alias'), { target: { value: 'Personal' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save alias' }));
  expect(await within(toggle()).findByText('Personal')).toBeTruthy();
  fireEvent.click(toggle());
  expect(within(toggle()).getByText('Sonnet 5')).toBeTruthy();
});

it('clears the previous profile while switching sessions and reports unavailable metadata', async () => {
  vi.mocked(apiFetch)
    .mockResolvedValueOnce({ ok: true, json: async () => metadata } as Response)
    .mockResolvedValueOnce({ ok: false } as Response);
  const { rerender } = render(<Harness />);
  await within(toggle()).findByText('Work Vertex');
  rerender(<Harness sessionId="other" />);
  await waitFor(() => expect(within(toggle()).queryByText('Work Vertex')).toBeNull());
  expect(await within(toggle()).findByText('Profile unavailable')).toBeTruthy();
  expect(within(toggle()).queryByText('Luna')).toBeNull();
});

it('shows a fixed binding without inventing its thinking setting', async () => {
  vi.mocked(apiFetch).mockResolvedValue({
    ok: true,
    json: async () => ({ accountBinding: metadata.accountBinding }),
  } as Response);
  render(<Harness />);
  expect(await within(toggle()).findByText('Work Vertex')).toBeTruthy();
  expect(within(toggle()).getByText('Model unknown')).toBeTruthy();
  expect(within(toggle()).queryByText('sonnet')).toBeNull();
  expect(within(toggle()).getByText('Thinking: unknown')).toBeTruthy();
});

it('does not present a preferred model as the actual model of a legacy session', async () => {
  vi.mocked(apiFetch).mockResolvedValue({ ok: true, json: async () => ({}) } as Response);
  render(<Harness />);
  expect(await within(toggle()).findByText('Legacy account')).toBeTruthy();
  expect(within(toggle()).queryByText('wrong')).toBeNull();
  expect(within(toggle()).getByText('Model unknown')).toBeTruthy();
});

it('updates the visible account summary when choosing a profile for a new chat', async () => {
  vi.mocked(apiFetch).mockResolvedValue({
    ok: true,
    json: async () => [
      { id: 'work', label: 'Work Vertex', models },
      { id: 'personal', label: 'Personal', models: [models[1]] },
    ],
  } as Response);
  render(<Harness sessionId={null} />);
  await within(toggle()).findByText('Work Vertex');
  fireEvent.click(toggle());
  fireEvent.change(screen.getByLabelText('Account'), { target: { value: 'personal' } });
  expect(await within(toggle()).findByText('Personal')).toBeTruthy();
  expect(within(toggle()).getByText('Sonnet 5')).toBeTruthy();
});

it('restores the summary after refreshing an unchanged model catalog', async () => {
  vi.mocked(apiFetch).mockResolvedValue({ ok: true, json: async () => metadata } as Response);
  render(<Harness />);
  await within(toggle()).findByText('Work Vertex');
  fireEvent.click(toggle());
  fireEvent.click(screen.getByRole('button', { name: 'Refresh models' }));
  await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
  expect(await within(toggle()).findByText('Work Vertex')).toBeTruthy();
  expect(within(toggle()).getByText('Thinking: high')).toBeTruthy();
});

it('reports persisted thinking even when the catalog has no configurable thinking list', async () => {
  vi.mocked(apiFetch).mockResolvedValue({
    ok: true,
    json: async () => ({
      ...metadata,
      modelSelection: { model: 'sonnet', reasoningEffort: 'high', models },
    }),
  } as Response);
  render(<Harness />);
  expect(await within(toggle()).findByText('Thinking: high')).toBeTruthy();
  expect(within(toggle()).getByText('Sonnet 5')).toBeTruthy();
  fireEvent.click(toggle());
  fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'luna' } });
  expect(await within(toggle()).findByText('Thinking: low')).toBeTruthy();
});

it('uses the profile as the header title without repeating a generic workspace heading', async () => {
  vi.mocked(apiFetch).mockResolvedValue({ ok: true, json: async () => metadata } as Response);
  render(<Harness />);
  await within(toggle()).findByText('Work Vertex');
  expect(within(toggle()).queryByText('Workspace')).toBeNull();
});
