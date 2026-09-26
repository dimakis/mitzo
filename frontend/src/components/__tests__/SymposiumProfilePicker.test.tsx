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

it('selects historical revisions exactly and limits revision edits to the latest version', async () => {
  const older = { ...version, revision: 1 };
  vi.mocked(apiFetch).mockResolvedValue(response([version, older]));
  const onChange = vi.fn();
  const { rerender } = render(<SymposiumProfilePicker value={null} onChange={onChange} />);
  await screen.findByText('Independent reviewer · v1');
  fireEvent.change(screen.getByLabelText('Saved profile'), { target: { value: 'reviewer:1' } });
  expect(onChange).toHaveBeenCalledWith({ profileId: 'reviewer', revision: 1 });
  rerender(
    <SymposiumProfilePicker value={{ profileId: 'reviewer', revision: 1 }} onChange={onChange} />,
  );
  expect(
    (screen.getByRole('button', { name: 'Revise selected' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Export JSON' }));
  expect(apiFetch).toHaveBeenCalledWith('/api/symposium/profiles/reviewer/1/export');
  await screen.findByLabelText('Portable profile export');
});

it.each(['save', 'import'])('keeps previous revisions selectable after %s', async (action) => {
  const older = { ...version, revision: 1 };
  const saved = { ...version, revision: 3 };
  vi.mocked(apiFetch).mockImplementation(async (_path, init) =>
    init?.method === 'POST' ? response(saved) : response([version, older]),
  );
  const onChange = vi.fn();
  render(
    <SymposiumProfilePicker value={{ profileId: 'reviewer', revision: 2 }} onChange={onChange} />,
  );
  await screen.findByText('Independent reviewer · v1');
  if (action === 'save') {
    fireEvent.click(screen.getByRole('button', { name: 'Revise selected' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
  } else {
    fireEvent.change(screen.getByLabelText('Import profile JSON'), {
      target: { value: JSON.stringify(saved) },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Import profile' }));
  }
  await screen.findByText('Independent reviewer · v3');
  expect(screen.getByText('Independent reviewer · v2')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Saved profile'), { target: { value: 'reviewer:1' } });
  expect(onChange).toHaveBeenLastCalledWith({ profileId: 'reviewer', revision: 1 });
});

it('edits an advisory reviewer recipe and saves it without applying to a seat', async () => {
  vi.mocked(apiFetch).mockImplementation(async (_path, init) =>
    init?.method === 'POST' ? response({ ...version, revision: 3 }) : response([version]),
  );
  render(
    <SymposiumProfilePicker value={{ profileId: 'reviewer', revision: 2 }} onChange={vi.fn()} />,
  );
  await screen.findByText('Independent reviewer · v2');
  fireEvent.click(screen.getByRole('button', { name: 'Revise selected' }));
  fireEvent.click(screen.getByLabelText('Include reusable recipe'));
  fireEvent.change(screen.getByLabelText('Reviewer template'), { target: { value: 'security' } });
  fireEvent.change(screen.getByLabelText('Skill references (one per line)'), {
    target: { value: 'risk-scan' },
  });
  fireEvent.click(screen.getByLabelText('ContexGin (explicit selection required)'));
  fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
  await waitFor(() =>
    expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true),
  );
  const [path, init] = vi.mocked(apiFetch).mock.calls.find(([, init]) => init?.method === 'POST')!;
  expect(path).toBe('/api/symposium/profiles');
  expect(JSON.parse(init!.body as string).definition.recipe).toMatchObject({
    version: 1,
    reviewerTemplate: 'security',
    skillRefs: ['risk-scan'],
    context: { sources: ['workspace', 'contexgin'] },
    toolDefaults: { mode: 'read-only' },
  });
  expect(
    vi.mocked(apiFetch).mock.calls.every(([path]) => path.startsWith('/api/symposium/profiles')),
  ).toBe(true);
});

it('starts an editable canonical security template without saving or selecting it', async () => {
  vi.mocked(apiFetch).mockResolvedValue(response([]));
  const onChange = vi.fn();
  render(<SymposiumProfilePicker value={null} onChange={onChange} />);
  fireEvent.click(await screen.findByRole('button', { name: 'New profile' }));
  fireEvent.change(screen.getByLabelText('Start from template'), { target: { value: 'security' } });
  expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Security reviewer');
  expect((screen.getByLabelText('Instructions') as HTMLTextAreaElement).value).toContain(
    'trust boundaries',
  );
  expect(onChange).not.toHaveBeenCalled();
  expect(apiFetch).toHaveBeenCalledTimes(1);
});

it('labels provider compatibility in user-facing terms', async () => {
  vi.mocked(apiFetch).mockResolvedValue(response([]));
  render(<SymposiumProfilePicker value={null} onChange={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'New profile' }));
  fireEvent.click(screen.getByLabelText('Include reusable recipe'));
  expect(screen.getByLabelText('ChatGPT subscription')).toBeTruthy();
  expect(screen.getByLabelText('OpenAI API')).toBeTruthy();
  expect(screen.getByLabelText('Vertex Claude')).toBeTruthy();
  expect(screen.getByLabelText('Vertex Gemini')).toBeTruthy();
});

it('resets template contents when switching to a custom profile', async () => {
  vi.mocked(apiFetch).mockResolvedValue(response([]));
  render(<SymposiumProfilePicker value={null} onChange={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'New profile' }));
  fireEvent.change(screen.getByLabelText('Start from template'), { target: { value: 'security' } });
  fireEvent.change(screen.getByLabelText('Start from template'), { target: { value: '' } });
  expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('');
  expect((screen.getByLabelText('Profile ID') as HTMLInputElement).value).toBe('');
  expect((screen.getByLabelText('Include reusable recipe') as HTMLInputElement).checked).toBe(
    false,
  );
});
