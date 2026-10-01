// @vitest-environment jsdom
import { fireEvent, render, screen, cleanup, act, waitFor } from '@testing-library/react';
import { MemoryRouter, useNavigate, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TextBubble } from '../MessageBubble';
import { apiFetch } from '../../lib/api-fetch';

vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async () => ({ svg: '<svg><text>Diagram</text></svg>' })),
  },
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(apiFetch).mockResolvedValue({
    ok: true,
    json: async () => ({ content: 'Expanded document content' }),
  } as Response);
});

function Harness({ content, sessionId }: { content: string; sessionId: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  return (
    <>
      <TextBubble content={content} artifactSessionId={sessionId} />
      <button onClick={() => navigate('?panel=files')}>Change panel</button>
      <output data-testid="location">{location.pathname + location.search}</output>
    </>
  );
}

describe('expanded message previews', () => {
  it('adds collapse controls when an asynchronously rendered diagram grows', async () => {
    let height = 100;
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => height);
    let notifyResize: (() => void) | undefined;
    const disconnect = vi.fn();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          notifyResize = () => callback([], this as unknown as ResizeObserver);
        }
        observe = vi.fn();
        disconnect = disconnect;
      },
    );
    const view = render(
      <MemoryRouter>
        <TextBubble content={'```mermaid\ngraph TD; A-->B;\n```'} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(view.container.querySelector('.mermaid-block-svg')).not.toBeNull());
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
    expect(notifyResize).toBeDefined();
    height = 600;
    act(() => notifyResize!());
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(screen.getByRole('button', { name: 'Show less' })).toBeDefined();
    height = 100;
    act(() => notifyResize!());
    expect(screen.queryByRole('button', { name: 'Show less' })).toBeNull();
    view.unmount();
    expect(disconnect).toHaveBeenCalled();
  });

  it('survives content, parent and query-string updates while keeping current link routing', async () => {
    const content =
      '[notes](file-path://%2Ftmp%2Fnotes.md)\n\n[other](file-path://%2Ftmp%2Fother.txt)';
    const view = render(
      <MemoryRouter initialEntries={['/chat/session-1']}>
        <Harness content={content} sessionId="session-1" />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: /notes.md/ }));
    await screen.findByText('Expanded document content');
    view.rerender(
      <MemoryRouter initialEntries={['/chat/session-1']}>
        <Harness content={content + '\n\nMore tokens'} sessionId="session-1" />
      </MemoryRouter>,
    );
    expect(screen.getByText('Expanded document content')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Change panel' }));
    expect(screen.getByText('Expanded document content')).toBeDefined();
    expect(apiFetch).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('link', { name: 'other' }));
    const url = new URL(screen.getByTestId('location').textContent!, 'https://mitzo.test');
    expect(url.searchParams.get('from')).toBe('/chat/session-1?panel=files');
    expect(url.searchParams.get('sessionId')).toBe('session-1');
  });
});
