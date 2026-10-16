// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { TelosWorkApiClient } from '@mitzo/client';
import { TelosItemSources } from '../TelosItemSources';
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const source = {
  version: 1,
  snapshotId: 'review',
  itemId: 'studio',
  source: { namespace: 'mitzo', conversationId: 'planning' },
  selection: { kind: 'selected', messageIds: ['approved'], blockIds: [], throughSequence: 2 },
  author: null,
  sourceCreatedAt: null,
  adoptedAt: '2026-10-16T10:00:00Z',
  artifacts: [],
  adoptedBrief: null,
};
function Path() {
  return <output>{useLocation().pathname + useLocation().search}</output>;
}
it('opens the recorded conversation and exact source selector, preserving unknown source dates', async () => {
  vi.spyOn(TelosWorkApiClient.prototype, 'read').mockResolvedValue({ sources: [source] } as never);
  vi.spyOn(TelosWorkApiClient.prototype, 'readSource').mockResolvedValue({
    available: true,
    sourceHref: '/chat/planning?telosItem=studio&telosSource=review',
  } as never);
  render(
    <MemoryRouter>
      <TelosItemSources itemId="studio" legacySources={[]} onOpenExternal={() => {}} />
      <Path />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Open original chat' }));
  await screen.findByText('/chat/planning?telosItem=studio&telosSource=review');
  expect(screen.getByText(/Source date unknown/)).toBeTruthy();
  expect(screen.queryByText('Lead')).toBeNull();
});
it('keeps unavailable retained sources visible and never starts a replacement chat', async () => {
  vi.spyOn(TelosWorkApiClient.prototype, 'read').mockResolvedValue({ sources: [source] } as never);
  vi.spyOn(TelosWorkApiClient.prototype, 'readSource').mockResolvedValue({
    available: false,
  } as never);
  render(
    <MemoryRouter>
      <TelosItemSources itemId="studio" legacySources={[]} onOpenExternal={() => {}} />
      <Path />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Open original chat' }));
  await screen.findByRole('alert');
  expect(
    screen.getByText('Original conversation unavailable. Retained sources are preserved.'),
  ).toBeTruthy();
  expect(screen.queryByText(/\/chat\/planning/)).toBeNull();
});
it('fences source lists when changing items and leaves legacy evidence intact', async () => {
  let finish!: (v: never) => void;
  vi.spyOn(TelosWorkApiClient.prototype, 'read')
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          finish = r;
        }),
    )
    .mockResolvedValue({ sources: [] } as never);
  const external = vi.fn();
  const legacy = {
    type: 'gdoc',
    title: 'Original notes',
    author: 'Dimitri',
    url: 'https://example.test/notes',
    snippet: 'Unchanged excerpt',
  };
  const surface = render(
    <MemoryRouter>
      <TelosItemSources itemId="old" legacySources={[]} onOpenExternal={external} />
    </MemoryRouter>,
  );
  surface.rerender(
    <MemoryRouter>
      <TelosItemSources itemId="new" legacySources={[legacy]} onOpenExternal={external} />
    </MemoryRouter>,
  );
  await screen.findByText('Unchanged excerpt');
  finish({ sources: [source] } as never);
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'Open original chat' })).toBeNull(),
  );
  fireEvent.click(screen.getByText('Original notes'));
  expect(external).toHaveBeenCalledWith(legacy.url);
});
it('opens a known legacy origin while keeping the unrecorded reviewed exchange unknown', async () => {
  vi.spyOn(TelosWorkApiClient.prototype, 'read').mockResolvedValue({
    sources: [],
    links: [
      {
        role: 'origin',
        conversation: { namespace: 'mitzo', conversationId: 'planning' },
        availability: 'available',
      },
    ],
  } as never);
  render(
    <MemoryRouter>
      <TelosItemSources itemId="studio" legacySources={[]} onOpenExternal={() => {}} />
      <Path />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Open original chat' }));
  await screen.findByText('/chat/planning');
  expect(screen.getByText('Reviewed exchange unknown')).toBeTruthy();
});

it('keeps a known legacy origin openable beside its unknown reviewed selection', async () => {
  vi.spyOn(TelosWorkApiClient.prototype, 'read').mockResolvedValue({
    sources: [{ ...source, selection: { kind: 'unknown' } }],
    links: [
      {
        role: 'origin',
        conversation: source.source,
        availability: 'available',
      },
    ],
  } as never);
  render(
    <MemoryRouter>
      <TelosItemSources itemId="studio" legacySources={[]} onOpenExternal={() => {}} />
      <Path />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Open original chat' }));
  await screen.findByText('/chat/planning');
  expect(screen.getAllByText('Reviewed exchange unknown').length).toBeGreaterThan(0);
  expect(screen.getByText(/Source date unknown/)).toBeTruthy();
});

it('shows one opener when the reviewed snapshot already opens its origin', async () => {
  vi.spyOn(TelosWorkApiClient.prototype, 'read').mockResolvedValue({
    sources: [source],
    links: [
      {
        role: 'origin',
        conversation: source.source,
        availability: 'available',
      },
    ],
  } as never);
  render(
    <MemoryRouter>
      <TelosItemSources itemId="studio" legacySources={[]} onOpenExternal={() => {}} />
    </MemoryRouter>,
  );
  await screen.findByRole('button', { name: 'Open original chat' });
  expect(screen.getAllByRole('button', { name: 'Open original chat' })).toHaveLength(1);
  expect(screen.queryByText('Reviewed exchange unknown')).toBeNull();
});

it('retains the external origin opener without treating it as a Mitzo conversation', async () => {
  const external = vi.fn();
  const conversation = {
    namespace: 'external_codex',
    conversationId: 'external-planning',
    url: 'codex://threads/external-planning',
  };
  vi.spyOn(TelosWorkApiClient.prototype, 'read').mockResolvedValue({
    sources: [{ ...source, source: conversation, selection: { kind: 'unknown' } }],
    links: [{ role: 'origin', conversation, availability: 'unknown' }],
  } as never);
  const readSource = vi.spyOn(TelosWorkApiClient.prototype, 'readSource');
  render(
    <MemoryRouter initialEntries={['/todos/studio']}>
      <TelosItemSources itemId="studio" legacySources={[]} onOpenExternal={external} />
      <Path />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Open original chat' }));
  expect(external).toHaveBeenCalledWith(conversation.url);
  expect(readSource).not.toHaveBeenCalled();
  expect(screen.getByText('/todos/studio')).toBeTruthy();
});

it('keeps an unavailable legacy origin visible and disabled beside its unknown selection', async () => {
  vi.spyOn(TelosWorkApiClient.prototype, 'read').mockResolvedValue({
    sources: [{ ...source, selection: { kind: 'unknown' } }],
    links: [
      {
        role: 'origin',
        conversation: source.source,
        availability: 'unavailable',
      },
    ],
  } as never);
  const readSource = vi.spyOn(TelosWorkApiClient.prototype, 'readSource');
  render(
    <MemoryRouter initialEntries={['/todos/studio']}>
      <TelosItemSources itemId="studio" legacySources={[]} onOpenExternal={() => {}} />
      <Path />
    </MemoryRouter>,
  );
  const opener = (await screen.findByRole('button', {
    name: 'Open original chat',
  })) as HTMLButtonElement;
  expect(opener.disabled).toBe(true);
  fireEvent.click(opener);
  expect(readSource).not.toHaveBeenCalled();
  expect(screen.getByText('/todos/studio')).toBeTruthy();
});
