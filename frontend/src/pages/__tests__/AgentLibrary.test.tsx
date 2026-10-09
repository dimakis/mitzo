// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AgentLibrary } from '../AgentLibrary';
import { apiFetch } from '../../lib/api-fetch';

vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const definition = {
  name: 'Bob',
  descriptor: 'The architect',
  description: 'Challenge designs.',
  role: 'reviewer',
  instructions: 'Review assumptions.',
  expectedOutput: 'Decision brief',
  acceptanceCriteria: ['Cite evidence'],
  modelPolicyRole: 'reviewer',
};
const published = { profileId: 'bob', revision: 3, definition, contentHash: 'a'.repeat(64) };
const response = (body: unknown, ok = true) => ({ ok, json: async () => body }) as Response;
function setup() {
  vi.mocked(apiFetch).mockResolvedValue(response({ drafts: [], versions: [published] }));
  render(
    <MemoryRouter>
      <AgentLibrary />
    </MemoryRouter>,
  );
}
it('shows named agents and descriptors in a separate library', async () => {
  setup();
  await screen.findByDisplayValue('Bob');
  expect(screen.getByRole('heading', { name: 'Agent Library' })).toBeTruthy();
  expect(screen.getByLabelText('Descriptor')).toHaveProperty('value', 'The architect');
  expect(screen.getByRole('link', { name: 'Use in chat' }).getAttribute('href')).toContain(
    'agentProfile=bob',
  );
  expect(screen.getByRole('link', { name: 'Use in chat' }).getAttribute('href')).toContain(
    'profileRevision=3',
  );
});
it('saves identity edits as a draft and publishes only that saved version', async () => {
  let drafts: unknown[] = [];
  let versions = [published];
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    if (path.endsWith('/drafts')) {
      const saved = { profileId: 'bob', version: 1, baseRevision: 3, definition: body.definition };
      drafts = [saved];
      return response(saved);
    }
    if (path.endsWith('/publish')) {
      const saved = {
        ...published,
        revision: 4,
        definition: (drafts[0] as typeof published).definition,
      };
      drafts = [];
      versions = [saved, published];
      return response(saved);
    }
    return response({ drafts, versions });
  });
  render(
    <MemoryRouter>
      <AgentLibrary />
    </MemoryRouter>,
  );
  fireEvent.change(await screen.findByLabelText('Agent name'), { target: { value: 'Robert' } });
  fireEvent.change(screen.getByLabelText('Descriptor'), { target: { value: 'Systems architect' } });
  expect(screen.queryByRole('link', { name: 'Use in chat' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Publish revision' })).toHaveProperty(
      'disabled',
      false,
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Publish revision' }));
  await screen.findByRole('link', { name: 'Use in chat' });
  const save = vi.mocked(apiFetch).mock.calls.find(([path]) => path.endsWith('/drafts'))!;
  expect(JSON.parse(save[1]!.body as string)).toMatchObject({
    expectedRevision: 3,
    expectedVersion: 0,
    definition: { name: 'Robert', descriptor: 'Systems architect' },
  });
  const publish = vi.mocked(apiFetch).mock.calls.find(([path]) => path.endsWith('/publish'))!;
  expect(JSON.parse(publish[1]!.body as string)).toMatchObject({
    expectedVersion: 1,
    profileId: 'bob',
  });
});
it('retains working edits when another device has changed the saved draft', async () => {
  setup();
  fireEvent.change(await screen.findByLabelText('Agent name'), { target: { value: 'My Bob' } });
  vi.mocked(apiFetch).mockResolvedValue(response({ error: 'Draft version conflict' }, false));
  fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
  await screen.findByRole('alert');
  expect(screen.getByLabelText('Agent name')).toHaveProperty('value', 'My Bob');
  expect(screen.getByRole('button', { name: 'Save draft' })).toHaveProperty('disabled', false);
});
it('offers an advisor chat that uses the existing profile proposal tool', async () => {
  setup();
  await screen.findByDisplayValue('Bob');
  const link = screen.getByRole('link', { name: 'Create with advisor' });
  const url = new URL(link.getAttribute('href')!, 'https://mitzo.example');
  expect(url.pathname).toBe('/chat');
  expect(url.searchParams.get('prompt')).toContain('SymposiumProposeProfile');
  expect(url.searchParams.get('prompt')).toContain('descriptor');
});
