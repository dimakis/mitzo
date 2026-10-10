/** Native tool results can resume inference without a trusted host authorization check. */
export function assertNativeCodexContextAdmission(
  ...contexts: ({ source?: string } | undefined)[]
): void {
  if (contexts.some((context) => context?.source === 'packs'))
    throw new Error(
      'Reusable context packs require a trusted native continuation barrier; native Codex context admission is unavailable.',
    );
}
