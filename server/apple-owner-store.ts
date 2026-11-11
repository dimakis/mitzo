import {
  constants,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { AppleSignInError } from './apple-sign-in.js';
import { withAppleFile } from './apple-private-file.js';

/** Contains only Apple's verified opaque subject, never an email or credential.
 * Exclusive creation prevents a concurrent first enrollment replacing an owner.
 * Corrupt/unreadable files fail closed; they are never treated as unenrolled. */
export class AppleOwnerStore {
  constructor(readonly path: string) {}
  read(): string | null {
    try {
      const fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      return withAppleFile(fd, () => {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size > 4096 || (stat.mode & 0o077) !== 0)
          throw new Error('Invalid owner file');
        const record = JSON.parse(readFileSync(fd, 'utf8'));
        if (
          record.version !== 1 ||
          typeof record.subject !== 'string' ||
          !record.subject ||
          record.subject.length > 255
        )
          throw new Error('Invalid owner record');
        return record.subject;
      });
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new AppleSignInError('owner_storage_unavailable', cause);
    }
  }
  enroll(subject: string): void {
    if (!subject || subject.length > 255) throw new AppleSignInError('invalid_identity');
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      const fd = openSync(
        this.path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      withAppleFile(fd, () => {
        writeFileSync(fd, JSON.stringify({ version: 1, subject }) + '\n');
        fsyncSync(fd);
      });
    } catch (cause) {
      throw new AppleSignInError(
        (cause as NodeJS.ErrnoException).code === 'EEXIST'
          ? 'already_enrolled'
          : 'owner_storage_unavailable',
        cause,
      );
    }
  }
}
