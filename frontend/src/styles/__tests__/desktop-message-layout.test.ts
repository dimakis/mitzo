// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
const css = readFileSync('frontend/src/styles/workspace-chat.css', 'utf8');
afterEach(() => {
  document.body.replaceChildren();
  document.head.replaceChildren();
});
function rules(selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...css.matchAll(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'g'))]
    .map((match) => `${selector} { ${match[1]} }`)
    .join('\n');
}
it('lets desktop responses use their pane and wraps long table summaries', () => {
  const style = document.createElement('style');
  style.textContent =
    rules('.desktop-chat-center .msg-bubble--assistant') +
    rules('.workspace-chat .msg-bubble--assistant td');
  document.head.append(style);
  document.body.innerHTML =
    '<main class="desktop-chat-center workspace-chat"><article class="msg-bubble--assistant"><table><tbody><tr><td>Long summary</td></tr></tbody></table></article></main>';
  const response = getComputedStyle(document.querySelector('article')!);
  expect(response.width).toBe('100%');
  expect(response.maxWidth).toBe('100%');
  expect(getComputedStyle(document.querySelector('td')!).whiteSpace).toBe('normal');
  expect(getComputedStyle(document.querySelector('td')!).overflowWrap).toBe('break-word');
});
