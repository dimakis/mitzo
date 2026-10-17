// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TelosAdvisorDraft } from '../TelosAdvisorDraft';
import * as transport from '../../lib/api-fetch';
import { TelosWorkApiClient } from '@mitzo/client';
vi.mock('@mitzo/client/hooks', () => ({
  useMitzoStore: (select: (v: unknown) => unknown) => select({ messages: { running: false } }),
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});
it('saves a refinement from a full ordinary advisor discussion through reviewed source preview without dispatching work', async () => {
  const revision = 'a'.repeat(64);
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
                  sources: [],
                  artifacts: [],
                },
              }
            : {
                messages: [{ messageId: 'agreed', role: 'user', blocks: [] }],
                current: null,
                currents: [],
                cursor: 9,
              },
        ),
        { status: 200 },
      ),
  );
  vi.spyOn(TelosWorkApiClient.prototype, 'read').mockResolvedValue({
    itemId: 'item',
    revision,
    parentId: null,
  } as never);
  vi.spyOn(TelosWorkApiClient.prototype, 'readRecord').mockResolvedValue({
    itemId: 'item',
    summary: 'Home studio',
    intent: 'Record clearly',
    kind: 'outcome',
    categories: ['Personal projects'],
  } as never);
  const preview = vi.fn(async (_input: unknown) => ({ sha256: 'c'.repeat(64), packet: {} }));
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
