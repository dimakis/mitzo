// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { ComposerTools } from '../ComposerTools';

afterEach(cleanup);
it('adds scheduling inside the existing composer tools without replacing any action', () => {
  const schedule = vi.fn();
  const view = render(
    <ComposerTools
      onCommands={() => {}}
      commandsExpanded={false}
      onAttach={() => {}}
      attachmentDisabled={false}
      onDismiss={() => {}}
      onExpand={() => {}}
      onSchedule={schedule}
    />,
  );
  const clock = screen.getByRole('button', { name: 'Schedule prompt' });
  expect(clock.closest('.composer-tools')).toBeTruthy();
  for (const label of [
    'Commands',
    'Attach images or PDF',
    'Terminal',
    'Expand input',
    'More composer actions',
  ])
    expect(screen.getByRole('button', { name: label })).toBeTruthy();
  fireEvent.click(clock);
  expect(schedule).toHaveBeenCalledTimes(1);
  expect(view.container.querySelectorAll('[aria-label="Schedule prompt"]')).toHaveLength(1);
});
