// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Link, MemoryRouter, useLocation } from 'react-router-dom';
import { AgentLibrary } from '../AgentLibrary';
import {
  createAgentTaskWorkingCopy,
  saveAgentTaskWorkingCopy,
} from '../../lib/agent-task-working-copy';
import { within } from '@testing-library/react';
import { apiFetch } from '../../lib/api-fetch';
import userEvent from '@testing-library/user-event';
import { openAgentBuilderChat, markAgentBuilderAssigned } from '../../lib/agent-builder-chat';
import { getChatDraft } from '../../lib/chat-drafts';
import { saveAgentLibraryWorkingCopy } from '../../lib/agent-library-working-copy';
function Location() {
  const location = useLocation();
  return <output aria-label="Current route">{location.pathname + location.search}</output>;
}

vi.mock('../../lib/api-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api-fetch')>()),
  apiFetch: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  sessionStorage.clear();
  localStorage.clear();
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
const response = (body: unknown, ok = true) =>
  ({
    ok,
    json: async () =>
      body && typeof body === 'object' && 'drafts' in body && 'versions' in body
        ? { ...body, tools: [] }
        : body,
  }) as Response;
async function setup({ edit = true } = {}) {
  vi.mocked(apiFetch).mockImplementation(async (path) =>
    response(path === '/api/agent-tasks' ? [] : { drafts: [], versions: [published] }),
  );
  const view = render(
    <MemoryRouter initialEntries={['/agent-library']}>
      <Location />
      <AgentLibrary />
    </MemoryRouter>,
  );
  if (edit) await beginEditingProfile();
  return view;
}
// Editor regressions explicitly enter editing; published reading is tested separately.
async function beginEditingProfile() {
  await waitFor(() =>
    expect(
      screen.queryByRole('tab', { name: 'Identity', hidden: true }) ||
        screen.queryByRole('tab', { name: 'Profile', hidden: true }),
    ).toBeTruthy(),
  );
  const edit = screen.queryByRole('button', { name: 'Edit profile' });
  if (edit) fireEvent.click(edit);
}
it('shows named agents and descriptors in a separate library', async () => {
  await setup();
  await beginEditingProfile();
  expect(screen.getByRole('heading', { name: 'Agent Library' })).toBeTruthy();
  expect(screen.getByLabelText('Descriptor')).toHaveProperty('value', 'The architect');
  expect(screen.getByRole('link', { name: 'Use in session' }).getAttribute('href')).toContain(
    'agentProfile=bob',
  );
  expect(screen.getByRole('link', { name: 'Use in session' }).getAttribute('href')).toContain(
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
    <MemoryRouter initialEntries={['/agent-library']}>
      <Location />
      <AgentLibrary />
    </MemoryRouter>,
  );
  await beginEditingProfile();
  fireEvent.change(await screen.findByLabelText('Agent name'), { target: { value: 'Robert' } });
  fireEvent.change(screen.getByLabelText('Descriptor'), { target: { value: 'Systems architect' } });
  expect(screen.queryByRole('link', { name: 'Use in session' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Publish revision' })).toHaveProperty(
      'disabled',
      false,
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Publish revision' }));
  await screen.findByRole('link', { name: 'Use in session' });
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
  await setup();
  await beginEditingProfile();
  fireEvent.change(await screen.findByLabelText('Agent name'), { target: { value: 'My Bob' } });
  vi.mocked(apiFetch).mockResolvedValue(response({ error: 'Draft version conflict' }, false));
  fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
  await screen.findByRole('alert');
  expect(screen.getByLabelText('Agent name')).toHaveProperty('value', 'My Bob');
  expect(screen.getByRole('button', { name: 'Save draft' })).toHaveProperty('disabled', false);
});
it('preserves spaces and newlines while typing criteria and normalizes only when saving', async () => {
  await setup();
  await beginEditingProfile();
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
  const first = await setup();
  await beginEditingProfile();
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
  await setup();
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
  await setup();
  await beginEditingProfile();
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
it('refines the exact unsaved profile in an ordinary Builder draft without inference', async () => {
  await setup();
  await beginEditingProfile();
  fireEvent.change(screen.getByLabelText('Agent name'), { target: { value: 'Working Bob' } });
  fireEvent.click(screen.getByRole('button', { name: 'Refine with Agent Builder' }));
  await waitFor(() =>
    expect(screen.getByLabelText('Current route').textContent).toContain('/chat?'),
  );
  const path = screen.getByLabelText('Current route').textContent!;
  expect(new URL(path, 'https://mitzo.example').pathname).toBe('/chat');
  const draft = getChatDraft(new URL(path, 'https://mitzo.example').searchParams.get('draft')!)!;
  expect(JSON.parse(draft.settings.sourceSnapshots![0].content)).toMatchObject({
    definition: { name: 'Working Bob' },
    source: { profileId: 'bob', kind: 'draft', baseRevision: 3, expectedVersion: 0 },
  });
  expect(screen.queryByRole('region', { name: 'Agent advisor' })).toBeNull();
  expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  expect(screen.getByLabelText('Agent name')).toHaveProperty('value', 'Working Bob');
});
it('starts creation in the ordinary Builder and keeps direct profile editing available', async () => {
  await setup();
  await beginEditingProfile();
  fireEvent.click(screen.getByRole('button', { name: 'Create with Agent Builder' }));
  await waitFor(() =>
    expect(screen.getByLabelText('Current route').textContent).toContain('/chat?'),
  );
  const path = screen.getByLabelText('Current route').textContent!;
  const draft = getChatDraft(new URL(path, 'https://mitzo.example').searchParams.get('draft')!)!;
  expect(draft.text).toBe('Help me create an agent.');
  expect(JSON.parse(draft.settings.sourceSnapshots![0].content).definition.name).toBe('');
  expect(screen.queryByRole('region', { name: 'Agent advisor' })).toBeNull();
  expect(screen.getByLabelText('Agent name')).toHaveProperty('value', '');
});

it('recovers unsaved edits after navigation without replacing their save basis', async () => {
  const first = await setup();
  await beginEditingProfile();
  fireEvent.change(await screen.findByLabelText('Agent name'), { target: { value: 'My Bob' } });
  first.unmount();
  await setup();
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
  const first = await setup();
  await beginEditingProfile();
  fireEvent.change(await screen.findByLabelText('Agent name'), { target: { value: '' } });
  fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'unfinished role ' } });
  fireEvent.click(screen.getByRole('tab', { name: 'Context' }));
  fireEvent.click(screen.getByLabelText('Include reusable recipe'));
  fireEvent.change(screen.getByLabelText('Skill references (one per line)'), {
    target: { value: ' draft skill \n' },
  });
  first.unmount();
  await setup();
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
  const first = await setup();
  await beginEditingProfile();
  fireEvent.change(await screen.findByLabelText('Agent name'), { target: { value: 'Temporary' } });
  fireEvent.click(screen.getByRole('button', { name: 'Discard unsaved edits' }));
  first.unmount();
  const second = await setup();
  await beginEditingProfile();
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
  await setup();
  await beginEditingProfile();
  expect(screen.queryByText('Unsaved edits')).toBeNull();
});

it('does not let a save acknowledgment from an unmounted editor erase newer working edits', async () => {
  const first = await setup();
  await beginEditingProfile();
  fireEvent.change(await screen.findByLabelText('Agent name'), { target: { value: 'First edit' } });
  let acknowledge!: (value: Response) => void;
  vi.mocked(apiFetch).mockReturnValueOnce(
    new Promise((resolve) => {
      acknowledge = resolve;
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
  first.unmount();
  const second = await setup();
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
  await setup();
  await screen.findByDisplayValue('Newer edit');
});

it('protects a dirty editor from closing its tab and retains the retry key after an uncertain save', async () => {
  const first = await setup();
  await beginEditingProfile();
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
  await setup();
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
  const first = await setup();
  await beginEditingProfile();
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
    <MemoryRouter initialEntries={['/agent-library']}>
      <Location />
      <AgentLibrary />
    </MemoryRouter>,
  );
  await screen.findByDisplayValue('My working name');
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Discard unsaved edits' })).toBeTruthy(),
  );
  expect(screen.getByLabelText('Agent name')).toHaveProperty('disabled', false);
  fireEvent.click(screen.getByRole('button', { name: 'Discard unsaved edits' }));
  await beginEditingProfile();
  await screen.findByDisplayValue('Shared newer name');
});

it('hands the selected historical revision to ordinary session setup and offers no standalone Symposium', async () => {
  await setup();
  await beginEditingProfile();
  expect(screen.getByRole('link', { name: 'Use in session' }).getAttribute('href')).toBe(
    '/chat?agentProfile=bob&profileRevision=3',
  );
  expect(screen.queryByRole('button', { name: /Use in Symposium/ })).toBeNull();
  expect(screen.queryByRole('link', { name: /Symposium/ })).toBeNull();
  fireEvent.click(screen.getByText('Library options'));
  expect(screen.getByRole('link', { name: 'Agent taskboard' }).getAttribute('href')).toBe('/tasks');
  fireEvent.click(screen.getByRole('tab', { name: 'Assigned tasks' }));
  expect(
    within(screen.getByRole('tabpanel', { name: 'Assigned tasks' })).getByText(
      'No assigned tasks yet.',
    ),
  ).toBeTruthy();
});

it('creates a task with the exact published binding, paused schedule and no execution', async () => {
  await setup();
  await beginEditingProfile();
  fireEvent.click(screen.getByRole('button', { name: 'Assign task' }));
  fireEvent.change(await screen.findByLabelText('Task name'), {
    target: { value: 'Morning review' },
  });
  fireEvent.change(screen.getByLabelText('Objective'), { target: { value: 'Review the queue' } });
  fireEvent.change(screen.getByLabelText('Schedule'), { target: { value: 'weekday' } });
  fireEvent.change(screen.getByLabelText('Timezone'), { target: { value: 'Europe/Dublin' } });
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path === '/api/agent-tasks' && init?.method === 'POST') {
      const body = JSON.parse(init.body as string);
      return response({
        taskId: body.taskId,
        revision: 1,
        definition: body.definition,
        configuration: { state: 'draft' },
        deleted: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }
    return response([]);
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save task' }));
  await screen.findByText('Task saved. Execution is not available yet.');
  const [, init] = vi
    .mocked(apiFetch)
    .mock.calls.find(([path, init]) => path === '/api/agent-tasks' && init?.method === 'POST')!;
  expect(JSON.parse(init!.body as string)).toMatchObject({
    expectedRevision: 0,
    definition: {
      name: 'Morning review',
      profile: { profileId: 'bob', revision: 3, contentHash: 'a'.repeat(64) },
      execution: null,
      schedule: { cron: '0 7 * * 1-5', timezone: 'Europe/Dublin', state: 'paused' },
    },
  });
  expect(screen.queryByRole('button', { name: 'Run now' })).toBeNull();
  expect(vi.mocked(apiFetch).mock.calls.some(([path]) => /runs|enable|resume/.test(path))).toBe(
    false,
  );
});

it('recovers incomplete task input across collection navigation, remount, failed save and conflict without changing retry identity', async () => {
  const first = await setup();
  await beginEditingProfile();
  fireEvent.click(screen.getByRole('button', { name: 'Assign task' }));
  fireEvent.change(await screen.findByLabelText('Task name'), { target: { value: ' My review ' } });
  fireEvent.change(screen.getByLabelText('Objective'), {
    target: { value: 'Keep my\n unfinished objective ' },
  });
  fireEvent.change(screen.getByLabelText('Schedule'), { target: { value: 'cron' } });
  fireEvent.change(screen.getByLabelText('Cron expression'), { target: { value: '' } });
  fireEvent.click(screen.getByRole('tab', { name: 'Profiles' }));
  fireEvent.change(screen.getByLabelText('Agent name'), { target: { value: 'Working Bob' } });
  fireEvent.click(screen.getByRole('tab', { name: 'Tasks & schedules' }));
  expect(screen.getByLabelText('Cron expression')).toHaveProperty('value', '');
  first.unmount();
  await setup();
  await screen.findByLabelText('Task name');
  expect(screen.getByLabelText('Objective')).toHaveProperty(
    'value',
    'Keep my\n unfinished objective ',
  );
  expect(screen.getByLabelText('Cron expression')).toHaveProperty('value', '');
  fireEvent.change(screen.getByLabelText('Cron expression'), { target: { value: '15 8 * * 1-5' } });
  vi.mocked(apiFetch).mockResolvedValue(response({ error: 'Task revision conflict' }, false));
  fireEvent.click(screen.getByRole('button', { name: 'Save task' }));
  await screen.findByText('Task revision conflict');
  expect(screen.getByLabelText('Task name')).toHaveProperty('value', ' My review ');
  fireEvent.click(screen.getByRole('button', { name: 'Save task' }));
  await waitFor(() =>
    expect(
      vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'POST'),
    ).toHaveLength(2),
  );
  const writes = vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(writes[0][1]!.body).toBe(writes[1][1]!.body);
  fireEvent.click(screen.getByRole('tab', { name: 'Profiles' }));
  expect(screen.getByLabelText('Agent name')).toHaveProperty('value', 'Working Bob');
});

it('keeps assigned tasks on r3 when r4 is published, retains rows after refresh error, and uses optimistic PUT for an explicit upgrade', async () => {
  const record = {
    taskId: 'task-one',
    revision: 6,
    definition: {
      name: 'Review',
      objective: 'Keep this objective',
      profile: { profileId: 'bob', revision: 3, contentHash: 'a'.repeat(64) },
      execution: {
        account: { accountId: 'work', provider: 'openai', profileRevision: 'account-r1' },
        harness: 'responses',
        targetId: 'retained-target',
        model: 'retained-model',
        reasoningEffort: 'high',
        mode: 'agent',
        authorityRefs: ['grant-one'],
      },
      workspace: { workspaceId: 'workspace-one', sourceRefs: ['source-one'] },
      schedule: null,
      notificationPolicy: 'results',
      outputPolicy: 'session',
    },
    configuration: { state: 'blocked', reason: 'admission-unavailable' },
    deleted: false,
    createdAt: '2026-10-15T00:00:00.000Z',
    updatedAt: '2026-10-15T00:00:00.000Z',
  };
  let failRefresh = false;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path === '/api/agent-tasks')
      return failRefresh ? response({ error: 'Refresh failed' }, false) : response([record]);
    if (init?.method === 'PUT') return response({ error: 'Task revision conflict' }, false);
    return response({
      drafts: [],
      versions: [{ ...published, revision: 4, contentHash: 'b'.repeat(64) }, published],
    });
  });
  render(
    <MemoryRouter initialEntries={['/agent-library']}>
      <Location />
      <AgentLibrary />
    </MemoryRouter>,
  );
  await beginEditingProfile();
  fireEvent.click(screen.getByRole('tab', { name: 'Assigned tasks' }));
  const assigned = within(screen.getByRole('tabpanel', { name: 'Assigned tasks' }));
  await assigned.findByText('Bob · r3 · Task revision 6');
  fireEvent.click(assigned.getByRole('button', { name: 'Task settings: Review' }));
  expect(screen.getByLabelText('Agent profile')).toHaveProperty('value', `bob:3:${'a'.repeat(64)}`);
  expect(screen.getByLabelText('Workspace reference')).toHaveProperty('value', 'workspace-one');
  failRefresh = true;
  fireEvent.click(screen.getByRole('button', { name: 'Refresh tasks' }));
  expect((await screen.findByRole('alert')).textContent).toBe('Refresh failed');
  expect(screen.getByRole('button', { name: 'Task settings: Review' })).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Agent profile'), {
    target: { value: `bob:4:${'b'.repeat(64)}` },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save task' }));
  expect((await screen.findByRole('alert')).textContent).toBe('Task revision conflict');
  const [path, init] = vi.mocked(apiFetch).mock.calls.find(([, init]) => init?.method === 'PUT')!;
  expect(path).toBe('/api/agent-tasks/task-one');
  const body = JSON.parse(init!.body as string);
  expect(body).toMatchObject({
    expectedRevision: 6,
    definition: {
      profile: { profileId: 'bob', revision: 4, contentHash: 'b'.repeat(64) },
      execution: record.definition.execution,
    },
  });
  expect(body).not.toHaveProperty('taskId');
  expect(screen.getByLabelText('Objective')).toHaveProperty('value', 'Keep this objective');
});

