// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { UserBubble } from '../MessageBubble';

afterEach(cleanup);
const text = 'What state are my Strats in?';
const raw = `The user has attached the following reference files for this message.\nUse them to inform your response.\n\n<context name="Jira Essentials" source="routing.md">\nUse the maintained Jira command.\n</context>\n\n---CONTEXT_END---\n${text}`;

describe('user message context injection UI', () => {
  it('shows selected names immediately and stays collapsed as the echoed content arrives', () => {
    const { rerender } = render(<UserBubble text={text} contextBlocks={['Jira Essentials']} />);
    expect(
      screen.getByRole('button', { name: /Context selected/ }).getAttribute('aria-expanded'),
    ).toBe('false');
    expect(screen.getByText('Jira Essentials')).toBeTruthy();
    rerender(
      <UserBubble
        text={text}
        contextBlocks={['Jira Essentials']}
        contextInjections={[
          {
            name: 'Jira Essentials',
            source: 'routing.md',
            content: 'Use the maintained Jira command.',
          },
        ]}
      />,
    );
    const disclosure = screen.getByRole('button', { name: /Context injected/ });
    expect(disclosure.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Use the maintained Jira command.')).toBeNull();
    fireEvent.click(disclosure);
    expect(screen.getByText('Use the maintained Jira command.')).toBeTruthy();
  });

  it('projects legacy expanded prompts into a disclosure and edits only the user text', () => {
    const onEdit = vi.fn();
    render(<UserBubble text={raw} onEdit={onEdit} />);
    expect(screen.getByText(text)).toBeTruthy();
    expect(screen.queryByText(/The user has attached/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Context injected/ }));
    expect(onEdit).not.toHaveBeenCalled();
    expect(screen.getByText('routing.md')).toBeTruthy();
    fireEvent.click(screen.getByText(text));
    expect(onEdit).toHaveBeenCalledWith(text);
  });
});
