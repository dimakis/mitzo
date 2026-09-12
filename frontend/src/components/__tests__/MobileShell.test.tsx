// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Link, MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MobileShell } from '../MobileShell';

const media = vi.hoisted(() => ({ desktop: false }));
vi.mock('../../hooks/useMediaQuery', () => ({ useIsDesktop: () => media.desktop }));
afterEach(() => {
  cleanup();
  media.desktop = false;
});

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <MobileShell>
        <Link to="/chat/example">Open conversation</Link>
      </MobileShell>
    </MemoryRouter>,
  );
}

function ruleBody(styles: string, rule: string) {
  const ruleStart = styles.indexOf(rule);
  if (ruleStart === -1) {
    throw new Error(`Could not find CSS rule: ${rule}`);
  }

  const openingBrace = styles.indexOf('{', ruleStart);
  let depth = 0;
  for (let index = openingBrace; index < styles.length; index += 1) {
    if (styles[index] === '{') depth += 1;
    if (styles[index] === '}') depth -= 1;
    if (depth === 0) return styles.slice(openingBrace + 1, index);
  }

  throw new Error(`Could not find closing brace for CSS rule: ${rule}`);
}

describe('MobileShell navigation', () => {
  it.each(['/chat', '/chat/example', '/', '/todos/example', '/tasks', '/more'])(
    'keeps the menu available on %s',
    (path) => {
      renderAt(path);
      expect(screen.getByRole('link', { name: 'More' })).toBeTruthy();
    },
  );
  it('keeps navigation when entering a conversation from Chats', () => {
    renderAt('/sessions');
    fireEvent.click(screen.getByRole('link', { name: 'Open conversation' }));
    expect(screen.getByRole('link', { name: 'More' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Chats' }).getAttribute('aria-current')).toBe('page');
  });
  it('hides navigation on login', () => {
    renderAt('/login');
    expect(screen.queryByRole('navigation')).toBeNull();
  });
  it('leaves desktop navigation to the desktop shell', () => {
    media.desktop = true;
    renderAt('/chat/example');
    expect(screen.queryByRole('navigation')).toBeNull();
  });

  it('does not reserve the bottom safe area twice in mobile chats', () => {
    const styles = readFileSync(
      resolve(process.cwd(), 'frontend/src/styles/workspace-chat.css'),
      'utf8',
    );
    expect(styles).toMatch(/\.workspace-chat \.chat-input\s*\{[^}]*padding-bottom:\s*0\.5rem;/s);
  });

  it('keeps mobile workspace layout compact without introducing horizontal overflow rules', () => {
    const styles = readFileSync(
      resolve(process.cwd(), 'frontend/src/styles/workspace-chat.css'),
      'utf8',
    );
    const mobileStyles = ruleBody(styles, '@media (max-width: 767px)');
    const narrowStyles = ruleBody(mobileStyles, '@media (max-width: 359px)');

    const mobileRow = ruleBody(mobileStyles, '.workspace-chat .chat-input-row');
    expect(mobileRow).toMatch(/min-width:\s*0/);

    const mobileField = ruleBody(mobileStyles, '.workspace-chat .chat-input-field');
    expect(mobileField).toMatch(/width:\s*auto/);
    expect(mobileField).toMatch(/flex:\s*1 1 0/);
    expect(mobileField).toMatch(/min-width:\s*0/);

    expect(ruleBody(mobileStyles, '.workspace-chat .chat-input-command-label')).toMatch(
      /display:\s*none/,
    );

    expect(ruleBody(narrowStyles, '.workspace-chat .chat-input-row')).toMatch(/flex-wrap:\s*wrap/);
    expect(ruleBody(narrowStyles, '.workspace-chat .chat-input-field')).toMatch(
      /flex-basis:\s*100%/,
    );
    const narrowToolbar = ruleBody(narrowStyles, '.workspace-chat .composer-toolbar');
    expect(narrowToolbar).toMatch(/flex:\s*1 1 100%/);
    expect(narrowToolbar).toMatch(/justify-content:\s*flex-end/);
  });
});
