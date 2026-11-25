import { expect, it } from 'vitest';
import { join } from 'node:path';
import { userInfo } from 'node:os';
import {
  isWorkspaceRuntimeAuthorityWritePath,
  workspaceRuntimeNativeAuthorityPaths,
  workspaceRuntimePrivateFiles,
} from '../workspace-runtime-private-paths.js';

it('keeps the host dependency namespace readable but write-protected before it exists', () => {
  const root = join(userInfo().homedir, '.local', 'share', 'mitzo-dependency-store');
  expect(workspaceRuntimeNativeAuthorityPaths()).toContain(root);
  expect(isWorkspaceRuntimeAuthorityWritePath(join(root, 'v1', 'entries', 'future'))).toBe(true);
  expect(workspaceRuntimePrivateFiles()).not.toContain(root);
});
