import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  readFileSync,
  writeFileSync,
  fsyncSync,
  renameSync,
  unlinkSync,
  lstatSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { OpenShellArtifactReadError } from './openshell-artifact-reader.js';

export function writeHostArtifact(path: string, content: string, expectedContent?: string) {
  if (
    Buffer.byteLength(content) > 5 * 1024 * 1024 ||
    (expectedContent !== undefined && Buffer.byteLength(expectedContent) > 5 * 1024 * 1024)
  )
    throw new OpenShellArtifactReadError(413, 'Document is too large to edit (5 MB maximum)');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const temporary = join(dirname(path), `.mitzo-edit-${randomUUID()}`);
  let output: number | undefined;
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1)
      throw new OpenShellArtifactReadError(403, 'Document is not a regular unlinked file');
    if (before.size > 5 * 1024 * 1024)
      throw new OpenShellArtifactReadError(413, 'Document is too large to edit');
    if (expectedContent !== undefined && !readFileSync(fd).equals(Buffer.from(expectedContent)))
      throw new OpenShellArtifactReadError(
        409,
        'File changed elsewhere. Your draft is preserved; reopen the document to review the latest version.',
      );
    output = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      before.mode & 0o777,
    );
    writeFileSync(output, content, 'utf8');
    fsyncSync(output);
    const current = lstatSync(path);
    if (
      before.dev !== current.dev ||
      before.ino !== current.ino ||
      before.size !== current.size ||
      before.mtimeMs !== current.mtimeMs ||
      before.ctimeMs !== current.ctimeMs ||
      current.nlink !== 1
    )
      throw new OpenShellArtifactReadError(
        409,
        'File changed while saving. Your draft is preserved.',
      );
    renameSync(temporary, path);
  } finally {
    closeSync(fd);
    if (output !== undefined) closeSync(output);
    try {
      unlinkSync(temporary);
    } catch {
      /* Renamed or never created. */
    }
  }
}
