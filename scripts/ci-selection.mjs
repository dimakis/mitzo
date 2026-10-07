/** Select expensive jobs conservatively; unknown paths and incomplete diffs run both. */
export function selectCiJobs({ eventName, files, complete = true }) {
  if (eventName !== 'pull_request' || !complete || !files?.length) {
    return { browser: true, native: true };
  }
  const selected = { browser: false, native: false };
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
      } else if (path === 'README.md' || /^docs\/.*\.md$/.test(path)) {
        // Prose has no browser or Swift build dependency. The full core CI still runs.
      } else {
        selected.browser = true;
        selected.native = true;
      }
    }
  }
  return selected;
}
