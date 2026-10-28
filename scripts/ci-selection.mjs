/** Select expensive jobs conservatively; unknown paths and incomplete diffs run every owner. */
export function selectCiJobs({ eventName, files, complete = true }) {
  if (
    eventName !== 'pull_request' ||
    !complete ||
    !files?.length ||
    files.some((file) => typeof file.filename !== 'string' || !file.filename)
  ) {
    return { browser: true, native: true, prepared: true };
  }
  const selected = { browser: false, native: false, prepared: false };
  for (const file of files) {
    for (const path of [file.filename, file.previous_filename].filter(Boolean)) {
      if (path.startsWith('frontend/ios/')) {
        selected.native = true;
      } else if (
        path.startsWith('frontend/') ||
        path.startsWith('server/') ||
        path.startsWith('tests/browser/')
      ) {
        selected.browser = true;
        selected.prepared = true;
      } else if (
        ['AGENTS.md', 'CLAUDE.md'].includes(path) ||
        /^skills\/[^/]+\/SKILL\.md$/.test(path) ||
        /^\.cursor\/rules\/[^/]+\.mdc$/.test(path)
      ) {
        // These instructions affect admission/review even without a UI/Swift change.
        selected.prepared = true;
      } else if (path === 'README.md' || /^docs\/.*\.md$/.test(path)) {
        // Ordinary prose keeps full core coverage without unrelated platform builds.
      } else {
        selected.browser = true;
        selected.prepared = true;
        selected.native = true;
      }
    }
  }
  return selected;
}
