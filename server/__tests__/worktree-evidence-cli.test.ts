import { describe, expect, it } from 'vitest';
import { parseWorktreeEvidenceArgs } from '../worktree-evidence-args.js';

describe('parseWorktreeEvidenceArgs', () => {
  it('parses repeated repositories, inboxes, active sessions, and PR evidence for a manifest', () => {
    expect(
      parseWorktreeEvidenceArgs([
        'manifest',
        '--repo',
        '/repo/one',
        '--repo',
        '/repo/two',
        '--inbox',
        '/inbox',
        '--active-session',
        'session-one',
        '--include-prs',
        '--output',
        '/evidence/manifest.json',
      ]),
    ).toEqual({
      command: 'manifest',
      repositories: ['/repo/one', '/repo/two'],
      inboxDirectories: ['/inbox'],
      activeSessionIds: ['session-one'],
      includePullRequests: true,
      output: '/evidence/manifest.json',
    });
  });

  it('requires explicit untracked selections and destinations for package and rehearsal commands', () => {
    expect(
      parseWorktreeEvidenceArgs([
        'package',
        '--manifest',
        '/evidence/manifest.json',
        '--session',
        'session-one',
        '--destination-root',
        '/evidence/packages',
        '--select',
        'notes.md',
      ]),
    ).toMatchObject({
      command: 'package',
      selectedUntrackedPaths: ['notes.md'],
    });
    expect(() =>
      parseWorktreeEvidenceArgs(['rehearse', '--package', '/evidence/packages/session-one']),
    ).toThrow('missing --destination');
  });
});
