import { describe, expect, it } from 'vitest';
import { selectCiJobs } from '../ci-selection.mjs';

describe('CI job selection', () => {
  it('keeps all jobs for main and unknown or incomplete change lists', () => {
    for (const input of [
      { eventName: 'push', files: [{ filename: 'README.md' }] },
      { eventName: 'pull_request', files: [] },
      { eventName: 'pull_request', files: [{ filename: 'future/build.config' }] },
      { eventName: 'pull_request', files: [{ filename: 'README.md' }], complete: false },
    ]) {
      expect(selectCiJobs(input)).toEqual({ browser: true, native: true });
    }
  });

  it.each([
    ['README.md', false, false],
    ['docs/onboarding.md', false, false],
    ['server/app.ts', true, false],
    ['frontend/src/pages/Connections.tsx', true, false],
    ['frontend/ios/MitzoShared/Sources/Client.swift', false, true],
    ['packages/protocol/src/index.ts', true, true],
    ['tests/browser/connections.spec.ts', true, false],
    ['package-lock.json', true, true],
    ['scripts/build-ios.sh', true, true],
    ['.github/workflows/ci.yml', true, true],
    ['docs/spikes/openshell-codex/knowledge-write-scope.c', true, true],
  ])('selects dependent jobs for %s', (filename, browser, native) => {
    expect(selectCiJobs({ eventName: 'pull_request', files: [{ filename }] })).toEqual({
      browser,
      native,
    });
  });

  it('includes deleted and previous renamed paths', () => {
    expect(
      selectCiJobs({
        eventName: 'pull_request',
        files: [
          { filename: 'docs/moved.md', previous_filename: 'frontend/ios/Old.swift' },
          { filename: 'tests/browser/removed.spec.ts', status: 'removed' },
        ],
      }),
    ).toEqual({ browser: true, native: true });
  });
});
