import { MemoryRouter } from 'react-router-dom';
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { BackupsView } from '../BackupsView';
import { getBackups, backupAction } from '../../lib/backups-api';
import type { BackupOverview } from '@mitzo/protocol';
vi.mock('../../lib/backups-api', () => ({ getBackups: vi.fn(), backupAction: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const view: BackupOverview = {
  ready: true,
  busy: false,
  setup: [],
  runs: [],
  lastCapture: null,
  lastCloudUpload: null,
  coverage: [
    { name: 'Mitzo and Telos', supported: true, detail: 'Core stores' },
    { name: 'LifeOps', supported: false, detail: 'Vault not captured' },
  ],
};
it('blocks backups until setup is ready and names uncovered stores', async () => {
  vi.mocked(getBackups).mockResolvedValue({
    ...view,
    ready: false,
    setup: ['Confirm independent recovery.'],
  });
  render(
    <MemoryRouter>
      <BackupsView />
    </MemoryRouter>,
  );
  await screen.findByText('Confirm independent recovery.');
  expect((screen.getByRole('button', { name: 'Back up now' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect(screen.getByText('Vault not captured')).toBeTruthy();
  expect(backupAction).not.toHaveBeenCalled();
});
it('submits manual actions once and distinguishes pending upload from cloud protection', async () => {
  vi.mocked(getBackups).mockResolvedValue({
    ...view,
    runs: [
      {
        id: 'run',
        startedAt: '2026-10-06T12:00:00Z',
        status: 'pending',
        generation: 'generation',
        bytes: 1024,
      },
    ],
  });
  vi.mocked(backupAction).mockResolvedValue();
  render(
    <MemoryRouter>
      <BackupsView />
    </MemoryRouter>,
  );
  await screen.findByText('Waiting for iCloud');
  expect(screen.getByText('No confirmed upload')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Back up now' }));
  await waitFor(() => expect(backupAction).toHaveBeenCalledWith('run'));
  expect(backupAction).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Check iCloud upload' }));
  await waitFor(() => expect(backupAction).toHaveBeenCalledWith('refresh'));
});
it('retains failures visibly and disables actions while status is unavailable', async () => {
  vi.mocked(getBackups).mockRejectedValue(Error('offline'));
  render(
    <MemoryRouter>
      <BackupsView />
    </MemoryRouter>,
  );
  await screen.findByRole('alert');
  expect((screen.getByRole('button', { name: 'Back up now' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
});
