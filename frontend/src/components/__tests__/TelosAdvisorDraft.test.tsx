// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TelosAdvisorDraft } from '../TelosAdvisorDraft';
import * as transport from '../../lib/api-fetch';
import { TelosWorkApiClient } from '@mitzo/client';
import type { TelosWorkRoleContextSelection } from '@mitzo/protocol';
vi.mock('@mitzo/client/hooks', () => ({
  useMitzoStore: (select: (v: unknown) => unknown) => select({ messages: { running: false } }),
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});
function fixture(
  reviewed: Pick<TelosWorkRoleContextSelection, 'artifacts' | 'sources'> = {
    artifacts: [],
    sources: [],
  },
) {
  const revision = 'a'.repeat(64);
  let currentRevision = revision;
  vi.spyOn(transport, 'apiFetch').mockImplementation(
    async (url) =>
      new Response(
        JSON.stringify(
          String(url).endsWith('/meta')
            ? {
                sessionId: 'advisor',
                telosWorkRoleContext: {
                  version: 1,
                  itemId: 'item',
                  role: 'advisor',
                  advisorPurpose: 'refine',
                  brief: { revision, sha256: 'b'.repeat(64), text: 'Reviewed work' },
                  parentCriteria: [],
                  overallGoal: { itemId: 'item', revision, text: 'Goal' },
                  sources: structuredClone(reviewed.sources),
                  artifacts: structuredClone(reviewed.artifacts),
                },
              }
            : {
                messages: [
                  {
                    messageId: 'agreed',
                    role: 'assistant',
                    startedSeq: 3,
                    completedSeq: 9,
                    blocks: [],
                  },
                ],
                current: null,
                currents: [],
                cursor: 12,
              },
        ),
        { status: 200 },
      ),
  );
  vi.spyOn(TelosWorkApiClient.prototype, 'read').mockImplementation(
    async () =>
      ({
        itemId: 'item',
        revision: currentRevision,
        parentId: null,
      }) as never,
  );
  vi.spyOn(TelosWorkApiClient.prototype, 'readRecord').mockResolvedValue({
    itemId: 'item',
    summary: 'Home studio',
    intent: 'Record clearly',
    kind: 'outcome',
    categories: ['Personal projects'],
  } as never);
  const preview = vi.fn(async (input: { expectedRevision: string }) => {
    if (input.expectedRevision !== currentRevision) throw Error('Work item revision changed');
    return { sha256: 'c'.repeat(64), packet: {} };
  });
  const save = vi.fn(async (_input: unknown) => ({
    work: { itemId: 'item', revision: 'd'.repeat(64) },
  }));
  vi.spyOn(TelosWorkApiClient.prototype, 'previewAdvisorDraft').mockImplementation(
    preview as never,
  );
  vi.spyOn(TelosWorkApiClient.prototype, 'saveAdvisorDraft').mockImplementation(save as never);
  render(
    <MemoryRouter>
      <TelosAdvisorDraft conversationId="advisor" />
    </MemoryRouter>,
  );
  return {
    revision,
    preview,
    save,
    changeRevision: () => {
      currentRevision = 'e'.repeat(64);
    },
  };
}
it('saves a refinement using its completed message boundary despite trailing terminal bookkeeping', async () => {
  const { revision, preview, save } = fixture();
  fireEvent.click(await screen.findByRole('button', { name: 'Propose refinement' }));
  fireEvent.change(await screen.findByLabelText('Desired outcome'), {
    target: { value: 'Record the reviewed first session' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save refinement' }));
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(preview).toHaveBeenCalledOnce();
  expect(save.mock.calls[0][0]).toMatchObject({
    operation: 'refine',
    itemId: 'item',
    advisorConversationId: 'advisor',
    expectedRevision: revision,
    proposed: {
      name: 'Home studio',
      desiredOutcome: 'Record the reviewed first session',
      type: 'outcome',
      category: 'Personal projects',
    },
    selection: {
      sourceConversationId: 'advisor',
      mode: 'conversation_so_far',
      boundary: { sequence: 9, messageId: 'agreed' },
    },
    previewSha256: 'c'.repeat(64),
  });
  expect(transport.apiFetch).toHaveBeenCalledTimes(2);
});

it('preserves a proposal and rejects a concurrent item edit instead of overwriting it using a fresh revision', async () => {
  const { changeRevision, save } = fixture();
  fireEvent.click(await screen.findByRole('button', { name: 'Propose refinement' }));
  fireEvent.change(await screen.findByLabelText('Desired outcome'), {
    target: { value: 'My retained proposal' },
  });
  changeRevision();
  fireEvent.click(screen.getByRole('button', { name: 'Save refinement' }));
  await screen.findByRole('alert');
  expect(save).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Desired outcome')).toHaveProperty('value', 'My retained proposal');
});

it('retries an uncertain save with its original request and pins after a later item edit', async () => {
  const { changeRevision, preview, save } = fixture();
  save.mockRejectedValueOnce(Error('Response lost'));
  fireEvent.click(await screen.findByRole('button', { name: 'Propose refinement' }));
  await screen.findByLabelText('Desired outcome');
  fireEvent.click(screen.getByRole('button', { name: 'Save refinement' }));
  await screen.findByRole('alert');
  const original = structuredClone(save.mock.calls[0][0]);
  changeRevision();
  fireEvent.click(screen.getByRole('button', { name: 'Save refinement' }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  expect(save.mock.calls[1][0]).toEqual(original);
  expect(preview).toHaveBeenCalledOnce();
});
it('refuses a transcript without a retained completion anchor instead of falling back to its cursor', async () => {
  const { preview, save } = fixture();
  const original = vi.mocked(transport.apiFetch).getMockImplementation()!;
  vi.mocked(transport.apiFetch).mockImplementation(async (...args) => {
    const response = await original(...args);
    if (String(args[0]).endsWith('/meta')) return response;
    const history = await response.json();
    delete history.messages[0].completedSeq;
    return new Response(JSON.stringify(history), { status: 200 });
  });
  fireEvent.click(await screen.findByRole('button', { name: 'Propose refinement' }));
  await screen.findByLabelText('Desired outcome');
  fireEvent.click(screen.getByRole('button', { name: 'Save refinement' }));
  expect(await screen.findByRole('alert')).toHaveProperty(
    'textContent',
    'The completed planning exchange boundary is unavailable.',
  );
  expect(preview).not.toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
});
it('refuses a record that changes across the proposal opening boundary', async () => {
  const { changeRevision, preview, save } = fixture();
  const original = vi.mocked(TelosWorkApiClient.prototype.readRecord).getMockImplementation()!;
  vi.mocked(TelosWorkApiClient.prototype.readRecord).mockImplementation(async (...args) => {
    const record = await original(...args);
    changeRevision();
    return record;
  });
  fireEvent.click(await screen.findByRole('button', { name: 'Propose refinement' }));
  await screen.findByRole('alert');
  expect(screen.queryByLabelText('Desired outcome')).toBeNull();
  expect(preview).not.toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
});

it('retains exactly the advisor-reviewed material and source witness pins in preview, save and exact retry', async () => {
  const material = { artifactId: '1'.repeat(32), revision: 1, sha256: '2'.repeat(64) };
  const witness = { artifactId: '3'.repeat(32), revision: 4, sha256: '4'.repeat(64) };
  const reviewed: Pick<TelosWorkRoleContextSelection, 'artifacts' | 'sources'> = {
    artifacts: [material],
    sources: [
      {
        version: 1,
        snapshotId: '5'.repeat(64),
        itemId: 'item',
        source: { namespace: 'mitzo', conversationId: 'origin' },
        selection: {
          kind: 'selected',
          messageIds: ['original-choice'],
          blockIds: [],
          throughSequence: 1,
        },
        adoptedBrief: { revision: '6'.repeat(64), sha256: '7'.repeat(64) },
        artifacts: [material, witness],
        author: null,
        sourceCreatedAt: '2026-10-19T00:00:00Z',
        adoptedAt: '2026-10-19T00:00:01Z',
      },
    ],
  };
  const f = fixture(reviewed);
  f.save.mockRejectedValueOnce(Error('Response lost after commit'));
  fireEvent.click(await screen.findByRole('button', { name: 'Propose refinement' }));
  await screen.findByLabelText('Desired outcome');
  fireEvent.click(screen.getByRole('button', { name: 'Save refinement' }));
  await screen.findByRole('alert');
  const request = structuredClone(f.save.mock.calls[0][0]) as {
    selection: { artifacts: unknown[]; sourceConversationId: string; boundary: unknown };
  };
  expect(request.selection.artifacts).toEqual([material, witness]);
  expect(f.preview.mock.calls[0][0]).toMatchObject({
    selection: {
      artifacts: [material, witness],
      sourceConversationId: 'advisor',
      boundary: { sequence: 9, messageId: 'agreed' },
    },
  });
  // A later canonical/material revision cannot replace the already reviewed pins,
  // and an uncertain delivery retries the original retained request without preview.
  reviewed.artifacts[0] = { ...material, revision: 2, sha256: '8'.repeat(64) };
  f.changeRevision();
  fireEvent.click(screen.getByRole('button', { name: 'Save refinement' }));
  await waitFor(() => expect(f.save).toHaveBeenCalledTimes(2));
  expect(f.save.mock.calls[1][0]).toEqual(request);
  expect(f.preview).toHaveBeenCalledOnce();
  expect(transport.apiFetch).toHaveBeenCalledTimes(2);
});