it('supports arrow navigation between Library collections and preserves the selected profile', async () => {
  await setup();
  await beginEditingProfile();
  const profiles = screen.getByRole('tab', { name: 'Profiles' });
  profiles.focus();
  fireEvent.keyDown(profiles, { key: 'ArrowRight' });
  expect(screen.getByRole('tab', { name: 'Tasks & schedules' }).getAttribute('aria-selected')).toBe(
    'true',
  );
  expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Tasks & schedules' }));
  fireEvent.keyDown(document.activeElement!, { key: 'Home' });
  expect(profiles.getAttribute('aria-selected')).toBe('true');
  expect(screen.getByLabelText('Agent name')).toHaveProperty('value', 'Bob');
});

it('does not replace newer task recovery input when a save completes after navigation', async () => {
  const first = await setup();
  await beginEditingProfile();
  fireEvent.click(screen.getByRole('button', { name: 'Assign task' }));
  fireEvent.change(await screen.findByLabelText('Task name'), { target: { value: 'Original' } });
  let finish!: (value: Response) => void;
  let posted: Record<string, unknown>;
  vi.mocked(apiFetch).mockImplementation((path, init) => {
    if (init?.method === 'POST') {
      posted = JSON.parse(init.body as string);
      return new Promise((resolve) => {
        finish = resolve;
      });
    }
    return Promise.resolve(
      response(path === '/api/agent-tasks' ? [] : { drafts: [], versions: [published] }),
    );
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save task' }));
  first.unmount();
  await setup();
  await screen.findByLabelText('Task name');
  fireEvent.change(screen.getByLabelText('Objective'), {
    target: { value: 'Newer input after returning' },
  });
  await act(async () =>
    finish(
      response({
        taskId: posted!.taskId,
        revision: 1,
        definition: posted!.definition,
        configuration: { state: 'draft' },
        deleted: false,
        createdAt: '2026-10-15T00:00:00.000Z',
        updatedAt: '2026-10-15T00:00:00.000Z',
      }),
    ),
  );
  await waitFor(() =>
    expect(JSON.parse(sessionStorage.getItem('mitzo-agent-task-working-copy')!).objective).toBe(
      'Newer input after returning',
    ),
  );
  expect(
    JSON.parse(sessionStorage.getItem('mitzo-agent-task-working-copy')!).expectedRevision,
  ).toBe(1);
  vi.mocked(apiFetch).mockImplementation(async (_path, init) => {
    const body = JSON.parse(init!.body as string);
    return response({
      taskId: posted!.taskId,
      revision: 2,
      definition: body.definition,
      configuration: { state: 'draft' },
      deleted: false,
      createdAt: '2026-10-15T00:00:00.000Z',
      updatedAt: '2026-10-15T00:00:00.000Z',
    });
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save task' }));
  await screen.findByText('Task saved. Execution is not available yet.');
  const put = vi.mocked(apiFetch).mock.calls.find(([, init]) => init?.method === 'PUT');
  expect(put).toBeTruthy();
  expect(JSON.parse(put![1]!.body as string)).toMatchObject({
    expectedRevision: 1,
    definition: { objective: 'Newer input after returning' },
  });
});

it('merges unrelated tasks from a delayed list while retaining the newer save receipt', async () => {
  let saved!: import('@mitzo/protocol').AgentTaskRecord;
  saveAgentTaskWorkingCopy({ ...createAgentTaskWorkingCopy(published), name: 'Saved receipt' });
  let finishList!: (value: Response) => void;
  vi.mocked(apiFetch).mockImplementation((path, init) => {
    if (path === '/api/agent-tasks' && !init?.method)
      return new Promise((resolve) => {
        finishList = resolve;
      });
    if (init?.method === 'POST') {
      const body = JSON.parse(init.body as string);
      saved = {
        taskId: body.taskId,
        revision: 1,
        definition: body.definition,
        configuration: { state: 'draft' },
        deleted: false,
        createdAt: '2026-10-15T00:00:00.000Z',
        updatedAt: '2026-10-15T00:00:00.000Z',
      };
      return Promise.resolve(response(saved));
    }
    return Promise.resolve(response({ drafts: [], versions: [published] }));
  });
  render(
    <MemoryRouter initialEntries={['/agent-library']}>
      <Location />
      <AgentLibrary />
    </MemoryRouter>,
  );
  await screen.findByLabelText('Task name');
  fireEvent.click(screen.getByRole('button', { name: 'Save task' }));
  await screen.findByText('Task saved. Execution is not available yet.');
  const unrelated = {
    ...saved,
    taskId: 'unrelated',
    definition: { ...saved.definition, name: 'Other saved task' },
  };
  await act(async () => finishList(response([unrelated])));
  await screen.findByRole('button', { name: 'Task settings: Other saved task' });
  expect(screen.getByRole('button', { name: 'Task settings: Saved receipt' })).toBeTruthy();
  vi.mocked(apiFetch).mockImplementation(async (path) =>
    response(path === '/api/agent-tasks' ? [] : { drafts: [], versions: [published] }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Refresh tasks' }));
  await screen.findByText('No assigned tasks yet.');
  expect(screen.queryByRole('button', { name: 'Task settings: Saved receipt' })).toBeNull();
});

it('keeps a newer known task row when an exact create retry returns its older durable receipt', async () => {
  const copy = { ...createAgentTaskWorkingCopy(published), name: 'Original task' };
  saveAgentTaskWorkingCopy(copy);
  const original = {
    taskId: copy.taskId,
    revision: 1,
    definition: {
      name: 'Original task',
      objective: '',
      profile: copy.profile,
      execution: null,
      workspace: null,
      schedule: null,
      notificationPolicy: 'results',
      outputPolicy: 'session',
    },
    configuration: { state: 'draft' },
    deleted: false,
    createdAt: '2026-10-15T00:00:00.000Z',
    updatedAt: '2026-10-15T00:00:00.000Z',
  };
  const newer = {
    ...original,
    revision: 2,
    definition: { ...original.definition, name: 'Edited elsewhere' },
  };
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path === '/api/agent-tasks') return response(init?.method === 'POST' ? original : [newer]);
    return response({ drafts: [], versions: [published] });
  });
  render(
    <MemoryRouter initialEntries={['/agent-library']}>
      <Location />
      <AgentLibrary />
    </MemoryRouter>,
  );
  await screen.findByRole('button', { name: 'Task settings: Edited elsewhere' });
  fireEvent.click(screen.getByRole('button', { name: 'Save task' }));
  await screen.findByText('Task saved. Execution is not available yet.');
  expect(screen.getByRole('button', { name: 'Task settings: Edited elsewhere' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Task settings: Original task' })).toBeNull();
});

it('retains incomplete execution choices when switching between saved tasks', async () => {
  const copy = {
    ...createAgentTaskWorkingCopy(published),
    name: 'Partial choices',
    runtime: {
      ...createAgentTaskWorkingCopy(published).runtime,
      account: { accountId: 'work', model: '', reasoningEffort: 'high' },
    },
  };
  saveAgentTaskWorkingCopy(copy);
  const definition = {
    name: copy.name,
    objective: '',
    profile: copy.profile,
    execution: null,
    workspace: null,
    schedule: null,
    notificationPolicy: 'results',
    outputPolicy: 'session',
  };
  const first = {
    taskId: copy.taskId,
    revision: 1,
    definition,
    configuration: { state: 'draft' },
    deleted: false,
    createdAt: '2026-10-15T00:00:00.000Z',
    updatedAt: '2026-10-15T00:00:00.000Z',
  };
  const second = {
    ...first,
    taskId: 'another-task',
    definition: { ...definition, name: 'Another task' },
  };
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path === '/api/agent-tasks')
      return response(init?.method === 'POST' ? first : [first, second]);
    return response({ drafts: [], versions: [published] });
  });
  render(
    <MemoryRouter initialEntries={['/agent-library']}>
      <Location />
      <AgentLibrary />
    </MemoryRouter>,
  );
  await screen.findByLabelText('Task name');
  expect(screen.getByLabelText('Task name')).toHaveProperty('value', 'Partial choices');
  fireEvent.click(screen.getByRole('button', { name: 'Save task' }));
  await screen.findByText('Task saved. Execution is not available yet.');
  fireEvent.click(screen.getByRole('button', { name: 'Close task editor' }));
  fireEvent.click(screen.getByRole('button', { name: 'Task settings: Another task' }));
  fireEvent.click(screen.getByRole('button', { name: 'Close task editor' }));
  first.revision = 2;
  fireEvent.click(screen.getByRole('button', { name: 'Refresh tasks' }));
  await screen.findByText(/r3 · Task revision 2/);
  fireEvent.click(screen.getByRole('button', { name: 'Task settings: Partial choices' }));
  expect(
    JSON.parse(sessionStorage.getItem('mitzo-agent-task-working-copy')!).runtime.account,
  ).toEqual({ accountId: 'work', model: '', reasoningEffort: 'high' });
  expect(screen.getByRole('button', { name: 'Reload saved task' })).toBeTruthy();
  vi.spyOn(window, 'confirm').mockReturnValueOnce(true);
  fireEvent.click(screen.getByRole('button', { name: 'Reload saved task' }));
  expect(
    JSON.parse(sessionStorage.getItem('mitzo-agent-task-working-copy')!).expectedRevision,
  ).toBe(2);
  expect(
    JSON.parse(sessionStorage.getItem('mitzo-agent-task-working-copy')!).runtime.account,
  ).toBeNull();
});

it('preserves task input through the accepted Tool library view and retains the profile Tools editor', async () => {
  await setup();
  await beginEditingProfile();
  fireEvent.click(screen.getByRole('button', { name: 'Assign task' }));
  fireEvent.change(await screen.findByLabelText('Objective'), {
    target: { value: 'Retain through tool browsing' },
  });
  fireEvent.click(screen.getByText('Library options'));
  fireEvent.click(screen.getByRole('button', { name: 'Tool library' }));
  expect(screen.getByRole('heading', { name: 'Tool library' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'New agent' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Agent library' }));
  expect(screen.getByLabelText('Objective')).toHaveProperty(
    'value',
    'Retain through tool browsing',
  );
  fireEvent.click(screen.getByRole('tab', { name: 'Profiles' }));
  fireEvent.click(screen.getByRole('tab', { name: 'Tools' }));
  expect(screen.getByRole('button', { name: 'Choose specific tools' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Use as reviewer' })).toBeNull();
});

it('notifies a remounted editor when its pending save is acknowledged without newer edits', async () => {
  const first = await setup();
  await beginEditingProfile();
  fireEvent.click(screen.getByRole('button', { name: 'Assign task' }));
  fireEvent.change(await screen.findByLabelText('Task name'), {
    target: { value: 'Pending save' },
  });
  let finish!: (value: Response) => void;
  let posted: Record<string, unknown>;
  vi.mocked(apiFetch).mockImplementation((_path, init) => {
    posted = JSON.parse(init!.body as string);
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save task' }));
  first.unmount();
  await setup();
  await screen.findByLabelText('Task name');
  await act(async () =>
    finish(
      response({
        taskId: posted!.taskId,
        revision: 1,
        definition: posted!.definition,
        configuration: { state: 'draft' },
        deleted: false,
        createdAt: '2026-10-15T00:00:00.000Z',
        updatedAt: '2026-10-15T00:00:00.000Z',
      }),
    ),
  );
  await screen.findByText('Task saved. Execution is not available yet.');
  expect(screen.getByText('Saved task · revision 1')).toBeTruthy();
  expect(
    JSON.parse(sessionStorage.getItem('mitzo-agent-task-working-copy')!).expectedRevision,
  ).toBe(1);
});

it('retains the Library and its mapped conversation during uncertain visibility and retries the same owner', async () => {
  await setup();
  await beginEditingProfile();
  const path = await openAgentBuilderChat(
    { profileId: 'bob', definition, expectedVersion: 0, baseRevision: 3, publishedRevision: 3 },
    false,
    published.contentHash,
  );
  const draft = getChatDraft(new URL(path, 'https://mitzo.example').searchParams.get('draft')!)!;
  markAgentBuilderAssigned(draft, 'retained-session');
  vi.mocked(apiFetch).mockResolvedValueOnce(new Response('{}', { status: 503 }));
  fireEvent.click(screen.getByRole('button', { name: 'Refine with Agent Builder' }));
  await screen.findByText(/Could not verify the retained Agent Builder conversation/);
  expect(screen.getByLabelText('Current route').textContent).toBe('/agent-library');
  expect(screen.getByLabelText('Agent name')).toHaveProperty('value', 'Bob');
  const retry = screen.getByRole('button', { name: 'Refine with Agent Builder' });
  await waitFor(() => expect(retry).toHaveProperty('disabled', false));
  vi.mocked(apiFetch).mockResolvedValueOnce(
    new Response(JSON.stringify({ sessionId: 'retained-session', isHidden: false })),
  );
  fireEvent.click(retry);
  await waitFor(() =>
    expect(screen.getByLabelText('Current route').textContent).toBe('/chat/retained-session'),
  );
});
it('opens fresh setup after authoritative hidden metadata instead of navigating back into the removed conversation', async () => {
  await setup();
  await beginEditingProfile();
  const path = await openAgentBuilderChat(
    { profileId: 'bob', definition, expectedVersion: 0, baseRevision: 3, publishedRevision: 3 },
    false,
    published.contentHash,
  );
  const draft = getChatDraft(new URL(path, 'https://mitzo.example').searchParams.get('draft')!)!;
  markAgentBuilderAssigned(draft, 'removed-session');
  vi.mocked(apiFetch).mockResolvedValueOnce(
    new Response(JSON.stringify({ sessionId: 'removed-session', isHidden: true })),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Refine with Agent Builder' }));
  await waitFor(() =>
    expect(screen.getByLabelText('Current route').textContent).toContain('/chat?'),
  );
  const next = new URL(
    screen.getByLabelText('Current route').textContent!,
    'https://mitzo.example',
  );
  expect(next.searchParams.get('draft')).not.toBe(draft.id);
  expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});

const taskProposalIdentity = {
  proposalId: 'review-task',
  sessionId: 'original-builder',
  taskId: 'proposed-task',
  expectedRevision: 0,
};
const taskProposalDefinition = {
  name: 'Proposed task',
  objective: 'Review the report',
  profile: { profileId: published.profileId, revision: 3, contentHash: published.contentHash },
  execution: null,
  workspace: null,
  schedule: null,
  notificationPolicy: 'results',
  outputPolicy: 'session',
};
const proposalLocation =
  '/agent-library?proposal=review-task&session=original-builder&task=proposed-task&revision=0';
function setupTaskProposal() {
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path === '/api/agent-tasks') return response([]);
    if (path.startsWith('/api/symposium/profile-proposals?'))
      return response([
        {
          ...taskProposalIdentity,
          kind: 'task',
          definition: taskProposalDefinition,
          state: 'pending',
          createdAt: Date.parse('2026-10-17T12:00:00.000Z'),
          savedTask: null,
        },
      ]);
    if (path.endsWith('/review-task/save')) {
      const request = JSON.parse(init!.body as string);
      return response({
        taskId: request.taskId,
        revision: 1,
        definition: request.definition,
        configuration: { state: 'draft' },
        deleted: false,
        createdAt: '2026-10-17T12:00:00.000Z',
        updatedAt: '2026-10-17T12:00:00.000Z',
      });
    }
    return response({ drafts: [], versions: [published] });
  });
  return render(
    <MemoryRouter initialEntries={[proposalLocation]}>
      <Location />
      <AgentLibrary />
    </MemoryRouter>,
  );
}
it('reviews an unsaved proposal in Library without replacing an independent task draft or saving on navigation', async () => {
  const manual = { ...createAgentTaskWorkingCopy(published), name: 'Independent draft' };
  saveAgentTaskWorkingCopy(manual);
  const retained = sessionStorage.getItem('mitzo-agent-task-working-copy');
  setupTaskProposal();
  expect(await screen.findByLabelText('Task name')).toHaveProperty('value', 'Proposed task');
  expect(screen.getByRole('tab', { name: 'Tasks & schedules' }).getAttribute('aria-selected')).toBe(
    'true',
  );
  expect(screen.getByRole('link', { name: 'Back to Agent Builder' }).getAttribute('href')).toBe(
    '/chat/original-builder',
  );
  expect(screen.queryByText(/This Library task is unavailable/)).toBeNull();
  expect(vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method)).toEqual([]);
  expect(sessionStorage.getItem('mitzo-agent-task-working-copy')).toBe(retained);
  fireEvent.change(screen.getByLabelText('Task name'), { target: { value: 'Reviewed proposal' } });
  fireEvent.click(screen.getByRole('link', { name: 'Close task review' }));
  await waitFor(() =>
    expect(screen.getByLabelText('Current route').textContent).toBe('/agent-library'),
  );
  expect(await screen.findByLabelText('Task name')).toHaveProperty('value', 'Independent draft');
  expect(sessionStorage.getItem('mitzo-agent-task-working-copy')).toBe(retained);
  expect(
    sessionStorage.getItem('mitzo-task-proposal-review:original-builder:review-task'),
  ).toContain('Reviewed proposal');
});

it('saves Library proposal review through its original proposal owner with a frozen revision', async () => {
  setupTaskProposal();
  fireEvent.change(await screen.findByLabelText('Task name'), {
    target: { value: 'Reviewed proposal' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save task' }));
  await screen.findByText(/Saved Reviewed proposal/);
  const writes = vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method);
  expect(writes).toHaveLength(1);
  expect(writes[0][0]).toBe('/api/symposium/profile-proposals/review-task/save');
  expect(JSON.parse(writes[0][1]!.body as string)).toEqual({
    sessionId: 'original-builder',
    kind: 'task',
    taskId: 'proposed-task',
    expectedRevision: 0,
    definition: { ...taskProposalDefinition, name: 'Reviewed proposal' },
  });
  expect(screen.getByRole('link', { name: 'Open Library task' }).getAttribute('href')).toBe(
    '/agent-library?task=proposed-task',
  );
});

it('keeps malformed proposal navigation out of generic task editing and preserves its retained input', async () => {
  const manual = { ...createAgentTaskWorkingCopy(published), name: 'Independent draft' };
  saveAgentTaskWorkingCopy(manual);
  const retained = sessionStorage.getItem('mitzo-agent-task-working-copy');
  vi.mocked(apiFetch).mockImplementation(async (path) =>
    response(path === '/api/agent-tasks' ? [] : { drafts: [], versions: [published] }),
  );
  render(
    <MemoryRouter
      initialEntries={['/agent-library?proposal=review-task&task=proposed-task&revision=0']}
    >
      <Location />
      <AgentLibrary />
    </MemoryRouter>,
  );
  await screen.findByText(/Task review link is incomplete or invalid/);
  expect(screen.queryByRole('button', { name: 'Save task' })).toBeNull();
  expect(screen.queryByLabelText('Task name')).toBeNull();
  expect(sessionStorage.getItem('mitzo-agent-task-working-copy')).toBe(retained);
  expect(vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method)).toEqual([]);
});

it('opens a published profile as readable guidance and keeps editing as an explicit action', async () => {
  await setup({ edit: false });
  await screen.findByRole('tab', { name: 'Profile' });
  expect(screen.getByRole('heading', { name: 'Instructions' })).toBeTruthy();
  expect(screen.getByText('Review assumptions.')).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Expected output' })).toBeTruthy();
  expect(screen.getByText('Decision brief')).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Success criteria' })).toBeTruthy();
  expect(screen.getByText('Cite evidence')).toBeTruthy();
  expect(screen.queryByLabelText('Agent name')).toBeNull();
  expect(screen.getByRole('link', { name: 'Use in session' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Assign task' })).toBeTruthy();
  expect(vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method)).toEqual([]);
  fireEvent.click(screen.getByRole('button', { name: 'Edit profile' }));
  expect(await screen.findByLabelText('Agent name')).toHaveProperty('value', 'Bob');
  expect(screen.getByRole('tab', { name: 'Context' })).toBeTruthy();
  expect(screen.getByRole('tab', { name: 'Tools' })).toBeTruthy();
  expect(screen.getByRole('tab', { name: 'Prompt preview' })).toBeTruthy();
});

it('returns a retained saved profile draft from Builder to editing and publication controls', async () => {
  saveAgentLibraryWorkingCopy({
    editor: {
      profileId: 'bob',
      definition,
      expectedVersion: 2,
      baseRevision: 3,
      publishedRevision: null,
    },
    saveKey: crypto.randomUUID(),
    dirty: false,
  });
  await setup({ edit: false });
  expect(await screen.findByLabelText('Agent name')).toHaveProperty('value', 'Bob');
  expect(screen.getByRole('button', { name: 'Publish revision' })).toHaveProperty(
    'disabled',
    false,
  );
  expect(screen.queryByRole('button', { name: 'Edit profile' })).toBeNull();
  expect(vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method)).toEqual([]);
});

it('resolves the saved task link again after another editor and a proposal review roundtrip', async () => {
  const makeTask = (taskId: string) => ({
    taskId,
    revision: 1,
    definition: { ...taskProposalDefinition, name: taskId },
    configuration: { state: 'draft' },
    deleted: false,
    createdAt: '2026-10-17T12:00:00.000Z',
    updatedAt: '2026-10-17T12:00:00.000Z',
  });
  vi.mocked(apiFetch).mockImplementation(async (path) => {
    if (path === '/api/agent-tasks') return response([makeTask('task-a'), makeTask('task-b')]);
    if (path.startsWith('/api/symposium/profile-proposals?')) return response([]);
    return response({ drafts: [], versions: [published] });
  });
  render(
    <MemoryRouter initialEntries={['/agent-library?task=task-a']}>
      <Location />
      <Link to={proposalLocation}>Open task proposal</Link>
      <Link to="/agent-library?task=task-a">Reopen saved task A</Link>
      <AgentLibrary />
    </MemoryRouter>,
  );
  expect(await screen.findByLabelText('Task name')).toHaveProperty('value', 'task-a');
  fireEvent.click(screen.getByRole('button', { name: 'Task settings: task-b' }));
  expect(screen.getByLabelText('Task name')).toHaveProperty('value', 'task-b');
  fireEvent.click(screen.getByRole('link', { name: 'Open task proposal' }));
  await screen.findByRole('button', { name: 'Retry task review' });
  fireEvent.click(screen.getByRole('link', { name: 'Close task review' }));
  expect(await screen.findByLabelText('Task name')).toHaveProperty('value', 'task-b');
  fireEvent.click(screen.getByRole('link', { name: 'Reopen saved task A' }));
  await waitFor(() => expect(screen.getByLabelText('Task name')).toHaveProperty('value', 'task-a'));
});

it('retains a newly assigned task after leaving a saved task link, reload and route return', async () => {
  const savedTask = {
    taskId: 'saved-task',
    revision: 1,
    definition: { ...taskProposalDefinition, name: 'Original saved task' },
    configuration: { state: 'draft' },
    deleted: false,
    createdAt: '2026-10-17T12:00:00.000Z',
    updatedAt: '2026-10-17T12:00:00.000Z',
  };
  const originalSaved = structuredClone(savedTask);
  vi.mocked(apiFetch).mockImplementation(async (path) =>
    response(path === '/api/agent-tasks' ? [savedTask] : { drafts: [], versions: [published] }),
  );
  function Owner() {
    const location = useLocation();
    return (
      <>
        <Location />
        {location.pathname === '/agent-library' ? (
          <>
            <Link to="/elsewhere">Leave Library</Link>
            <AgentLibrary />
          </>
        ) : (
          <Link to="/agent-library">Return to Library</Link>
        )}
      </>
    );
  }
  const open = (url: string) =>
    render(
      <MemoryRouter initialEntries={[url]}>
        <Owner />
      </MemoryRouter>,
    );
  const first = open('/agent-library?task=saved-task');
  expect(await screen.findByLabelText('Task name')).toHaveProperty('value', 'Original saved task');
  fireEvent.click(screen.getByRole('tab', { name: 'Profiles' }));
  fireEvent.click(screen.getByRole('button', { name: 'Assign task' }));
  fireEvent.change(screen.getByLabelText('Task name'), {
    target: { value: 'Independent new draft' },
  });
  fireEvent.change(screen.getByLabelText('Objective'), {
    target: { value: 'Unfinished independent objective' },
  });
  const retained = JSON.parse(sessionStorage.getItem('mitzo-agent-task-working-copy')!);
  expect(retained.taskId).not.toBe(savedTask.taskId);
  expect(retained.expectedRevision).toBe(0);
  const reloadUrl = screen.getByLabelText('Current route').textContent!;
  first.unmount();
  open(reloadUrl);
  await screen.findByRole('button', { name: 'Task settings: Original saved task' });
  expect(screen.getByLabelText('Task name')).toHaveProperty('value', 'Independent new draft');
  expect(screen.getByLabelText('Objective')).toHaveProperty(
    'value',
    'Unfinished independent objective',
  );
  expect(screen.getByLabelText('Current route').textContent).toBe('/agent-library');
  fireEvent.click(screen.getByRole('link', { name: 'Leave Library' }));
  fireEvent.click(screen.getByRole('link', { name: 'Return to Library' }));
  await screen.findByRole('button', { name: 'Task settings: Original saved task' });
  expect(screen.getByLabelText('Task name')).toHaveProperty('value', 'Independent new draft');
  expect(JSON.parse(sessionStorage.getItem('mitzo-agent-task-working-copy')!)).toEqual(retained);
  expect(savedTask).toEqual(originalSaved);
  expect(
    vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method && init.method !== 'GET'),
  ).toEqual([]);
});
