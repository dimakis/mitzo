import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { selectCiJobs } from '../ci-selection.mjs';

const none = { browser: false, native: false, prepared: false, ordinary: false };
const every = { browser: true, native: true, prepared: true, ordinary: true };

it.each(['AGENTS.md', 'CLAUDE.md', 'skills/land-pr/SKILL.md', '.cursor/rules/ci-discipline.mdc'])(
  'selects composed authority coverage without unrelated browser/native builds: %s',
  (filename) => {
    expect(selectCiJobs({ eventName: 'pull_request', files: [{ filename }] })).toEqual({
      browser: false,
      native: false,
      prepared: true,
      ordinary: true,
    });
  },
);

it('retains dependent coverage when a rename crosses the prose boundary', () => {
  expect(
    selectCiJobs({
      eventName: 'pull_request',
      files: [{ filename: 'skills/land-pr/SKILL.md', previous_filename: 'frontend/src/api.ts' }],
    }),
  ).toEqual({ browser: true, native: false, prepared: true, ordinary: true });
});

describe('CI job selection', () => {
  it('keeps all jobs for main and unknown or incomplete change lists', () => {
    for (const input of [
      { eventName: 'push', files: [{ filename: 'README.md' }] },
      { eventName: 'pull_request', files: [] },
      { eventName: 'pull_request', files: [{ filename: 'future/build.config' }] },
      { eventName: 'pull_request', files: [{ filename: 'README.md' }], complete: false },
    ]) {
      expect(selectCiJobs(input)).toEqual({
        browser: true,
        native: true,
        prepared: true,
        ordinary: true,
      });
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
    ['skills/land-pr/scripts/check.sh', true, true],
    ['.cursor/rules/helper.js', true, true],
    ['.github/workflows/ci.yml', true, true],
    ['docs/spikes/openshell-codex/knowledge-write-scope.c', true, true],
  ])('selects dependent jobs for %s', (filename, browser, native) => {
    expect(selectCiJobs({ eventName: 'pull_request', files: [{ filename }] })).toEqual({
      browser,
      native,
      prepared: browser,
      ordinary: ![
        'README.md',
        'docs/onboarding.md',
        'frontend/ios/MitzoShared/Sources/Client.swift',
      ].includes(filename),
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
    ).toEqual({ browser: true, native: true, prepared: true, ordinary: true });
  });
});

it('fails closed on malformed diff entries rather than omitting the composed owner', () => {
  for (const filename of ['', undefined])
    expect(selectCiJobs({ eventName: 'pull_request', files: [{ filename }] })).toEqual({
      browser: true,
      native: true,
      prepared: true,
      ordinary: true,
    });
});

it('does not admit executable or proof documentation as unrelated prose', () => {
  for (const filename of [
    'docs/spikes/openshell-codex/runtime.md',
    'docs/evidence/telos-s9/acceptance.md',
    'docs/evidence/new-proof.json',
  ])
    expect(selectCiJobs({ eventName: 'pull_request', files: [{ filename }] })).toEqual({
      browser: true,
      native: true,
      prepared: true,
      ordinary: true,
    });
});

it('requires the ordinary owner for any changed dependency across the complete PR', () => {
  expect(
    selectCiJobs({
      eventName: 'pull_request',
      files: [{ filename: 'docs/onboarding.md' }, { filename: 'server/codex-conversation.ts' }],
    }).ordinary,
  ).toBe(true);
  expect(
    selectCiJobs({
      eventName: 'pull_request',
      files: [
        {
          filename: 'docs/moved.md',
          previous_filename: 'server/old-runtime.ts',
          status: 'renamed',
        },
      ],
    }).ordinary,
  ).toBe(true);
  expect(
    selectCiJobs({
      eventName: 'pull_request',
      files: [
        {
          filename: 'tests/integration/telos-s9/integrated-candidate/removed.ts',
          status: 'removed',
        },
      ],
    }).ordinary,
  ).toBe(true);
});

it('fails closed on malformed filenames and previous rename paths', () => {
  for (const files of [
    null,
    {},
    [null],
    [{ filename: '/docs/readme.md' }],
    [{ filename: 'docs/../server/runtime.md' }],
    [{ filename: 'docs/readme.md', previous_filename: 1 }],
    [{ filename: 'docs/readme.md', previous_filename: '' }],
  ])
    expect(selectCiJobs({ eventName: 'pull_request', files })).toEqual({
      browser: true,
      native: true,
      prepared: true,
      ordinary: true,
    });
});

it('keeps an iOS-only change in its native build owner without the unrelated server journey matrix', () => {
  expect(
    selectCiJobs({
      eventName: 'pull_request',
      files: [{ filename: 'frontend/ios/App/App/NotificationBridge.swift' }],
    }),
  ).toEqual({ browser: false, native: true, prepared: false, ordinary: false });
  expect(
    selectCiJobs({
      eventName: 'pull_request',
      files: [
        { filename: 'frontend/ios/App/App/NotificationBridge.swift' },
        { filename: 'packages/protocol/src/index.ts' },
      ],
    }),
  ).toEqual({ browser: true, native: true, prepared: true, ordinary: true });
});

describe('draft pull requests', () => {
  it('run only the cheap owners whatever the diff touches', () => {
    for (const files of [
      [{ filename: 'server/app.ts' }],
      [{ filename: 'frontend/ios/App/App/NotificationBridge.swift' }],
      [{ filename: '.github/workflows/ci.yml' }],
      [],
    ])
      for (const complete of [true, false])
        expect(selectCiJobs({ eventName: 'pull_request', files, complete, draft: true })).toEqual(
          none,
        );
  });

  it('run the full selection once ready, and only a strict true counts as draft', () => {
    const files = [{ filename: 'server/app.ts' }];
    for (const draft of [false, undefined, 'true', 1, null])
      expect(selectCiJobs({ eventName: 'pull_request', files, draft })).toEqual({
        browser: true,
        native: false,
        prepared: true,
        ordinary: true,
      });
  });

  it('never reduce coverage for a push to main', () => {
    expect(
      selectCiJobs({ eventName: 'push', files: [{ filename: 'README.md' }], draft: true }),
    ).toEqual(every);
  });
});

describe('draft selection in the workflow', () => {
  const workflow = load(readFileSync('.github/workflows/ci.yml', 'utf8')) as {
    jobs: Record<
      string,
      {
        outputs?: Record<string, string>;
        if?: string;
        steps: Array<{ id?: string; with?: { script?: string } }>;
      }
    >;
  };
  const script = workflow.jobs.changes.steps.find((s) => s.id === 'select')!.with!.script!;

  it('publishes the draft decision beside the owner selection', () => {
    expect(workflow.jobs.changes.outputs?.draft).toBe('${{ steps.select.outputs.draft }}');
    expect(script).toContain("core.setOutput('draft', String(draft));");
    expect(script).toContain(
      'selectCiJobs({ eventName: context.eventName, files, complete, draft })',
    );
  });

  it('requires both the event payload and the live PR to say draft', () => {
    expect(script).toContain('context.payload.pull_request?.draft === true');
    expect(script).toContain('github.rest.pulls.get');
    expect(script).toContain('draft = live.draft === true;');
    expect(script).toContain('let draft = false;');
  });

  it.each([
    'browser',
    'offline',
    'native',
    'ordinary-journey',
    'ordinary-joined',
    'ordinary-supplemental',
    'prepared-consumers',
  ])('%s is gated by a selection output that drafts force off', (name) => {
    expect(workflow.jobs[name].if).toMatch(
      /needs\.changes\.outputs\.(browser|native|prepared|ordinary) == 'true'/,
    );
  });

  it.each(['preflight', 'frontend-build', 'core', 'unit'])(
    '%s stays independent of draft selection',
    (name) => {
      expect(workflow.jobs[name].if ?? '').not.toMatch(/needs\.changes\.outputs/);
    },
  );
});
