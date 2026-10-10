// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AgentLibrary } from '../AgentLibrary';
import { apiFetch } from '../../lib/api-fetch';
import userEvent from '@testing-library/user-event';

vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  sessionStorage.clear();
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
  return render(
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
it('preserves spaces and newlines while typing criteria and normalizes only when saving', async () => {
  setup();
  await screen.findByDisplayValue('Bob');
  fireEvent.click(screen.getByRole('tab', { name: 'Instructions' }));
  const area = screen.getByLabelText('Acceptance criteria');
  const user = userEvent.setup();
  await user.clear(area);
  await user.type(area, 'Use evidence \n Compare options ');
  expect(area).toHaveProperty('value', 'Use evidence \n Compare options ');
  vi.mocked(apiFetch).mockImplementation(async (_path, init) => {
    const body = JSON.parse(init!.body as string);
    return response({ profileId: 'bob', version: 1, baseRevision: 3, definition: body.definition });
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
  await screen.findByText('Draft saved. Existing chats keep their published revision.');
  const save = vi.mocked(apiFetch).mock.calls.find(([path]) => path.endsWith('/drafts'))!;
  expect(JSON.parse(save[1]!.body as string).definition.acceptanceCriteria).toEqual([
    'Use evidence',
    'Compare options',
  ]);
});

it('recovers incomplete compiler recipe edits and normalizes them only when saving', async () => {
  const first = setup();
  await screen.findByDisplayValue('Bob');
  fireEvent.click(screen.getByRole('tab', { name: 'Context' }));
  fireEvent.click(screen.getByLabelText('Compile chat context'));
  fireEvent.change(screen.getByLabelText('Documents (one per line)'), {
    target: { value: ' docs/design.md \n' },
  });
  fireEvent.change(screen.getByLabelText('Required sections (one per line)'), {
    target: { value: ' docs/design.md > Design > Architecture notes \n' },
  });
  fireEvent.change(screen.getByLabelText('Token budget'), { target: { value: '' } });
  first.unmount();
  setup();
  await screen.findByText('Unsaved edits');
  fireEvent.click(screen.getByRole('tab', { name: 'Context' }));
  expect(screen.getByLabelText('Documents (one per line)')).toHaveProperty(
    'value',
    ' docs/design.md \n',
  );
  expect(screen.getByLabelText('Required sections (one per line)')).toHaveProperty(
    'value',
    ' docs/design.md > Design > Architecture notes \n',
  );
  fireEvent.change(screen.getByLabelText('Token budget'), { target: { value: '4000' } });
  vi.mocked(apiFetch).mockImplementation(async (_path, init) => {
    const body = JSON.parse(init!.body as string);
    return response({ profileId: 'bob', version: 1, baseRevision: 3, definition: body.definition });
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
  await screen.findByText('Draft saved. Existing chats keep their published revision.');
  const save = vi.mocked(apiFetch).mock.calls.find(([path]) => path.endsWith('/drafts'))!;
  expect(JSON.parse(save[1]!.body as string).definition.contextRecipe).toEqual({
    version: 1,
    source: 'workspace',
    files: ['docs/design.md'],
    tokenBudget: 4000,
    required: [['docs/design.md', 'Design', 'Architecture notes']],
    excluded: [],
  });
});
it('previews the actual compiled prompt with source and trimming details and clears stale output on error', async () => {
  setup();
  await screen.findByDisplayValue('Bob');
  fireEvent.click(screen.getByRole('tab', { name: 'Context' }));
  fireEvent.click(screen.getByLabelText('Compile chat context'));
  fireEvent.change(screen.getByLabelText('Documents (one per line)'), {
    target: { value: 'docs/design.md' },
  });
  fireEvent.click(screen.getByRole('tab', { name: 'Prompt preview' }));
  vi.mocked(apiFetch).mockResolvedValueOnce(
    response({
      profilePrompt: 'Profile guidance',
      assembledPrompt: 'Profile guidance\n# Boot Context\nCompiled architecture context',
      contextResolved: true,
      previewScope: 'configured-workspace',
      compiledContext: {
        source: 'workspace',
        compilerRevision: 'fixture',
        recipeHash: 'a'.repeat(64),
        payloadHash: 'b'.repeat(64),
        workspaceIdentity: 'c'.repeat(64),
        context: {
          type: 'boot_context',
          source: 'contexgin',
          sourceCount: 1,
          tokenCount: 200,
          tokenBudget: 4000,
          sources: [{ path: 'docs/design.md', kind: 'reference' }],
          included: [],
          trimmed: [
            {
              source: 'docs/design.md',
              heading: 'Background',
              tokens: 800,
              content: 'Optional background',
            },
          ],
          fullMarkdown: 'Compiled architecture context',
        },
      },
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Compile preview' }));
  await screen.findByText(/Compiled architecture context/);
  expect(screen.getByText('docs/design.md')).toBeTruthy();
  expect(screen.getByText(/200.*4,000 tokens/)).toBeTruthy();
  expect(screen.getByText(/Background/)).toBeTruthy();
  vi.mocked(apiFetch).mockResolvedValueOnce(
    response({ error: 'Selected source is unavailable' }, false),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Compile preview' }));
  await screen.findByRole('alert');
  expect(screen.queryByText(/Compiled architecture context/)).toBeNull();
});
it('offers an advisor chat that uses the existing profile proposal tool', async () => {
  setup();
  await screen.findByDisplayValue('Bob');
  const link = screen.getByRole('link', { name: 'Create with advisor' });
  const url = new URL(link.getAttribute('href')!, 'https://mitzo.example');
  expect(url.pathname).toBe('/chat');
  expect(url.searchParams.get('prompt')).toContain('SymposiumProposeProfile');
  expect(url.searchParams.get('prompt')).toContain('descriptor');
  expect(url.searchParams.get('prompt')).toContain('contextRecipe');
  expect(url.searchParams.get('prompt')).toContain('local chats');
  expect(url.searchParams.get('prompt')).toContain('tokenBudget');
  expect(url.searchParams.get('prompt')).toContain('supported OpenShell sandboxes');
  expect(url.searchParams.get('prompt')).toContain('Symposium still requires');
});

it('recovers unsaved edits after navigation without replacing their save basis', async () => {
  const first = setup();
  fireEvent.change(await screen.findByLabelText('Agent name'), { target: { value: 'My Bob' } });
  first.unmount();
  setup();
  await screen.findByDisplayValue('My Bob');
  expect(screen.getByText('Unsaved edits')).toBeTruthy();
  vi.mocked(apiFetch).mockResolvedValue(response({ error: 'Draft version conflict' }, false));
  fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
  await screen.findByRole('alert');
  const save = vi.mocked(apiFetch).mock.calls.find(([path]) => path.endsWith('/drafts'))!;
  expect(JSON.parse(save[1]!.body as string)).toMatchObject({
    expectedVersion: 0,
    expectedRevision: 3,
    definition: { name: 'My Bob' },
  });
});

it('recovers incomplete raw fields and recipe lines after refresh', async () => {
  const first = setup();
  fireEvent.change(await screen.findByLabelText('Agent name'), { target: { value: '' } });
  fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'unfinished role ' } });
  fireEvent.click(screen.getByRole('tab', { name: 'Context' }));
  fireEvent.click(screen.getByLabelText('Include reusable recipe'));
  fireEvent.change(screen.getByLabelText('Skill references (one per line)'), {
    target: { value: ' draft skill \n' },
  });
  first.unmount();
  setup();
  await screen.findByText('Unsaved edits');
  expect(screen.getByLabelText('Agent name')).toHaveProperty('value', '');
  expect(screen.getByLabelText('Role')).toHaveProperty('value', 'unfinished role ');
  fireEvent.click(screen.getByRole('tab', { name: 'Context' }));
  expect(screen.getByLabelText('Skill references (one per line)')).toHaveProperty(
    'value',
    ' draft skill \n',
  );
});

it('removes recovery only after explicit discard or a confirmed save', async () => {
  const first = setup();
  fireEvent.change(await screen.findByLabelText('Agent name'), { target: { value: 'Temporary' } });
  fireEvent.click(screen.getByRole('button', { name: 'Discard unsaved edits' }));
  first.unmount();
  const second = setup();
  await screen.findByDisplayValue('Bob');
  fireEvent.change(screen.getByLabelText('Agent name'), { target: { value: 'Saved Bob' } });
  vi.mocked(apiFetch).mockResolvedValue(
    response({
      profileId: 'bob',
      version: 1,
      baseRevision: 3,
      definition: { ...definition, name: 'Saved Bob' },
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
  await screen.findByText('Draft saved. Existing chats keep their published revision.');
  second.unmount();
  setup();
  await screen.findByDisplayValue('Bob');
  expect(screen.queryByText('Unsaved edits')).toBeNull();
});

it('does not let a save acknowledgment from an unmounted editor erase newer working edits', async () => {
  const first = setup();
  fireEvent.change(await screen.findByLabelText('Agent name'), { target: { value: 'First edit' } });
  let acknowledge!: (value: Response) => void;
  vi.mocked(apiFetch).mockReturnValueOnce(
    new Promise((resolve) => {
      acknowledge = resolve;
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
  first.unmount();
  const second = setup();
  await screen.findByDisplayValue('First edit');
  fireEvent.change(screen.getByLabelText('Agent name'), { target: { value: 'Newer edit' } });
  acknowledge(
    response({
      profileId: 'bob',
      version: 1,
      baseRevision: 3,
      definition: { ...definition, name: 'First edit' },
    }),
  );
  await waitFor(() =>
    expect(screen.getByLabelText('Agent name')).toHaveProperty('value', 'Newer edit'),
  );
  second.unmount();
  setup();
  await screen.findByDisplayValue('Newer edit');
});

it('protects a dirty editor from closing its tab and retains the retry key after an uncertain save', async () => {
  const first = setup();
  fireEvent.change(await screen.findByLabelText('Agent name'), {
    target: { value: 'Working Bob' },
  });
  const unload = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(unload);
  expect(unload.defaultPrevented).toBe(true);
  vi.mocked(apiFetch).mockRejectedValueOnce(Error('Connection lost'));
  fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
  await screen.findByRole('alert');
  const before = vi.mocked(apiFetch).mock.calls.find(([path]) => path.endsWith('/drafts'))!;
  first.unmount();
  setup();
  await screen.findByDisplayValue('Working Bob');
  vi.mocked(apiFetch).mockResolvedValueOnce(response({ error: 'offline' }, false));
  fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
  await screen.findByRole('alert');
  const after = vi
    .mocked(apiFetch)
    .mock.calls.filter(([path]) => path.endsWith('/drafts'))
    .at(-1)!;
  expect(JSON.parse(after[1]!.body as string)).toEqual(JSON.parse(before[1]!.body as string));
});

it('keeps recovered edits actionable when another device publishes a newer revision', async () => {
  const first = setup();
  fireEvent.change(await screen.findByLabelText('Agent name'), {
    target: { value: 'My working name' },
  });
  first.unmount();
  vi.mocked(apiFetch).mockResolvedValue(
    response({
      drafts: [],
      versions: [
        { ...published, revision: 4, definition: { ...definition, name: 'Shared newer name' } },
        published,
      ],
    }),
  );
  render(
    <MemoryRouter>
      <AgentLibrary />
    </MemoryRouter>,
  );
  await screen.findByDisplayValue('My working name');
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Discard unsaved edits' })).toBeTruthy(),
  );
  expect(screen.getByLabelText('Agent name')).toHaveProperty('disabled', false);
  fireEvent.click(screen.getByRole('button', { name: 'Discard unsaved edits' }));
  await screen.findByDisplayValue('Shared newer name');
});
