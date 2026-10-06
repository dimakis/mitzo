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
    const mobileStyles = styles.slice(styles.indexOf('/* Keep the composer above'));
    const composer = ruleBody(mobileStyles, '.workspace-chat .chat-input');
    // Explicit composer padding overrides the global safe-area padding; its
    // exact size can change without making the composer own the inset again.
    expect(composer).toMatch(/padding:\s*[^;]+;/);
    expect(composer).not.toContain('safe-area-inset-bottom');
  });

  it('gives mobile draft text its own full-width row and collapses utilities by composer width', () => {
    const styles = readFileSync(
      resolve(process.cwd(), 'frontend/src/styles/workspace-chat.css'),
      'utf8',
    );
    const mobileStyles = styles.slice(styles.indexOf('/* Keep the composer above'));
    const mobileRow = ruleBody(mobileStyles, '.workspace-chat .chat-input-row');
    expect(mobileRow).toMatch(/flex-direction:\s*column/);
    expect(mobileRow).toMatch(/min-width:\s*0/);

    const mobileField = ruleBody(mobileStyles, '.workspace-chat .chat-input-field');
    expect(mobileField).toMatch(/width:\s*100%/);
    expect(mobileField).toMatch(/flex:\s*none/);
    expect(ruleBody(styles, '.chat-input--compact {')).toMatch(/container-type:\s*inline-size/);

    const narrowStyles = ruleBody(styles, '@container (max-width: 520px)');
    expect(ruleBody(narrowStyles, '.chat-input--compact .composer-toolbar')).toMatch(
      /flex-wrap:\s*nowrap/,
    );
    expect(ruleBody(narrowStyles, '.composer-tools {')).toMatch(/display:\s*none/);
    expect(ruleBody(narrowStyles, ".composer-tools[data-expanded='true']")).toMatch(
      /display:\s*flex/,
    );
    expect(ruleBody(narrowStyles, '.chat-input--compact :is(.chat-input-btn, .mic-btn)')).toMatch(
      /min-width:\s*44px/,
    );
  });

  it('keeps conversation navigation visible while the keyboard is open', () => {
    const styles = readFileSync(
      resolve(process.cwd(), 'frontend/src/styles/workspace-chat.css'),
      'utf8',
    );
    expect(styles).not.toMatch(
      /\.workspace-chat\.keyboard-open \.conversation-heading\s*\{[^}]*display:\s*none;/s,
    );
  });

  it('uses the composer border instead of a second textarea focus box', () => {
    const styles = readFileSync(
      resolve(process.cwd(), 'frontend/src/styles/workspace-chat.css'),
      'utf8',
    );
    expect(styles).toMatch(
      /\.workspace-chat \.chat-input-field:focus-visible\s*\{[^}]*outline:\s*none;/s,
    );
  });
});
