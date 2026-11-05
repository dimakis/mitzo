import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import type { PermissionRequest } from '@mitzo/protocol';
import { PermissionBanner } from '../../frontend/src/components/PermissionBanner';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';
import '../../frontend/src/styles/motion.css';

void fetch('/fixture/permission')
  .then((response) => response.json())
  .then((permission: PermissionRequest) => {
    createRoot(document.getElementById('root')!).render(
      <MemoryRouter>
        <main>
          <textarea aria-label="Draft" defaultValue="Keep my draft" />
          <PermissionBanner
            {...permission}
            onRespond={() => {
              throw Error('Use the reviewed save owner');
            }}
          />
        </main>
      </MemoryRouter>,
    );
  });
