import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MitzoStoreProvider } from '@mitzo/client/hooks';
import { App } from './App';
import { startAuthentication } from './lib/startup-auth';
import { preloadLandingPage } from './route-pages';
import { clientStore } from './client-store';

void startAuthentication(location.pathname);
preloadLandingPage(location.pathname);

// Unregister any previously installed service workers — the SW was causing
// WS disconnects (code 1001) via clients.claim() on activate. For a tool
// running over Tailscale, offline caching provides no value.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then((regs) => {
    for (const reg of regs) reg.unregister();
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MitzoStoreProvider value={clientStore}>
      <App />
    </MitzoStoreProvider>
  </StrictMode>,
);
