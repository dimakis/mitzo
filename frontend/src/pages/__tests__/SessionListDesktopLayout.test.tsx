// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
const globalCss = readFileSync('frontend/src/styles/global.css', 'utf8');
const workspaceChatCss = readFileSync('frontend/src/styles/workspace-chat.css', 'utf8');

it('keeps the desktop conversation list in its center panel instead of covering the rail', () => {
  const style = document.createElement('style');
  style.textContent = globalCss + workspaceChatCss;
  document.head.append(style);
  const shell = document.createElement('div');
  shell.className = 'desktop-shell';
  const page = document.createElement('div');
  page.className = 'session-list-page workspace-page conversation-library';
  shell.append(page);
  document.body.append(shell);
  try {
    expect(getComputedStyle(page).position).toBe('static');
    expect(getComputedStyle(page).width).toBe('100%');
  } finally {
    shell.remove();
    style.remove();
  }
});
