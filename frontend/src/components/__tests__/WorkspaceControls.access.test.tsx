// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { WorkspaceControls } from '../WorkspaceControls';
afterEach(cleanup);
it('keeps Access reachable alongside collapsed workspace controls', () => {
  localStorage.removeItem('mitzo-workspace-controls-expanded');
  render(
    <WorkspaceControls status="Ready" actions={<button>Access</button>}>
      <button>Account controls</button>
    </WorkspaceControls>,
  );
  expect(screen.getByRole('button', { name: 'Access' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Account controls' })).toBeNull();
});
