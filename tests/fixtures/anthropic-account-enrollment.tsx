import { createRoot } from 'react-dom/client';
import { OpenAIAccountEnrollment } from '../../frontend/src/components/OpenAIAccountEnrollment';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';
import '../../frontend/src/styles/workspace.css';

createRoot(document.getElementById('root')!).render(
  <main className="workspace-page">
    <OpenAIAccountEnrollment
      csrf="fixture-csrf"
      authorized
      onReauthorizationNeeded={() => {
        throw Error('Fixture authorization expired');
      }}
    />
  </main>,
);
