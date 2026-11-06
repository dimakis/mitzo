// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ChatInput } from '../ChatInput';
import { ComposerTools } from '../ComposerTools';
import { Link, MemoryRouter, Route, Routes, useParams, useSearchParams } from 'react-router-dom';
import { apiFetch } from '../../lib/api-fetch';
import { chatComposerCapabilities } from '../../lib/chat-composer-capabilities';
vi.mock('../../lib/api-fetch', async (original) => ({
  ...(await original<object>()),
  apiFetch: vi.fn(),
}));
vi.mock('../MicButton', () => ({ MicButton: () => null }));
vi.mock('../SessionResourcesDialog', () => ({ SessionResourcesDialog: () => null }));
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.mocked(apiFetch).mockReset();
});

it.each([false, true])('names the icon-only desktop terminal link with router=%s', (router) => {
  const tools = (
    <>
      <style>{'.composer-tools-label { display: none; }'}</style>
      <ComposerTools
        terminalHref="/terminal?returnTo=%2Fchat"
        onCommands={vi.fn()}
        commandsExpanded={false}
        onAttach={vi.fn()}
        attachmentDisabled={false}
        onDismiss={vi.fn()}
      />
    </>
  );
  render(router ? <MemoryRouter>{tools}</MemoryRouter> : tools);
  expect(screen.getByRole('link', { name: 'Terminal' })).toHaveAttribute(
    'href',
    '/terminal?returnTo=%2Fchat',
  );
});

it.each(['/chat?draft=runtime-tools', '/chat/host-chat'])(
  'retains the edited draft through terminal navigation from %s',
  async (path) => {
    function Composer() {
      const { sessionId } = useParams();
      return (
        <ChatInput
          sessionId={sessionId}
          draftStorageKey={sessionId ? undefined : 'runtime-tools-draft'}
          initialText={sessionId ? undefined : 'Keep this draft'}
          onSend={vi.fn(() => true)}
          onStop={vi.fn()}
          running={false}
          composerCapabilities={chatComposerCapabilities({
            ordinary: true,
            location: 'local',
            sessionId,
            draftId: 'runtime-tools',
            blocked: false,
          })}
        />
      );
    }
    function Terminal() {
      const [params] = useSearchParams();
      return <Link to={params.get('returnTo')!}>Back to chat</Link>;
    }
    render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/chat" element={<Composer />} />
          <Route path="/chat/:sessionId" element={<Composer />} />
          <Route path="/terminal" element={<Terminal />} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'Message Mitzo' }), {
      target: { value: '/mockup Retained host draft' },
    });
    fireEvent.click(screen.getByRole('link', { name: 'Terminal' }));
    fireEvent.click(await screen.findByRole('link', { name: 'Back to chat' }));
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Message Mitzo' })).toHaveValue(
        '/mockup Retained host draft',
      ),
    );
  },
);

it.each([undefined, 'host-chat'])(
  'enables host terminal and supported skills with an ordinary owner (%s)',
  async (sessionId) => {
    vi.mocked(apiFetch).mockResolvedValue(
      Response.json([
        { name: 'mockup', description: 'Create a mockup', scope: 'bundled' },
        {
          name: 'restricted',
          description: 'Read only',
          scope: 'bundled',
          unavailableReason: 'Tool restrictions unsupported',
        },
      ]),
    );
    const send = vi.fn(() => true);
    render(
      <ChatInput
        onSend={send}
        onStop={vi.fn()}
        running={false}
        sessionId={sessionId}
        initialText="Keep my draft"
        boundedFirstCommand={!sessionId}
        guardedConversation={!!sessionId}
        composerCapabilities={chatComposerCapabilities({
          ordinary: true,
          location: 'local',
          sessionId,
          blocked: false,
        })}
      />,
    );
    const commands = screen.getByRole('button', { name: 'Commands' });
    expect(commands).toBeEnabled();
    expect(screen.getByRole('link', { name: 'Terminal' })).toHaveAttribute(
      'href',
      expect.stringContaining('/terminal?'),
    );
    fireEvent.click(commands);
    const choice = await screen.findByRole('button', { name: /\/mockup/ });
    expect(screen.getByRole('button', { name: /\/restricted/ })).toBeDisabled();
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/skills?runtime=ordinary' + (sessionId ? '&sessionId=' + sessionId : ''),
      expect.anything(),
    );
    expect(apiFetch).not.toHaveBeenCalledWith('/api/commands', expect.anything());
    fireEvent.click(choice);
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Message Mitzo' })).toHaveValue(
        '/mockup Keep my draft',
      ),
    );
    expect(send).not.toHaveBeenCalled();
  },
);
