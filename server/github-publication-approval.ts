import { createHash } from 'node:crypto';

/** GitHub's supported description length, shared by validation and transport. */
export const GITHUB_PR_DESCRIPTION_MAX_LENGTH = 65_536;

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
/** Display budgets limit previews, never the committed source or requested metadata.
 * The source OID and complete-value hashes bind approval to the full artifact. */
export function githubPublicationBodyApproval(body: string): Record<string, string | boolean> {
  if (body.length <= 512) return { body };
  return {
    bodyPreview: body.slice(0, 512),
    bodyPreviewTruncated: true,
    bodyBytes: String(Buffer.byteLength(body, 'utf8')),
    bodySha256: digest(body),
  };
}
export function githubPublicationFilesApproval(files: readonly string[]): Record<string, string> {
  const preview: string[] = [];
  let bytes = 2;
  for (const file of files) {
    const size = Buffer.byteLength(JSON.stringify(file), 'utf8') + 1;
    if (preview.length === 100 || bytes + size > 2000) break;
    preview.push(file);
    bytes += size;
  }
  return {
    changedFiles: JSON.stringify(preview),
    changedFileCount: String(files.length),
    changedFilesOmitted: String(files.length - preview.length),
    changedFilesSha256: digest(JSON.stringify(files)),
  };
}
