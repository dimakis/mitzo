import { freezeNativeReadExclusions } from './native-file-operation.js';
import { LocalRepositoryGitInspectionError } from './local-repository-git-inspection.js';
import type { LocalRepositoryReadAnchor } from './local-repository-read-access.js';

/** Owner-supplied sources for the private discovery/inspection read hooks.
 * `current` runs before and after every capture; a synchronous check stays
 * synchronous so no await gap opens between the fence and the capture. */
export interface LocalRepositoryReadHookSource {
  current(): void | Promise<void>;
  exclusions(): readonly string[] | Promise<readonly string[]>;
  anchor(path: string): Promise<LocalRepositoryReadAnchor>;
}

/** The two hooks every discovery/inspection request must carry. Both adapters
 * (Codex and Claude SDK) build them here so neither can omit them. */
export function localRepositoryReadHooks(source: LocalRepositoryReadHookSource) {
  return {
    captureReadExclusions: async () => {
      let checked = source.current();
      if (checked) await checked;
      const captured = source.exclusions();
      const exclusions = captured instanceof Promise ? await captured : captured;
      checked = source.current();
      if (checked) await checked;
      return freezeNativeReadExclusions(exclusions);
    },
    captureReadAnchor: async (path: string) => {
      let checked = source.current();
      if (checked) await checked;
      const anchor = await source.anchor(path);
      checked = source.current();
      if (checked) await checked;
      return anchor;
    },
  };
}

/** Bounded structured projection of a code-owned read refusal; any other
 * failure stays with the caller's failure reporting. */
export function localRepositoryReadFailure(error: unknown) {
  if (!(error instanceof LocalRepositoryGitInspectionError)) return undefined;
  return {
    state: error.kind === 'access' ? 'access-required' : 'inspection-unavailable',
    reason: error.reason,
    needed:
      error.kind === 'access' ? ['read-access'] : error.kind === 'limit' ? ['narrower-search'] : [],
  };
}
