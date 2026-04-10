import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/global.css';
import './styles/calendar.css';
import './styles/desktop.css';

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
    <App />
  </StrictMode>,
);
