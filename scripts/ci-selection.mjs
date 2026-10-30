/** Select expensive jobs conservatively; unknown paths and incomplete diffs run every owner. */
export function selectCiJobs({ eventName, files, complete = true }) {
  const all = () => ({ browser: true, native: true, prepared: true, ordinary: true });
  const validPath = (path) =>
    typeof path === 'string' &&
    !path.includes('\\') &&
    path.split('/').every((part) => part && part !== '.' && part !== '..');
  if (
    eventName !== 'pull_request' ||
    complete !== true ||
    !Array.isArray(files) ||
    !files.length ||
    files.some(
      (file) =>
        !file ||
        !validPath(file.filename) ||
        (file.previous_filename !== undefined && !validPath(file.previous_filename)),
    )
  ) {
    return all();
  }
  const selected = { browser: false, native: false, prepared: false, ordinary: false };
  for (const file of files) {
    for (const path of [file.filename, file.previous_filename].filter(Boolean)) {
      if (path.startsWith('frontend/ios/')) {
        // The Swift/Capacitor bridge belongs to the native build; ordinary
        // server/browser journeys compile TS packages and do not consume it.
        selected.native = true;
      } else if (
        path.startsWith('frontend/') ||
        path.startsWith('server/') ||
        path.startsWith('tests/browser/')
      ) {
        selected.browser = true;
        selected.prepared = true;
        selected.ordinary = true;
      } else if (
        ['AGENTS.md', 'CLAUDE.md'].includes(path) ||
        /^skills\/[^/]+\/SKILL\.md$/.test(path) ||
        /^\.cursor\/rules\/[^/]+\.mdc$/.test(path)
      ) {
        // These instructions affect admission/review even without a UI/Swift change.
        selected.prepared = true;
        selected.ordinary = true;
      } else if (
        path === 'README.md' ||
        (/^docs\/.*\.md$/.test(path) &&
          !path.startsWith('docs/spikes/') &&
          !path.startsWith('docs/evidence/'))
      ) {
        // Ordinary prose retains core/unit coverage. Runtime spikes and proof
        // records are executable dependencies, even when their extension is .md.
      } else {
        Object.assign(selected, all());
      }
    }
  }
  return selected;
}
