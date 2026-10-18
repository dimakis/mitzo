// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TelosWorkRoleContextSelectionSchema } from '@mitzo/protocol';
import { TelosRoleSetup } from '../TelosRoleSetup';
import { localInventoryFixture } from '../../test-utils/local-inventory-fixture';
import { createChatRuntimeSelection } from '../../lib/chat-runtime-selection';
import { sha256Hex } from '../../lib/browser-crypto';
import { apiFetch } from '../../lib/api-fetch';
vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
function fixture(role: 'lead' | 'worker' | 'advisor' | 'reviewer' = 'lead', repository = false) {
  const inventory = localInventoryFixture(),
    account = inventory.accounts[0].account;
  inventory.agentProfiles[0].definition.name = 'People-work helper';
  inventory.agentProfiles[0].contentHash = sha256Hex(
    JSON.stringify(inventory.agentProfiles[0].definition),
  );
  const intent = {
    ...createChatRuntimeSelection(),
    account: { accountId: account.accountId, model: 'luna-fixture', reasoningEffort: 'low' },
    accountReference: account,
    agentProfile: { profileId: 'agent', revision: 1 },
    execution: { location: 'local' as const, targetId: 'mac' },
    capabilityRevision: inventory.capabilityRevision,
  };
  const context = TelosWorkRoleContextSelectionSchema.parse({
    version: 1,
    itemId: 'studio',
    role,
    brief: {
      revision: 'a'.repeat(64),
      sha256: 'b'.repeat(64),
      text: 'Arrange the recording session',
    },
    parentCriteria: [],
    overallGoal: { itemId: 'studio', revision: 'a'.repeat(64), text: 'Home recording session' },
    sources: [],
    artifacts: [],
    ...(role === 'advisor' ? { advisorPurpose: 'refine' } : {}),
    ...(role === 'worker' ? { leadConversationId: 'ordinary-lead' } : {}),
  });
  const presentation = {
    version: 1,
    contextSha256: sha256Hex(JSON.stringify(context)),
    reviewedAt: '2026-10-18T10:00:00Z',
    item: { itemId: 'studio', revision: 'a'.repeat(64), title: 'Arrange the recording session' },
    overallGoal: { itemId: 'studio', revision: 'a'.repeat(64), title: 'Home recording session' },
    parents: [],
    sources: [],
    artifacts: [],
  };
  const presentationRef = {
    id: '89b5166a-c549-4aa8-85f2-65dfbf0f2f81',
    sha256: sha256Hex(JSON.stringify(presentation)),
  };
  const prep = {
    version: 1,
    kind: 'ordinary',
    preparationId: '11111111-1111-4111-8111-111111111111',
    runtimeBinding: {
      version: 2,
      account,
      harness: { implementation: 'codex' },
      execution: { location: 'local', targetId: 'mac', targetRevision: 'target-r1' },
    },
    capabilities: [
      'ordinary_conversation',
      'writable_files',
      'retained_artifacts',
      'task_execution',
    ],
  };
  const work = {
    itemId: 'studio',
    kind: null,
    parentId: null,
    revision: 'a'.repeat(64),
    links: [],
    assignments: [],
    sources: [],
    attempts: [],
  };
  const onBound = vi.fn();
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    const path = String(url);
    if (path === '/api/ordinary/workspaces/prepare')
      return new Response(JSON.stringify(prep), { status: 201 });
    if (path === '/api/telos/work/items/studio') return new Response(JSON.stringify(work));
    if (path === '/api/telos/work/roles/review')
      return new Response(
        JSON.stringify({ version: 1, selection: context, presentation, presentationRef }),
      );
    if (
      path ===
      (repository
        ? '/api/telos/work/roles/setup-reviewed'
        : '/api/telos/work/roles/ordinary/setup-reviewed')
    ) {
      const wrapper = JSON.parse(String(init?.body));
      if (!repository)
        expect(wrapper).toMatchObject({
          version: 2,
          presentationRef,
          input: {
            version: 2,
            settings: {
              version: 2,
              workspace: { kind: 'ordinary', preparationId: prep.preparationId },
            },
          },
        });
      expect(
        JSON.parse(localStorage.getItem('mitzo-telos-role-setup:ordinary-draft')!).submission,
      ).toEqual(wrapper.input);
      return new Response(
        JSON.stringify({
          commandId: 'confirmed',
          actorId: 'operator:fixture',
          work: {
            ...work,
            links: [
              {
                version: 1,
                linkId: 'new-link',
                itemId: 'studio',
                role,
                conversation: { namespace: 'mitzo', conversationId: 'ordinary-bound' },
                linkedAt: null,
                linkedBy: 'operator:fixture',
                availability: 'available',
                attemptId: null,
              },
            ],
            assignments: ['lead', 'worker'].includes(role)
              ? [
                  {
                    itemId: 'studio',
                    role,
                    conversation: { namespace: 'mitzo', conversationId: 'ordinary-bound' },
                    revision: 1,
                    assignedAt: null,
                    assignedBy: 'operator:fixture',
                  },
                ]
              : [],
          },
        }),
      );
    }
    throw Error('Unexpected route ' + path);
  });
  const view = (draftId = 'ordinary-draft', bound = onBound, itemId = 'studio') => (
    <MemoryRouter>
      <TelosRoleSetup
        intent={{
          itemId,
          role,
          mode: ['lead', 'worker'].includes(role) ? 'assign' : 'additional',
          ...(role === 'advisor' ? { purpose: 'refine' } : {}),
        }}
        runtime={{ intent, inventory, reason: undefined } as never}
        mode="agent"
        draftId={draftId}
        repositoryWorkspaceId={repository ? '11111111-1111-4111-8111-111111111111' : undefined}
        onBound={bound}
        onLocked={vi.fn()}
        beforeConfirm={() => true}
      />
    </MemoryRouter>
  );
  return { view, prep, intent, inventory, onBound };
}
it.each(['lead', 'worker', 'advisor', 'reviewer'] as const)(
  'silently prepares and explicitly binds the ordinary %s with no repository or command route',
  async (role) => {
    const f = fixture(role);
    render(f.view());
    const label =
      role === 'lead'
        ? 'Assign lead & open chat'
        : role === 'worker'
          ? 'Assign worker & open chat'
          : 'Start chat';
    await waitFor(() =>
      expect((screen.getByRole('button', { name: label }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    expect(f.onBound).not.toHaveBeenCalled();
    expect(
      vi.mocked(apiFetch).mock.calls.filter(([path]) => String(path).endsWith('/prepare')),
    ).toHaveLength(1);
    expect(screen.queryByText(/a repository to continue/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: label }));
    await waitFor(() => expect(f.onBound).toHaveBeenCalledWith('ordinary-bound'));
    expect(
      vi
        .mocked(apiFetch)
        .mock.calls.some(([path]) => /repository|commands|chat\/.*send/.test(String(path))),
    ).toBe(false);
    const saved = JSON.parse(localStorage.getItem('mitzo-telos-role-setup:ordinary-draft')!);
    expect(saved.version).toBe(2);
    expect(saved.submission.settings.workspace.preparationId).toBe(f.prep.preparationId);
  },
);
it('reuses the retained preparation and exact uncertain reviewed request after component reload', async () => {
  const f = fixture(),
    delegate = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (url, init) =>
    String(url).endsWith('/setup-reviewed') ? Promise.reject(Error('lost')) : delegate(url, init),
  );
  const mounted = render(f.view());
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'Assign lead & open chat' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Assign lead & open chat' }));
  await screen.findByText(/Retry to recover the same request/);
  const original = vi
    .mocked(apiFetch)
    .mock.calls.find(([path]) => String(path).endsWith('/setup-reviewed'))![1]!.body;
  mounted.unmount();
  vi.mocked(apiFetch).mockClear();
  render(f.view());
  expect(vi.mocked(apiFetch)).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Assign lead & open chat' }));
  await waitFor(() => expect(vi.mocked(apiFetch)).toHaveBeenCalledOnce());
  expect(vi.mocked(apiFetch).mock.calls[0][1]!.body).toBe(original);
});
it('retains unsupported OpenShell intent actionably before preparation or allocation', async () => {
  const f = fixture();
  f.intent.execution.location = 'openshell' as never;
  render(f.view());
  expect(
    await screen.findByText(/Ordinary workspaces currently require a supported Local Mac Codex/),
  ).toBeTruthy();
  expect(vi.mocked(apiFetch)).not.toHaveBeenCalled();
  expect(f.intent.execution.location).toBe('openshell');
});

it.each([false, true])(
  'keeps a confirmed receipt with its draft across a failed handoff and same-mounted navigation (repository=%s)',
  async (repository) => {
    const f = fixture('lead', repository);
    // A real confirmed receipt remains mounted when the caller cannot flush/bind the draft.
    const failedHandoffA = vi.fn();
    const mounted = render(f.view('ordinary-draft', failedHandoffA));
    const button = () => screen.getByRole('button', { name: 'Assign lead & open chat' });
    await waitFor(() => expect((button() as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button());
    await waitFor(() => expect(failedHandoffA).toHaveBeenCalledWith('ordinary-bound'));
    const originalA = localStorage.getItem('mitzo-telos-role-setup:ordinary-draft')!;
    const savedB = JSON.parse(originalA);
    savedB.draftId = 'draft-b';
    savedB.receipt = null;
    savedB.submission.requestId = '22222222-2222-4222-8222-222222222222';
    const originalB = JSON.stringify(savedB);
    localStorage.setItem('mitzo-telos-role-setup:draft-b', originalB);
    localStorage.setItem('fixture-unsent-draft-b', 'Newer unsent B draft');
    const boundB = vi.fn();
    const count = () =>
      vi.mocked(apiFetch).mock.calls.filter(([path]) => String(path).endsWith('/setup-reviewed'))
        .length;
    const setupCount = count();
    mounted.rerender(f.view('draft-b', boundB));
    await waitFor(() => expect((button() as HTMLButtonElement).disabled).toBe(false));
    expect(boundB).not.toHaveBeenCalled();
    expect(localStorage.getItem('mitzo-telos-role-setup:draft-b')).toBe(originalB);
    expect(localStorage.getItem('fixture-unsent-draft-b')).toBe('Newer unsent B draft');
    expect(count()).toBe(setupCount);
    // Returning to A recovers only its exact retained chat and sends no replacement setup.
    const recoveredA = vi.fn();
    mounted.rerender(f.view('ordinary-draft', recoveredA));
    await waitFor(() => expect(recoveredA).toHaveBeenCalledWith('ordinary-bound'));
    expect(localStorage.getItem('mitzo-telos-role-setup:ordinary-draft')).toBe(originalA);
    expect(boundB).not.toHaveBeenCalled();
    expect(count()).toBe(setupCount);
    const foreignIntent = vi.fn();
    mounted.rerender(f.view('ordinary-draft', foreignIntent, 'another-item'));
    expect(foreignIntent).not.toHaveBeenCalled();
    expect(screen.queryByText('Linked work context')).toBeNull();
    fireEvent.click(button());
    expect(foreignIntent).not.toHaveBeenCalled();
    expect(count()).toBe(setupCount);
    expect(localStorage.getItem('mitzo-telos-role-setup:ordinary-draft')).toBe(originalA);
    mounted.rerender(f.view('ordinary-draft', recoveredA));
    await waitFor(() => expect(recoveredA).toHaveBeenCalledTimes(2));
  },
);
