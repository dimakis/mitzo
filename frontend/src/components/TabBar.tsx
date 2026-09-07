import { useIsDesktop } from '../hooks/useMediaQuery';
import { WorkspaceNav } from './WorkspaceNav';
export function TabBar() {
  return useIsDesktop() ? null : <WorkspaceNav />;
}
