import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { AgentLibrary } from '../../frontend/src/pages/AgentLibrary';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';
import '../../frontend/src/styles/workspace.css';
import '../../frontend/src/styles/motion.css';
createRoot(document.getElementById('root')!).render(
  <MemoryRouter initialEntries={[window.location.pathname + window.location.search]}>
    <AgentLibrary />
  </MemoryRouter>,
);
