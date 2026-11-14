import React from 'react';
import { expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { createMitzoStore, type MitzoApiClient } from '@mitzo/client';
import type { applicationEventSource } from './application-event-source';

/** The real responsive pages, store and shared/input hosts, using the supplied
 * authenticated application transport. JSDOM media queries are the only layout
 * adapter; this helper does not provide application replies or authorization. */
export async function mountResponsiveOrdinary({
  api,
  transport,
  width = 390,
  source = 'existing-chat',
  shared = true,
}: {
  api: Pick<MitzoApiClient, 'getSessionMessages'>;
  transport: Awaited<ReturnType<typeof applicationEventSource>>;
  width?: number;
  source?: string;
  shared?: boolean;
}) {
  let currentWidth = width;
  const mediaQueries = new Map<
    string,
    { matches: boolean; listeners: Set<(event: { matches: boolean }) => void> }
  >();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => {
      let media = mediaQueries.get(query);
      if (!media) {
        media = {
          matches: query === '(min-width: 768px)' && currentWidth >= 768,
          listeners: new Set(),
        };
        mediaQueries.set(query, media);
      }
      const selectedMedia = media;
      return {
        get matches() {
          return selectedMedia.matches;
        },
        media: query,
        addEventListener: (_type: string, listener: (event: { matches: boolean }) => void) =>
          selectedMedia.listeners.add(listener),
        removeEventListener: (_type: string, listener: (event: { matches: boolean }) => void) =>
          selectedMedia.listeners.delete(listener),
      };
    },
  });
  const { ResponsiveChatView } = await import('../../frontend/src/components/ResponsiveChatView');
  const { SessionList } = await import('../../frontend/src/pages/SessionList');
  const { MitzoStoreProvider } = await import('@mitzo/client/hooks');
  const history = await api.getSessionMessages(source);
  const store = createMitzoStore({
    transport: { fetch: transport.fetch },
    sseConfig: {
      baseUrl: '',
      fetch: transport.fetch,
      createEventSource: transport.createEventSource,
    },
    wsConfig: {
      buildUrl: () => {
        throw Error('Unexpected socket: application HTTP owns this journey');
      },
      createWebSocket: () => {
        throw Error('Unexpected socket');
      },
    },
  });
  store.setState((state) => ({
    sessions: { ...state.sessions, active: source },
    messages: {
      ...state.messages,
      messages: history,
    },
  }));
  await vi.waitFor(() => expect(store.getState().connection.status).toBe('connected'));
  await store.getState().switchSession(source);
  const ui = render(
    <MitzoStoreProvider value={store}>
      <MemoryRouter initialEntries={['/chat/' + source]}>
        <Routes>
          <Route path="/chat/:sessionId" element={<ResponsiveChatView />} />
          <Route path="/sessions" element={<SessionList />} />
        </Routes>
      </MemoryRouter>
    </MitzoStoreProvider>,
  );
  if (shared) await screen.findByRole('button', { name: 'Choose who replies' }, { timeout: 10000 });
  else await screen.findByRole('textbox', { name: 'Message Mitzo' }, { timeout: 10000 });
  return {
    ui,
    store,
    resize(nextWidth: number) {
      currentWidth = nextWidth;
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: currentWidth });
      for (const [query, media] of mediaQueries) {
        const matches = query === '(min-width: 768px)' && currentWidth >= 768;
        if (matches === media.matches) continue;
        media.matches = matches;
        for (const listener of media.listeners) listener({ matches });
      }
      window.dispatchEvent(new Event('resize'));
    },
    close() {
      ui.unmount();
      store.getState().invalidateAuthentication();
    },
  };
}
