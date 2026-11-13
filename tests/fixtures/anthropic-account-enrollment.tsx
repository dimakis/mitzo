import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { OpenAIAccountEnrollment } from '../../frontend/src/components/OpenAIAccountEnrollment';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';
import '../../frontend/src/styles/workspace.css';
import '../../frontend/src/styles/connections-setup.css';

createRoot(document.getElementById('root')!).render(
  <main className="workspace-page">
    <MemoryRouter>
      <OpenAIAccountEnrollment
        csrf="fixture-csrf"
        authorized
        onReauthorizationNeeded={() => {
          throw Error('Fixture authorization expired');
        }}
      />
    </MemoryRouter>
  </main>,
);
