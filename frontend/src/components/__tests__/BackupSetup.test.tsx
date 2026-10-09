// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { BackupSetup } from '../BackupSetup';
import { getBackupSetup, prepareBackups, configureBackups } from '../../lib/backups-api';
vi.mock('../../lib/backups-api', () => ({
  getBackupSetup: vi.fn(),
  prepareBackups: vi.fn(),
  configureBackups: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const status = {
  supported: true,
  prepared: false,
  configured: false,
  busy: false,
  localFolder: '/local',
  cloudFolder: '/cloud',
};
it('performs real setup actions, requires recovery, clears the password and updates readiness', async () => {
  vi.mocked(getBackupSetup).mockResolvedValue(status);
  vi.mocked(prepareBackups).mockResolvedValue({ ...status, prepared: true });
  vi.mocked(configureBackups).mockResolvedValue({ ...status, prepared: true, configured: true });
  const onConfigured = vi.fn();
  render(<BackupSetup onConfigured={onConfigured} onClose={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Prepare storage' }));
  await waitFor(() => expect(prepareBackups).toHaveBeenCalledTimes(1));
  const password = await screen.findByLabelText('Backup password');
  fireEvent.change(password, { target: { value: 'synthetic-recovery-password' } });
  expect((screen.getByRole('button', { name: 'Finish setup' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Finish setup' }));
  await screen.findByText('Backup setup complete');
  expect(configureBackups).toHaveBeenCalledWith('synthetic-recovery-password');
  expect(screen.queryByLabelText('Backup password')).toBeNull();
  expect(onConfigured).toHaveBeenCalledTimes(1);
});
it('keeps setup failures actionable and clears the password before retrying', async () => {
  vi.mocked(getBackupSetup).mockResolvedValue({ ...status, prepared: true });
  vi.mocked(configureBackups).mockRejectedValue(Error('Unlock Keychain on the Mac and retry.'));
  render(<BackupSetup onConfigured={vi.fn()} onClose={vi.fn()} />);
  const password = await screen.findByLabelText('Backup password');
  fireEvent.change(password, { target: { value: 'synthetic-recovery-password' } });
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Finish setup' }));
  await screen.findByRole('alert');
  expect((password as HTMLInputElement).value).toBe('');
  expect((screen.getByRole('button', { name: 'Finish setup' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
});
it('does not offer password entry on unsupported hosts or already configured backups', async () => {
  vi.mocked(getBackupSetup).mockResolvedValue({ ...status, supported: false });
  render(<BackupSetup onConfigured={vi.fn()} onClose={vi.fn()} />);
  await screen.findByText(/requires the Mac/);
  expect(screen.queryByLabelText('Backup password')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Prepare storage' })).toBeNull();
});
it('refreshes tools for a configured backup without requesting or submitting a password', async () => {
  vi.mocked(getBackupSetup).mockResolvedValue({ ...status, prepared: true, configured: true });
  vi.mocked(prepareBackups).mockResolvedValue({ ...status, prepared: true, configured: true });
  const onConfigured = vi.fn();
  render(<BackupSetup onConfigured={onConfigured} onClose={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Refresh backup tools' }));
  await waitFor(() => expect(prepareBackups).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(onConfigured).toHaveBeenCalledTimes(1));
  expect(configureBackups).not.toHaveBeenCalled();
  expect(screen.queryByLabelText('Backup password')).toBeNull();
});
