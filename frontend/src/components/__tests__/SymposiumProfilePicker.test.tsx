// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { apiFetch } from '../../lib/api-fetch';
import { SymposiumProfilePicker } from '../SymposiumProfilePicker';

vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const version = {
  profileId: 'reviewer',
  revision: 2,
  contentHash: 'a'.repeat(64),
  definition: {
    name: 'Independent reviewer',
    role: 'reviewer',
    instructions: 'Review code',
    expectedOutput: 'Findings',
    acceptanceCriteria: ['Evidence for each finding'],
    modelPolicyRole: 'reviewer',
  },
};
const response = (body: unknown) => ({ ok: true, json: async () => body }) as Response;

it('loads immutable versions and emits an explicit profile selection', async () => {
  vi.mocked(apiFetch).mockResolvedValue(response([version]));
  const onChange = vi.fn();
  render(<SymposiumProfilePicker value={null} onChange={onChange} />);
  fireEvent.change(await screen.findByLabelText('Saved profile'), {
    target: { value: 'reviewer:2' },
  });
  expect(onChange).toHaveBeenCalledWith({ profileId: 'reviewer', revision: 2 });
});

it('saves portable guidance as a new immutable version without runtime grants', async () => {
  vi.mocked(apiFetch).mockImplementation(async (_path, init) =>
    init?.method === 'POST' ? response({ ...version, revision: 1 }) : response([]),
  );
  const onChange = vi.fn();
  render(<SymposiumProfilePicker value={null} onChange={onChange} />);
  fireEvent.click(await screen.findByRole('button', { name: 'New profile' }));
  fireEvent.change(screen.getByLabelText('Profile ID'), { target: { value: 'reviewer' } });
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Independent reviewer' } });
  fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'reviewer' } });
  fireEvent.change(screen.getByLabelText('Instructions'), { target: { value: 'Review code' } });
  fireEvent.change(screen.getByLabelText('Expected output'), { target: { value: 'Findings' } });
  fireEvent.change(screen.getByLabelText('Acceptance criteria'), {
    target: { value: 'Evidence for each finding' },
  });
  fireEvent.change(screen.getByLabelText('Model policy role'), { target: { value: 'reviewer' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
  await waitFor(() =>
    expect(onChange).toHaveBeenCalledWith({ profileId: 'reviewer', revision: 1 }),
  );
  const post = vi.mocked(apiFetch).mock.calls.find(([, init]) => init?.method === 'POST')!;
  expect(JSON.parse(post[1]!.body as string)).toMatchObject({
    profileId: 'reviewer',
    expectedRevision: 0,
    definition: { name: 'Independent reviewer', role: 'reviewer', instructions: 'Review code' },
  });
  expect(post[1]!.body).not.toMatch(/accountBinding|contextGrant|authorityGrant|credentials/);
});

it('exports a portable version and imports an exact artifact', async () => {
  vi.mocked(apiFetch).mockImplementation(async (path) => {
    if (path.endsWith('/export')) return response(version);
    if (path.endsWith('/import')) return response(version);
    return response([version]);
  });
  const onChange = vi.fn();
  render(
    <SymposiumProfilePicker value={{ profileId: 'reviewer', revision: 2 }} onChange={onChange} />,
  );
  await screen.findByText('Independent reviewer · v2');
  fireEvent.click(screen.getByRole('button', { name: 'Export JSON' }));
  expect(
    ((await screen.findByLabelText('Portable profile export')) as HTMLTextAreaElement).value,
  ).toContain('"contentHash"');
  fireEvent.change(screen.getByLabelText('Import profile JSON'), {
    target: { value: JSON.stringify(version) },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Import profile' }));
  await waitFor(() =>
    expect(onChange).toHaveBeenCalledWith({ profileId: 'reviewer', revision: 2 }),
  );
});
