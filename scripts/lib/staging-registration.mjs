import { createHash } from 'node:crypto';
import { constants, openSync, fstatSync, readFileSync, closeSync, realpathSync } from 'node:fs';

export function registrationDigest(path) {
  if (realpathSync(path) !== path) throw Error('Registration alias refused');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = fstatSync(fd);
    if (
      !s.isFile() ||
      s.uid !== process.getuid() ||
      s.nlink !== 1 ||
      (s.mode & 0o777) !== 0o600 ||
      s.size > 65536
    )
      throw Error('Private original registration required');
    return createHash('sha256').update(readFileSync(fd)).digest('hex');
  } finally {
    closeSync(fd);
  }
}

/** The legacy path is supplied by the caller from the actual macOS user's home.
 * Its exact original bytes/process require a completed explicit qualification. */
export function assertStageRegistration({
  registered,
  canonical,
  legacy,
  qualification,
  pid,
  birth,
}) {
  if (registered === canonical) return 'canonical';
  const q = qualification;
  if (
    registered !== legacy ||
    !q ||
    q.legacyRegistration?.path !== legacy ||
    !/^[a-f0-9]{64}$/.test(q.legacyRegistration.sha256 ?? '') ||
    registrationDigest(legacy) !== q.legacyRegistration.sha256 ||
    registrationDigest(canonical) !== q.legacyRegistration.sha256 ||
    (pid && (q.original?.pid !== pid || q.original?.birth !== birth))
  )
    throw Error('Original staging registration requires explicit qualification');
  return 'qualified-legacy';
}
import process from 'node:process';
