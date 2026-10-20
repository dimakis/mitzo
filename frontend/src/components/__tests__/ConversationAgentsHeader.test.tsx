// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ConversationAgents, type ConversationAgent } from '../ConversationAgents';

vi.mock('../AccountModelPicker', () => ({ AccountModelPicker: () => null }));
vi.mock('../ChatAgentProfilePicker', () => ({ ChatAgentProfilePicker: () => null }));
afterEach(cleanup);

const agents: ConversationAgent[] = ['Architect', 'Reviewer', 'Researcher', 'Writer'].map(
  (name) => ({ id: name.toLowerCase(), name, state: 'Added' }),
);

function mount(count: number, compact = false) {
  const selected = agents.slice(0, count);
  render(
    <MemoryRouter>
      <ConversationAgents
        scope="header-fixture"
        agents={selected}
        messages={[]}
        compact={compact}
      />
    </MemoryRouter>,
  );
  return screen.getByRole('button', {
    name: selected.length ? `Agents, ${selected.map((agent) => agent.name).join(', ')}` : 'Agents',
  });
}

it.each([0, 1, 2, 3, 4])(
  'retains desktop names and both count rules for %i participants',
  (count) => {
    const trigger = mount(count);
    expect(trigger.querySelector('.conversation-participant-names')?.textContent).toBe(
      agents
        .slice(0, count)
        .slice(0, 2)
        .map((agent) => agent.name)
        .join(' · ') || 'Agents',
    );
    expect(trigger.querySelector('.conversation-participant-count')?.textContent ?? '').toBe(
      count > 1 ? `+${count - 1}` : '',
    );
    expect(trigger.querySelector('.conversation-participant-wide-count')?.textContent ?? '').toBe(
      count > 2 ? `+${count - 2}` : '',
    );
    expect(trigger.querySelector('small')?.textContent).toBe(
      count > 1 ? 'Shared discussion' : 'Agent chat',
    );
  },
);

it('keeps the second participant and separator in one independently hideable name span', () => {
  const trigger = mount(3);
  const names = trigger.querySelector('.conversation-participant-names')!;
  const first = names.firstElementChild;
  const additional = names.querySelector('.conversation-participant-additional-name');
  expect(first?.textContent).toBe('Architect');
  expect(additional?.textContent).toBe(' · Reviewer');
  expect(names.children).toHaveLength(2);
  expect(first).not.toBe(additional);
  expect(trigger.querySelector('.conversation-participant-count')?.textContent).toBe('+2');
});

it('keeps the wider remaining-participant count beside the displayed names', () => {
  const trigger = mount(3);
  expect(trigger.querySelector('strong .conversation-participant-wide-count')?.textContent).toBe(
    '+1',
  );
  expect(trigger.querySelector('small')?.textContent).toBe('Shared discussion');
});

it('hides the additional name in the approved 360px conversation container, preserving wider rules', () => {
  const trigger = mount(3);
  const names = trigger.querySelector('.conversation-participant-names')!;
  const first = names.firstElementChild;
  const additional = names.querySelector('.conversation-participant-additional-name');
  expect(trigger.closest('.conversation-participants-container')).not.toBeNull();

  // JSDOM does not lay out media queries. Inspect the actual stylesheet's CSSOM
  // and its selectors against the rendered component; rendered viewport proof
  // remains with the unchanged offline browser fixture.
  const style = document.createElement('style');
  style.textContent = readFileSync(resolve(__dirname, '../ConversationAgents.css'), 'utf8');
  document.head.append(style);
  try {
    const rules = Array.from(style.sheet!.cssRules);
    const mobile = rules.find((rule): rule is CSSContainerRule =>
      rule.cssText.startsWith('@container conversation-participants (max-width: 360px)'),
    );
    expect(mobile).toBeDefined();
    const mobileRules = Array.from(mobile!.cssRules).filter(
      (rule): rule is CSSStyleRule => rule.type === CSSRule.STYLE_RULE,
    );
    const hidden = mobileRules.filter((rule) => rule.style.display === 'none');
    expect(
      hidden.some((rule) =>
        rule.selectorText
          .split(',')
          .some((selector) => selector.trim() === '.conversation-participant-additional-name'),
      ),
    ).toBe(true);
    expect(first).not.toBeNull();
    expect(additional).not.toBeNull();
    expect(hidden.some((rule) => additional!.matches(rule.selectorText))).toBe(true);
    expect(hidden.some((rule) => first!.matches(rule.selectorText))).toBe(false);
    const count = trigger.querySelector('.conversation-participant-count')!;
    expect(
      mobileRules.some(
        (rule) => count.matches(rule.selectorText) && rule.style.display === 'inline',
      ),
    ).toBe(true);
    expect(
      rules.some(
        (rule) =>
          rule.type === CSSRule.STYLE_RULE &&
          (rule as CSSStyleRule).style.display === 'none' &&
          additional!.matches((rule as CSSStyleRule).selectorText),
      ),
    ).toBe(false);
  } finally {
    style.remove();
  }
});

it('retains the original icon-only compact entry with all participants in its accessible name', () => {
  const trigger = mount(3, true);
  expect(trigger.closest('.conversation-agents-entry')).not.toBeNull();
  expect(trigger.querySelector('.conversation-participant-names')).toBeNull();
  expect(trigger.querySelector('.conversation-participant-count')).toBeNull();
  expect(trigger.querySelector('strong')).toBeNull();
  expect(trigger.querySelector('svg')).not.toBeNull();
});
