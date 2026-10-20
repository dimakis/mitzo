// @vitest-environment jsdom
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ConversationAgents } from '../ConversationAgents';
import { readFileSync } from 'node:fs';

vi.mock('../AccountModelPicker', () => ({
  AccountModelPicker: () => (
    <label>
      Account
      <select aria-label="Account">
        <option>Work account</option>
      </select>
    </label>
  ),
}));
vi.mock('../ChatAgentProfilePicker', () => ({
  ChatAgentProfilePicker: () => (
    <label>
      Agent
      <select aria-label="Agent">
        <option>Default Mitzo</option>
      </select>
    </label>
  ),
}));
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
});
afterEach(cleanup);
const agents = [
  { id: 'primary', name: 'Primary agent', account: 'Work account', model: 'Luna', state: 'Added' },
];
const messages = [
  {
    messageId: 'm1',
    role: 'user' as const,
    blocks: [{ blockId: 'b1', blockType: 'text' as const, content: 'Review the layout.' }],
  },
];
function mount(extra = {}) {
  return render(
    <MemoryRouter>
      <ConversationAgents scope="chat-one" agents={agents} messages={messages} {...extra} />
    </MemoryRouter>,
  );
}
function productionStyles() {
  const styles = document.createElement('style');
  styles.textContent = [
    '../../styles/tokens.css',
    '../../styles/global.css',
    '../../styles/home.css',
    '../AgentSettingsPicker.css',
    '../ConversationAgents.css',
  ]
    .map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'))
    .join('\n');
  document.head.append(styles);
  return styles;
}
it('uses one compact participant header and one Agents view without transcript tabs', () => {
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Agents, Primary agent' }));
  const dialog = screen.getByRole('dialog', { name: 'Agents' });
  expect(within(dialog).getByText('Primary agent')).toBeTruthy();
  expect(
    within(dialog)
      .getByRole('checkbox', { name: 'Reads future discussion' })
      .hasAttribute('disabled'),
  ).toBe(true);
  expect(
    within(dialog).getByRole('checkbox', { name: 'Replies by default' }).hasAttribute('disabled'),
  ).toBe(true);
  expect(screen.queryByRole('tablist')).toBeNull();
  expect(screen.queryByText('Accounts and models per agent')).toBeNull();
});
it('keeps fresh-agent setup in the same view, with purpose and full or selected context, without allocating', () => {
  const preview = vi.fn();
  mount({ onPreview: preview });
  fireEvent.click(screen.getByRole('button', { name: 'Agents, Primary agent' }));
  fireEvent.click(screen.getByRole('button', { name: 'Add agent' }));
  const dialog = screen.getByRole('dialog', { name: 'Add agent' });
  fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name in this chat' }), {
    target: { value: 'Reviewer' },
  });
  fireEvent.change(within(dialog).getByRole('textbox', { name: 'Purpose' }), {
    target: { value: 'Check the design.' },
  });
  fireEvent.change(within(dialog).getByRole('combobox', { name: 'Context' }), {
    target: { value: 'selected' },
  });
  expect(within(dialog).getByText('Joining brief only.')).toBeTruthy();
  expect(within(dialog).getByRole('checkbox', { name: /Review the layout/ })).toBeTruthy();
  expect(
    within(dialog).getByRole('button', { name: 'Review joining brief' }).hasAttribute('disabled'),
  ).toBe(true);
  expect(screen.queryByRole('tab', { name: 'Existing chat' })).toBeNull();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  fireEvent.click(screen.getByRole('button', { name: 'Add agent' }));
  expect((screen.getByRole('textbox', { name: 'Purpose' }) as HTMLInputElement).value).toBe(
    'Check the design.',
  );
  expect(preview).not.toHaveBeenCalled();
});

it('keeps Context at the shared custom-select size and Review at the approved primary action style', () => {
  const styles = productionStyles();
  try {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Agents, Primary agent' }));
    const add = screen.getByRole('button', { name: 'Add agent' });
    const primary = getComputedStyle(add);
    const expected = { background: primary.background, color: primary.color };
    fireEvent.click(add);
    const dialog = screen.getByRole('dialog', { name: 'Add agent' });
    const context = within(dialog).getByRole('combobox', { name: 'Context' });
    const selectStyle = getComputedStyle(context);
    // Reuse the existing custom-select appearance while keeping dialog sizing.
    // Native WebKit hit-box geometry still requires the offline browser fixture.
    expect.soft(selectStyle.appearance).toBe('none');
    const controlHeight = getComputedStyle(document.documentElement)
      .getPropertyValue('--control-height')
      .trim();
    expect(controlHeight).toBeTruthy();
    expect.soft([controlHeight, 'var(--control-height)']).toContain(selectStyle.minHeight);
    expect.soft(selectStyle.width).toBe('100%');
    expect.soft(selectStyle.maxWidth).toBe('100%');
    const review = within(dialog).getByRole('button', { name: 'Review joining brief' });
    const reviewStyle = getComputedStyle(review);
    expect.soft(reviewStyle.background).toBe(expected.background);
    expect.soft(reviewStyle.color).toBe(expected.color);
  } finally {
    styles.remove();
  }
});

