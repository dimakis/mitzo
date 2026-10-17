import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Login } from '../../frontend/src/pages/Login';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';
import '../../frontend/src/styles/motion.css';

createRoot(document.getElementById('root')!).render(
  <MemoryRouter initialEntries={['/login?returnTo=/done']}>
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/done" element={<p>Signed in to the offline fixture</p>} />
    </Routes>
  </MemoryRouter>,
);
