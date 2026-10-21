/** Trusted selected-credential dispatch, separate from the read-only runner.
 * The producer completes ALL asynchronous credential, cwd and environment
 * preparation first, then calls admit synchronously immediately before the
 * external command starts, with no intervening await. A thrown admission must
 * prevent the command. This port supplies no credentials or authority itself.
 */
export type GithubMainMergeDispatch = (
  command: 'gh',
  args: readonly string[],
  signal: AbortSignal,
  admit: () => void,
) => Promise<{ stdout: string; stderr: string }>;
