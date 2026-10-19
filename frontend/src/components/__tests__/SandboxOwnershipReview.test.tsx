// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SandboxOwnershipReview } from '../SandboxOwnershipReview';
import { readApiJson } from '../../lib/api-json-read';
vi.mock('../HomeDialog', () => ({
  HomeDialog: ({ children, title }: { children: ReactNode; title: string }) => (
    <section role="dialog" aria-label={title}>
      {children}
    </section>
  ),
}));
vi.mock('../../lib/api-json-read', () => ({ readApiJson: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const item = { id: 'physical', name: 'legacy', state: 'Stopped' };
function mount() {
  render(
    <MemoryRouter>
      <SandboxOwnershipReview item={item} onClose={() => {}} />
    </MemoryRouter>,
  );
}
it('shows exact saved provenance and recovery blockers without destructive controls', async () => {
  vi.mocked(readApiJson).mockResolvedValue({
    physical: item,
    owners: [
      { conversationId: 'archived', accountId: 'Work', ownerKind: 'ordinary', relation: 'runtime' },
    ],
    blockers: ['lifecycle_missing', 'checkpoint_unverified'],
    canDelete: false,
  });
  mount();
  expect((await screen.findByRole('link', { name: 'Open saved chat' })).getAttribute('href')).toBe(
    '/chat/archived',
  );
  expect(screen.getByText(/No managed lifecycle record/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Delete/ })).toBeNull();
});
it('fails closed on identity changes and supports a read-only retry', async () => {
  vi.mocked(readApiJson).mockResolvedValue({ physical: { ...item, id: 'replacement' } });
  mount();
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'Recheck ownership' }));
  expect(readApiJson).toHaveBeenCalledTimes(2);
});
