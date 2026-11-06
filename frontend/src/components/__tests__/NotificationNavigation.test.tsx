// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, expect, it } from 'vitest';
import { NotificationNavigation } from '../NotificationNavigation';
import { openNotification } from '../../lib/notification-target';
afterEach(cleanup);
function Conversation() {
  const location = useLocation();
  return (
    <>
      <input aria-label="Message draft" />
      <output>
        {location.pathname}
        {location.search}
      </output>
    </>
  );
}
it('navigates a native approval without reloading or discarding the composer', () => {
  render(
    <MemoryRouter initialEntries={['/chat/chat']}>
      <NotificationNavigation />
      <Conversation />
    </MemoryRouter>,
  );
  const draft = screen.getByLabelText('Message draft');
  fireEvent.change(draft, { target: { value: 'Keep typing' } });
  act(() =>
    openNotification({
      sessionId: 'chat',
      notificationId: 'permission:second',
      url: 'https://untrusted.invalid',
    }),
  );
  expect(screen.getByRole('status').textContent).toBe('/chat/chat?approval=second');
  expect(screen.getByLabelText('Message draft')).toBe(draft);
  expect(draft).toHaveProperty('value', 'Keep typing');
});
it('uses the installed router for notification opens', () => {
  render(
    <MemoryRouter>
      <NotificationNavigation />
      <Conversation />
    </MemoryRouter>,
  );
  act(() => openNotification({ sessionId: 'other' }));
  expect(screen.getByRole('status').textContent).toBe('/chat/other');
});
