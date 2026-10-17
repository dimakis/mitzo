import { createRoot } from 'react-dom/client';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ProtectedRoute } from '../../frontend/src/components/ProtectedRoute';
import { DailyQuoteLink } from '../../frontend/src/components/DailyQuoteLink';
import { localQuoteDate, saveDailyQuote } from '../../frontend/src/lib/launch-quote';
import catalog from '../../content/quotes/catalog.json';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';
import '../../frontend/src/styles/home.css';
import '../../frontend/src/styles/motion.css';

if (new URLSearchParams(location.search).has('cached'))
  saveDailyQuote({ date: localQuoteDate(), quote: catalog[4] });
createRoot(document.getElementById('root')!).render(
  <MemoryRouter>
    <Routes>
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <main className="workspace-page">
              <h1>Today</h1>
              <DailyQuoteLink date={localQuoteDate()} />
              <label>
                Ask Mitzo
                <input aria-label="Ask Mitzo" />
              </label>
            </main>
          </ProtectedRoute>
        }
      />
      <Route path="/login" element={<h1>Sign in to Mitzo</h1>} />
    </Routes>
  </MemoryRouter>,
);
