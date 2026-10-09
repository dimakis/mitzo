import { expect, it, vi } from 'vitest';
import {
  BackupKeychain,
  backupKeychainService,
  CREATE_BACKUP_PASSWORD,
} from '../backup/setup-keychain.js';
it('scopes the credential to host storage and passes the secret only through stdin', async () => {
  expect(backupKeychainService('/first/root')).not.toBe(backupKeychainService('/second/root'));
  const run = vi.fn(async () => '{"ok":true}');
  const read = vi.fn(async () => 'synthetic-recovery-password\n');
  const vault = new BackupKeychain('/first/root', run, read);
  await vault.save('synthetic-recovery-password');
  const input = JSON.parse(run.mock.calls[0][0]);
  expect(input).toEqual({
    service: backupKeychainService('/first/root'),
    password: 'synthetic-recovery-password',
  });
  expect(CREATE_BACKUP_PASSWORD).not.toMatch(/SecItemUpdate|SecItemDelete|add-generic-password/);
  expect(await vault.read()).toBe('synthetic-recovery-password');
});
it('accepts a retry only when an existing Keychain entry has exactly the same password', async () => {
  const run = vi.fn(async () => '{"exists":true}');
  const read = vi.fn(async () => 'synthetic-recovery-password\n');
  const vault = new BackupKeychain('/first/root', run, read);
  await vault.save('synthetic-recovery-password');
  await expect(vault.save('different-recovery-password')).rejects.toThrow(
    'Backup credential unavailable',
  );
  run.mockRejectedValueOnce(Error('SECRET'));
  await expect(vault.save('synthetic-recovery-password')).rejects.toThrow(
    'Backup credential unavailable',
  );
});
