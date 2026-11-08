import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import type { PermissionRequest } from '@mitzo/protocol';
import { PermissionBanner } from '../../frontend/src/components/PermissionBanner';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';
import '../../frontend/src/styles/motion.css';

function Fixture({ initial }: { initial: PermissionRequest }) {
  const [permission, setPermission] = useState(initial);
  useEffect(() => {
    const receive = (event: Event) =>
      setPermission((event as CustomEvent<PermissionRequest>).detail);
    window.addEventListener('fixture-proposal', receive);
    return () => window.removeEventListener('fixture-proposal', receive);
  }, []);
  return (
    <MemoryRouter>
      <main>
        <textarea aria-label="Draft" defaultValue="Keep my draft" />
        <PermissionBanner
          key={permission.permId}
          {...permission}
          onRespond={() => {
            throw Error('Use the reviewed save owner');
          }}
        />
      </main>
    </MemoryRouter>
  );
}
void fetch('/fixture/permission')
  .then((response) => response.json())
  .then((initial: PermissionRequest) => {
    createRoot(document.getElementById('root')!).render(<Fixture initial={initial} />);
  });
