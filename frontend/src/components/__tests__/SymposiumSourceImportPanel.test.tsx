// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { apiFetch } from '../../lib/api-fetch';
import { SymposiumSourceImportPanel } from '../SymposiumSourceImportPanel';
vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const response = (body: unknown) => ({ ok: true, json: async () => body }) as Response;
it.each([false, true])(
  'requires preview, committed-history consent and fresh app auth (expired %s)',
  async (expired) => {
    const plan = {
      repositoryId: 'repo',
      targetRepository: 'example/project',
      baseBranch: 'main',
      featureBranch: 'symposium/change',
      baseOid: 'a'.repeat(40),
      treeOid: 'b'.repeat(40),
      sourceIdentity: 'c'.repeat(64),
      historyCommits: 2,
    };
    vi.mocked(apiFetch).mockImplementation(async (url) =>
      url === '/api/sessions/session/symposium/source/reauthorize'
        ? response({ csrf: 'csrf', expiresAt: Date.now() + (expired ? -1 : 60000) })
        : String(url).endsWith('/preview')
          ? response({
              plan,
              expectedRevision: 4,
              expectedGeneration: 'gen',
              disclosure:
                'All committed history reachable from this local base is imported. No remote fetch.',
            })
          : String(url).endsWith('/import')
            ? response({ commit: plan.baseOid })
            : response({ repositories: ['repo'], artifact: { available: true, state: 'empty' } }),
    );
    render(<SymposiumSourceImportPanel sessionId="session" />);
    await userEvent.click(screen.getByRole('button', { name: 'Import local repository' }));
    await userEvent.selectOptions(
      await screen.findByLabelText('Configured local repository'),
      'repo',
    );
    await userEvent.type(screen.getByLabelText('GitHub owner/repository'), 'example/project');
    await userEvent.type(screen.getByLabelText('Local default base branch'), 'main');
    await userEvent.type(screen.getByLabelText('New feature branch'), 'symposium/change');
    await userEvent.click(screen.getByRole('button', { name: 'Preview committed source' }));
    await screen.findByText(/All committed history reachable/);
    const button = screen.getByRole('button', { name: 'Import approved history' });
    expect(button.hasAttribute('disabled')).toBe(true);
    await userEvent.type(screen.getByLabelText('App passphrase for source import'), 'passphrase');
    await userEvent.type(
      screen.getByLabelText('Type IMPORT COMMITTED REPOSITORY HISTORY'),
      'IMPORT COMMITTED REPOSITORY HISTORY',
    );
    await userEvent.click(button);
    if (expired) {
      await screen.findByText('Recent app authorization expired. Enter the passphrase again.');
      expect(vi.mocked(apiFetch).mock.calls.some(([url]) => String(url).endsWith('/import'))).toBe(
        false,
      );
    } else {
      await waitFor(() =>
        expect(
          vi.mocked(apiFetch).mock.calls.some(([url]) => String(url).endsWith('/import')),
        ).toBe(true),
      );
      const call = vi.mocked(apiFetch).mock.calls.find(([url]) => String(url).endsWith('/import'))!;
      expect(call[1]!.headers).toMatchObject({ 'x-csrf-token': 'csrf' });
      expect(JSON.parse(call[1]!.body as string)).toEqual({
        plan,
        expectedRevision: 4,
        expectedGeneration: 'gen',
        operationId: expect.any(String),
        confirmation: 'IMPORT COMMITTED REPOSITORY HISTORY',
      });
    }
    expect(
      vi
        .mocked(apiFetch)
        .mock.calls.some(
          ([url]) => String(url).includes('admission') || String(url).includes('publish'),
        ),
    ).toBe(false);
  },
);

it.each([
  ['failed', 'The source helper exited with a failure.'],
  ['uncertain', 'The source helper outcome is unknown.'],
  ['recovery_required', 'The source import is incomplete.'],
])('shows %s without offering another import', async (state, message) => {
  vi.mocked(apiFetch).mockResolvedValue(
    response({ repositories: ['repo'], artifact: { available: false, state } }),
  );
  render(<SymposiumSourceImportPanel sessionId="session" />);
  await userEvent.click(screen.getByRole('button', { name: 'Import local repository' }));
  await screen.findByText(new RegExp(message));
  expect(screen.queryByRole('button', { name: 'Import approved history' })).toBeNull();
  expect(
    screen.getByText(
      /retained for inspection; automatic retry and restart recovery are unavailable/,
    ),
  ).toBeTruthy();
});
