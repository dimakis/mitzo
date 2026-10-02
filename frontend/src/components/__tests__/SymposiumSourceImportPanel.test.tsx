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

it('recovers only the retained imported seal with fresh app authorization and exact status identities', async () => {
  const pending = {
    repositories: ['repo'],
    expectedRevision: 4,
    artifact: {
      available: false,
      state: 'imported',
      admissionIssued: false,
      volumeGeneration: 'volume-gen',
      receipt: { operationId: 'import-1' },
      sourceSeal: { state: 'pending', operationId: 'import-1' },
    },
  };
  let completed = false;
  vi.mocked(apiFetch).mockImplementation(async (url) => {
    if (String(url).endsWith('/reauthorize'))
      return response({ csrf: 'recent-csrf', expiresAt: Date.now() + 60_000 });
    if (String(url).endsWith('/seal/recover')) {
      completed = true;
      return response({ seal: { state: 'complete', operationId: 'import-1' } });
    }
    return response(
      completed
        ? {
            ...pending,
            artifact: {
              ...pending.artifact,
              sourceSeal: { state: 'complete', operationId: 'import-1' },
            },
          }
        : pending,
    );
  });
  render(<SymposiumSourceImportPanel sessionId="session" />);
  await userEvent.click(screen.getByRole('button', { name: 'Import local repository' }));
  await screen.findByText(/source seal is pending/i);
  expect(screen.queryByRole('button', { name: 'Import approved history' })).toBeNull();
  const recover = screen.getByRole('button', { name: 'Recover retained source seal' });
  expect(recover.hasAttribute('disabled')).toBe(true);
  await userEvent.type(screen.getByLabelText('App passphrase for source seal recovery'), 'secret');
  await userEvent.click(recover);
  await screen.findByText(/source seal completed/i);
  const calls = vi.mocked(apiFetch).mock.calls;
  const recovery = calls.find(([url]) => String(url).endsWith('/seal/recover'))!;
  expect(recovery[1]!.headers).toMatchObject({ 'x-csrf-token': 'recent-csrf' });
  expect(JSON.parse(recovery[1]!.body as string)).toEqual({
    expectedRevision: 4,
    expectedGeneration: 'volume-gen',
    operationId: 'import-1',
  });
  expect(calls.some(([url]) => String(url).endsWith('/import'))).toBe(false);
  expect(screen.queryByRole('button', { name: 'Recover retained source seal' })).toBeNull();
});

it('starts retained seal recovery when import completed before the seal receipt was created', async () => {
  const imported = {
    expectedRevision: 7,
    artifact: {
      available: false,
      state: 'imported',
      admissionIssued: false,
      volumeGeneration: 'retained-gen',
      receipt: { operationId: 'import-before-seal' },
      sourceSeal: null,
    },
  };
  vi.mocked(apiFetch).mockImplementation(async (url) =>
    String(url).endsWith('/reauthorize')
      ? response({ csrf: 'recent-csrf', expiresAt: Date.now() + 60_000 })
      : String(url).endsWith('/seal/recover')
        ? response({ seal: { state: 'complete', operationId: 'import-before-seal' } })
        : response(imported),
  );
  render(<SymposiumSourceImportPanel sessionId="session" />);
  await userEvent.click(screen.getByRole('button', { name: 'Import local repository' }));
  await userEvent.type(
    await screen.findByLabelText('App passphrase for source seal recovery'),
    'secret',
  );
  await userEvent.click(screen.getByRole('button', { name: 'Recover retained source seal' }));
  await screen.findByText(/source seal completed/i);
  const calls = vi.mocked(apiFetch).mock.calls;
  const recovery = calls.find(([url]) => String(url).endsWith('/seal/recover'))!;
  expect(recovery[1]!.headers).toMatchObject({ 'x-csrf-token': 'recent-csrf' });
  expect(JSON.parse(recovery[1]!.body as string)).toEqual({
    expectedRevision: 7,
    expectedGeneration: 'retained-gen',
    operationId: 'import-before-seal',
  });
  expect(calls.some(([url]) => String(url).endsWith('/import'))).toBe(false);
});

it('does not offer seal recovery when the imported status lacks matching retained identities', async () => {
  vi.mocked(apiFetch).mockResolvedValue(
    response({
      expectedRevision: 4,
      artifact: {
        available: false,
        state: 'imported',
        volumeGeneration: 'volume-gen',
        receipt: { operationId: 'import-1' },
        sourceSeal: { state: 'pending', operationId: 'different' },
      },
    }),
  );
  render(<SymposiumSourceImportPanel sessionId="session" />);
  await userEvent.click(screen.getByRole('button', { name: 'Import local repository' }));
  await screen.findByText(/already been imported/i);
  expect(screen.queryByRole('button', { name: 'Recover retained source seal' })).toBeNull();
});

it.each(['complete', 'uncertain'])(
  'does not offer retained seal recovery for an incompatible %s seal state',
  async (sealState) => {
    vi.mocked(apiFetch).mockResolvedValue(
      response({
        expectedRevision: 4,
        artifact: {
          available: false,
          state: 'imported',
          volumeGeneration: 'volume-gen',
          receipt: { operationId: 'import-1' },
          sourceSeal: { state: sealState, operationId: 'import-1' },
        },
      }),
    );
    render(<SymposiumSourceImportPanel sessionId="session" />);
    await userEvent.click(screen.getByRole('button', { name: 'Import local repository' }));
    await screen.findByText(/already been imported/i);
    expect(screen.queryByRole('button', { name: 'Recover retained source seal' })).toBeNull();
  },
);

it('keeps a pending seal recoverable when recent authorization expires', async () => {
  vi.mocked(apiFetch).mockImplementation(async (url) =>
    String(url).endsWith('/reauthorize')
      ? response({ csrf: 'expired', expiresAt: Date.now() - 1 })
      : response({
          expectedRevision: 4,
          artifact: {
            available: false,
            state: 'imported',
            volumeGeneration: 'volume-gen',
            receipt: { operationId: 'import-1' },
            sourceSeal: { state: 'pending', operationId: 'import-1' },
          },
        }),
  );
  render(<SymposiumSourceImportPanel sessionId="session" />);
  await userEvent.click(screen.getByRole('button', { name: 'Import local repository' }));
  await screen.findByText(/source seal is pending/i);
  await userEvent.type(screen.getByLabelText('App passphrase for source seal recovery'), 'secret');
  await userEvent.click(screen.getByRole('button', { name: 'Recover retained source seal' }));
  await screen.findByText(/Recent app authorization expired/);
  expect(
    vi.mocked(apiFetch).mock.calls.some(([url]) => String(url).endsWith('/seal/recover')),
  ).toBe(false);
  expect(screen.getByRole('button', { name: 'Recover retained source seal' })).toBeTruthy();
});
