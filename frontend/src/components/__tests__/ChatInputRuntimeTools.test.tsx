// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ChatInput } from '../ChatInput';
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
    expect(apiFetch).toHaveBeenCalledWith('/api/skills?runtime=ordinary', expect.anything());
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