it('uses the approved Add header, quiet Cancel, section and wrapping-footer treatment only in Add', () => {
  const styles = productionStyles();
  try {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Agents, Primary agent' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add agent' }));
    const dialog = screen.getByRole('dialog', { name: 'Add agent' });
    const header = within(dialog).getByRole('heading', { name: 'Add agent' });
    const close = within(dialog).getByRole('button', { name: 'Close Agents' });
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
    // JSDOM does not resolve variable-containing font shorthands. Check the
    // production rule matching this actual title; browser text metrics stay CI.
    const titleFont = Array.from(styles.sheet!.cssRules).some((rule) => {
      const style = rule as CSSStyleRule;
      return (
        style.selectorText &&
        header.matches(style.selectorText) &&
        /^500 var\(--text-lg\)\s*\/\s*1\.3 var\(--font-ui\)$/.test(style.style.font)
      );
    });
    expect.soft(titleFont).toBe(true);
    expect.soft(getComputedStyle(close).borderTopWidth).toBe('0px');
    expect.soft(getComputedStyle(cancel).borderTopWidth).toBe('0px');
    expect.soft(getComputedStyle(cancel).backgroundColor).toBe('rgba(0, 0, 0, 0)');
    const sections = within(dialog).getAllByRole('heading', { level: 3 });
    expect(sections.map((section) => section.textContent)).toEqual([
      'Account & model',
      'Execution',
      'Starting context',
    ]);
    for (const section of sections) {
      expect.soft(getComputedStyle(section).fontWeight).toBe('500');
      expect.soft(getComputedStyle(section).color).toBe('var(--color-accent)');
    }
    const footer = dialog.querySelector('footer')!;
    const hint = within(footer).getByText('Fresh session · starts with a prompt.');
    expect.soft(getComputedStyle(footer).gap).toBe('var(--space-2)');
    expect.soft(getComputedStyle(footer).justifyContent).toBe('flex-start');
    expect.soft(getComputedStyle(footer).flexWrap).toBe('wrap');
    expect.soft(getComputedStyle(hint).fontSize).toBe('var(--text-xs)');
    expect.soft(getComputedStyle(hint).minWidth).toBe('72px');
    expect.soft(getComputedStyle(hint).flexGrow).toBe('1');
    const content = dialog.querySelector('.home-dialog-content')!;
    expect.soft(getComputedStyle(content).containerType).toBe('inline-size');
    expect.soft(getComputedStyle(content).containerName).toBe('conversation-add');
    const query = Array.from(styles.sheet!.cssRules).find((rule) =>
      /^@container conversation-add\s*\(max-width:\s*340px\)/.test(rule.cssText),
    ) as CSSGroupingRule | undefined;
    expect(query).toBeDefined();
    const pair = Array.from(query!.cssRules).find(
      (rule) =>
        (rule as CSSStyleRule).selectorText ===
        '.conversation-add-dialog .account-model-settings-pair',
    ) as CSSStyleRule | undefined;
    expect(pair?.style.gridTemplateColumns).toBe('minmax(0, 1fr)');
    expect(pair?.style.gap).toBe('0px');
  } finally {
    styles.remove();
  }
});

it('returns from Add to its real Agents parent with focus and its draft retained', () => {
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Agents, Primary agent' }));
  fireEvent.click(screen.getByRole('button', { name: 'Add agent' }));
  const dialog = screen.getByRole('dialog', { name: 'Add agent' });
  fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name in this chat' }), {
    target: { value: 'Reviewer' },
  });
  fireEvent.change(within(dialog).getByRole('textbox', { name: 'Purpose' }), {
    target: { value: 'Keep the joining draft.' },
  });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Back to Agents' }));
  const agentsDialog = screen.getByRole('dialog', { name: 'Agents' });
  const add = within(agentsDialog).getByRole('button', { name: 'Add agent' });
  expect(document.activeElement).toBe(add);
  fireEvent.click(add);
  expect(screen.getByRole('textbox', { name: 'Name in this chat' })).toHaveProperty(
    'value',
    'Reviewer',
  );
  expect(screen.getByRole('textbox', { name: 'Purpose' })).toHaveProperty(
    'value',
    'Keep the joining draft.',
  );
});
it('applies real policy edits only through the supplied owner and keeps preview separate from recipients', () => {
  const change = vi.fn(),
    preview = vi.fn();
  mount({
    agents: [{ ...agents[0], policy: { reads: false, replies: true } }],
    onPolicyChange: change,
    onPreview: preview,
  });
  fireEvent.click(screen.getByRole('button', { name: 'Agents, Primary agent' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Reads future discussion' }));
  expect(change).toHaveBeenCalledWith('primary', { reads: true, replies: true });
  fireEvent.click(screen.getByRole('button', { name: 'Preview Primary agent conversation' }));
  expect(preview).toHaveBeenCalledWith('primary');
  expect(screen.queryByRole('dialog')).toBeNull();
});
it('clears another conversation’s setup and closes on scope change', () => {
  const view = mount();
  fireEvent.click(screen.getByRole('button', { name: 'Agents, Primary agent' }));
  fireEvent.click(screen.getByRole('button', { name: 'Add agent' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Purpose' }), {
    target: { value: 'Private purpose' },
  });
  view.rerender(
    <MemoryRouter>
      <ConversationAgents scope="chat-two" agents={agents} messages={[]} />
    </MemoryRouter>,
  );
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Agents, Primary agent' }));
  fireEvent.click(screen.getByRole('button', { name: 'Add agent' }));
  expect((screen.getByRole('textbox', { name: 'Purpose' }) as HTMLInputElement).value).toBe('');
});

it('keeps account/model details and reusable-profile drafting on the selected agent', () => {
  const draft = vi.fn();
  mount({ onDraftProfile: draft });
  fireEvent.click(screen.getByRole('button', { name: 'Agents, Primary agent' }));
  fireEvent.click(screen.getByRole('button', { name: 'Details for Primary agent' }));
  const dialog = screen.getByRole('dialog', { name: 'Primary agent' });
  expect(within(dialog).getByText('Work account')).toBeTruthy();
  expect(within(dialog).getByText('Luna')).toBeTruthy();
  fireEvent.click(
    within(dialog).getByRole('button', { name: 'Draft reusable profile from this agent' }),
  );
  expect(draft).toHaveBeenCalledWith('primary');
});
