import { useLayoutEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { notificationTarget, OPEN_NOTIFICATION_EVENT } from '../lib/notification-target';

/** Native notification opens share React navigation and retain mounted drafts. */
export function NotificationNavigation() {
  const navigate = useNavigate();
  useLayoutEffect(() => {
    const open = (event: Event) => {
      const data: unknown = (event as CustomEvent).detail;
      if (!data || typeof data !== 'object' || Array.isArray(data)) return;
      event.preventDefault();
      navigate(notificationTarget(data as Record<string, unknown>));
    };
    window.addEventListener(OPEN_NOTIFICATION_EVENT, open);
    return () => window.removeEventListener(OPEN_NOTIFICATION_EVENT, open);
  }, [navigate]);
  return null;
}
