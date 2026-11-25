// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { MitzoApiClient } from '@mitzo/client';
import { ConversationAgents } from '../ConversationAgents';
import { createConversationJoiningApplicationOwner } from '../../lib/conversation-joining-application-owner';
import * as auth from '../../lib/api-fetch';

vi.mock('../AccountModelPicker', () => ({ AccountModelPicker: () => null }));
vi.mock('../ChatAgentProfilePicker', () => ({ ChatAgentProfilePicker: () => null }));
vi.mock('../ConversationRepositoryPicker', () => ({ ConversationRepositoryPicker: () => null }));
const group = '00000000-0000-4000-8000-000000000010';
const pin = { artifactId: 'retained-output', revision: 2, sha256: 'a'.repeat(64) };
beforeEach(async () => {
  localStorage.clear();
  sessionStorage.clear();
  auth.markAuthLost();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ ok: true, authSessionId: 'source-catalog-login' })),
  );
  await auth.restoreCookieAuthentication();
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mount(fetch: (url: string, init?: RequestInit) => Promise<Response>) {
  const owner = createConversationJoiningApplicationOwner({
    api: new MitzoApiClient(fetch),
    sourceConversationId: 'source-chat',
    collaborationId: group,
    getClientId: () => 'connection-first',
    getVerifiedAuthScope: auth.currentVerifiedAuthSessionId,
  });
  const result = render(
    <MemoryRouter>
      <ConversationAgents
        scope="source-chat"
        agents={[{ id: 'source-chat', name: 'Architect', state: 'Ready' }]}
        messages={[
          {
            messageId: 'message-one',
            role: 'assistant',
            timestamp: 1_790_000_000_000,
            blocks: [
              { blockId: 'text', blockType: 'text', content: 'Plan references /tmp/plan.md' },
            ],
          },
        ]}
        joiningOwner={owner}
      />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Agents, Architect' }));
  fireEvent.click(screen.getByRole('button', { name: 'Add agent' }));
  fireEvent.click(screen.getByRole('button', { name: /Starting context,/ }));
  fireEvent.change(screen.getByRole('combobox', { name: 'Context' }), {
    target: { value: 'selected' },
  });
  return { ...result, owner };
}

it('reads the authorized retained catalog through the real client and renders failure/retry without beginning or joining', async () => {
  const diagnostic = vi.spyOn(console, 'warn').mockImplementation(() => {});
  let unavailable = true;
  const request = vi.fn(async () =>
    unavailable
      ? Response.json(
          { error: 'Source unavailable', code: 'execution_unavailable' },
          { status: 503 },
        )
      : Response.json({
          sourceConversationId: 'source-chat',
          artifacts: [
            { ...pin, title: 'Retained plan', available: true },
            {
              ...pin,
              artifactId: 'unavailable-output',
              title: 'Restricted plan',
              available: false,
            },
          ],
        }),
  );
  mount(request);
  await screen.findByRole('button', { name: 'Retry artifact list' });
  expect(screen.getByRole('alert').textContent).toContain('Your selections are unchanged');
  expect(diagnostic).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({
      code: 'conversation_context_artifacts_unavailable',
      sourceConversationId: 'source-chat',
    }),
  );
  unavailable = false;
  fireEvent.click(screen.getByRole('button', { name: 'Retry artifact list' }));
  const available = await screen.findByRole('checkbox', { name: /Retained plan/ });
  expect((available as HTMLInputElement).checked).toBe(false);
  fireEvent.click(available);
  expect((available as HTMLInputElement).checked).toBe(true);
  expect(
    (screen.getByRole('checkbox', { name: /Restricted plan/ }) as HTMLInputElement).disabled,
  ).toBe(true);
  expect(screen.getAllByText(/Author.*(unavailable|not recorded)/i).length).toBeGreaterThan(0);
  for (const [url, init] of request.mock.calls as unknown as [string, RequestInit | undefined][]) {
    expect(url).toContain(`/api/session-collaborations/${group}/context-source-artifacts?`);
    expect(url).toContain('sourceConversationId=source-chat');
    expect(url).toContain('clientId=connection-first');
    expect(init?.method ?? 'GET').toBe('GET');
  }
  expect(request).toHaveBeenCalledTimes(2);
  fireEvent.change(screen.getByRole('searchbox', { name: /Search/ }), {
    target: { value: 'absent text' },
  });
  expect(
    (screen.getByRole('checkbox', { name: /Retained plan/ }) as HTMLInputElement).checked,
  ).toBe(true);
});

it('rejects mismatched source metadata and retired authentication before presenting artifacts', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const request = vi.fn(async () =>
    Response.json({
      sourceConversationId: 'other-chat',
      artifacts: [{ ...pin, title: 'Wrong source', available: true }],
    }),
  );
  const { owner } = mount(request);
  await screen.findByRole('button', { name: 'Retry artifact list' });
  expect(screen.queryByText('Wrong source')).toBeNull();
  auth.markAuthLost();
  await expect(owner.loadArtifacts!(new AbortController().signal)).rejects.toThrow(
    'Application review owner unavailable',
  );
  expect(request).toHaveBeenCalledTimes(1);
});

it('ignores a late catalog after the selector is closed', async () => {
  let complete!: (response: Response) => void;
  const request = vi.fn(
    (_url: string, _init?: RequestInit) =>
      new Promise<Response>((resolve) => {
        complete = resolve;
      }),
  );
  mount(request);
  await waitFor(() => expect(request).toHaveBeenCalledOnce());
  fireEvent.click(
    within(screen.getByRole('dialog', { name: 'Add agent' })).getByRole('button', { name: 'Done' }),
  );
  complete(
    Response.json({
      sourceConversationId: 'source-chat',
      artifacts: [{ ...pin, title: 'Late artifact', available: true }],
    }),
  );
  await waitFor(() => expect(request.mock.calls[0][1]?.signal?.aborted).toBe(true));
  expect(screen.queryByText('Late artifact')).toBeNull();
});
