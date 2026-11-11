import { createPortal } from 'react-dom';
import { ApprovalCard, type ApprovalCardProps } from './ApprovalCard';
export type ToolTier = 'safe' | 'standard' | 'elevated' | 'unknown';

/** The shared header stays above mobile navigation while its body scrolls. */
export function PermissionBanner(props: ApprovalCardProps) {
  return createPortal(<ApprovalCard {...props} presentation="overlay" />, document.body);
}
