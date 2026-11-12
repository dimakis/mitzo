import { z } from 'zod';

/** Plain job logs only: run-log endpoints return archives, not text. */
export const GithubLogReadSchema = z.strictObject({
  offset: z
    .number()
    .int()
    .min(0)
    .max(8 * 1024 * 1024)
    .optional(),
  limit: z.number().int().min(1).max(16000).optional(),
  query: z.string().min(1).max(500).optional(),
});
export type GithubLogRead = z.infer<typeof GithubLogReadSchema>;
export const GITHUB_LOG_SOURCE_LIMIT = 8 * 1024 * 1024;

export function validateGithubLogRead(endpoint: string, options: unknown): GithubLogRead {
  if (!/^\/repos\/[\w.-]+\/[\w.-]+\/actions\/jobs\/[1-9]\d*\/logs$/.test(endpoint))
    throw Error('Log controls require /repos/OWNER/REPO/actions/jobs/JOB_ID/logs');
  return GithubLogReadSchema.parse(options);
}

/** Offsets count UTF-16 characters in the optionally filtered text. Returning
 * the continuation explicitly prevents a bounded excerpt looking complete. */
export function githubLogPage(body: string, options: GithubLogRead) {
  const text = options.query
    ? body
        .split(/\r?\n/)
        .filter((line) => line.includes(options.query!))
        .join('\n')
    : body;
  const offset = Math.min(options.offset ?? 0, text.length);
  const end = Math.min(text.length, offset + (options.limit ?? 16000));
  return {
    content: text.slice(offset, end),
    offset,
    nextOffset: end < text.length ? end : null,
    totalCharacters: text.length,
    sourceBytes: Buffer.byteLength(body),
    ...(options.query ? { query: options.query } : {}),
  };
}
