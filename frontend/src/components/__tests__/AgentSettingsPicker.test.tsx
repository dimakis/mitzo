// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AgentSettingsPicker } from '../AgentSettingsPicker';

afterEach(cleanup);

const props = {
  summary: {
    agent: 'Bob',
    account: 'Personal',
    model: 'Luna',
    thinking: 'Medium',
    location: 'openshell' as const,
  },
  agent: (
    <label>
      Agent
      <select aria-label="Agent">
        <option>Bob</option>
      </select>
    </label>
  ),
  accountModel: (
    <>
      <label>
        Account
        <select aria-label="Account">
          <option>Personal</option>
        </select>
      </label>
      <label>
        Model
        <select aria-label="Model">
          <option>Luna</option>
        </select>
      </label>
      <label>
        Thinking
        <select aria-label="Thinking">
          <option>Medium</option>
        </select>
      </label>
    </>
  ),
  execution: (
    <div role="group" aria-label="Run on">
      OpenShell / Local Mac
    </div>
  ),
};

it('opens one agent-led composer panel, keeps settings mounted, and closes without submitting', () => {
  const done = vi.fn();
  const submit = vi.fn();
  render(
    <form onSubmit={submit}>
      <AgentSettingsPicker {...props} onDone={done} />
    </form>,
  );
  const trigger = screen.getByRole('button', {
    name: /^Agent settings, Bob, Personal, Luna, Medium, OpenShell$/,
  });
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByRole('combobox', { name: 'Agent' })).toBeNull();
  const mountedSelect = screen.getByLabelText('Agent', { selector: 'select' });
  fireEvent.click(trigger);
  expect(trigger.getAttribute('aria-expanded')).toBe('true');
  expect(
    screen.getAllByRole('combobox').map((control) => control.getAttribute('aria-label')),
  ).toEqual(['Agent', 'Account', 'Model', 'Thinking']);
  fireEvent.click(screen.getByRole('button', { name: 'Done' }));
  expect(done).toHaveBeenCalledTimes(1);
  expect(submit).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(trigger);
  expect(mountedSelect.isConnected).toBe(true);
  expect(screen.queryByRole('combobox', { name: 'Agent' })).toBeNull();
  fireEvent.click(trigger);
  expect(screen.getByRole('combobox', { name: 'Agent' })).toBe(mountedSelect);
});

it('dismisses with Escape or close, restores focus, and does not confirm choices', () => {
  const done = vi.fn();
  render(<AgentSettingsPicker {...props} onDone={done} />);
  const trigger = screen.getByRole('button', { name: /^Agent settings/ });
  fireEvent.click(trigger);
  const account = screen.getByRole('combobox', { name: 'Account' });
  account.focus();
  fireEvent.keyDown(account, { key: 'Escape' });
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(trigger);
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole('button', { name: 'Close agent settings' }));
  expect(document.activeElement).toBe(trigger);
  expect(done).not.toHaveBeenCalled();
});

it('reveals attention once and keeps unavailable settings reviewable with Done disabled', () => {
  const done = vi.fn();
  const view = render(
    <AgentSettingsPicker
      {...props}
      attention
      disabled
      onDone={done}
      details={<span role="alert">Account needs confirmation</span>}
    />,
  );
  const trigger = screen.getByRole('button', { name: /^Agent settings/ });
  expect(trigger.getAttribute('aria-expanded')).toBe('true');
  expect(screen.getByRole('button', { name: 'Done' }).hasAttribute('disabled')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Done' }));
  expect(done).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Close agent settings' }));
  view.rerender(<AgentSettingsPicker {...props} attention disabled onDone={done} />);
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(trigger);
  expect(trigger.getAttribute('aria-expanded')).toBe('true');
});

it('reserves heading and repository space as preparation grows and the viewport shrinks', () => {
  let headingHeight = 80;
  let wrapperHeight = 600;
  let resize: (() => void) | undefined;
  let animationFrame: (() => void) | undefined;
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => {
    animationFrame = callback;
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const bounds = vi
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockImplementation(function (this: HTMLElement) {
      const height = this.classList.contains('conversation-composer')
        ? wrapperHeight
        : this.classList.contains('composer-start-heading')
          ? headingHeight
          : this.classList.contains('repository-chat-picker')
            ? 120
            : this.classList.contains('chat-input')
              ? 340
              : this.classList.contains('agent-settings-panel')
                ? 140
                : 0;
      const top = this.classList.contains('conversation-composer') ? 100 : 0;
      return {
        top,
        bottom: top + height,
        height,
        width: 390,
        left: 0,
        right: 390,
        x: 0,
        y: top,
        toJSON() {},
      } as DOMRect;
    });
  try {
    render(
      <div className="conversation-composer conversation-composer--new">
        <div className="composer-start-heading">Start a session</div>
        <div className="repository-chat-picker">Prepared checkout</div>
        <div className="chat-input">
          <textarea aria-label="Message" />
          <AgentSettingsPicker {...props} />
          <div className="composer-toolbar">
            <button>Start session</button>
          </div>
        </div>
      </div>,
    );
    fireEvent.click(screen.getByRole('button', { name: /^Agent settings/ }));
    const panel = screen.getByRole('region', { name: 'Agent settings' });
    expect(panel.style.getPropertyValue('--agent-settings-space')).toBe('200px');
    headingHeight = 140;
    resize?.();
    animationFrame?.();
    expect(panel.style.getPropertyValue('--agent-settings-space')).toBe('140px');
    wrapperHeight = 540;
    fireEvent(window, new Event('resize'));
    expect(panel.style.getPropertyValue('--agent-settings-space')).toBe('80px');
    expect(screen.getByRole('textbox', { name: 'Message' }).isConnected).toBe(true);
    expect(screen.getByRole('button', { name: 'Start session' }).isConnected).toBe(true);
  } finally {
    bounds.mockRestore();
    vi.unstubAllGlobals();
  }
});

it('keeps dismissal and a control row available when preparation consumes free space', () => {
  const actualStyle = window.getComputedStyle.bind(window);
  const styles = vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => {
    const style = actualStyle(element);
    if (element.classList.contains('agent-settings-panel')) {
      Object.defineProperty(style, 'borderTopWidth', { value: '1px', configurable: true });
      Object.defineProperty(style, 'borderBottomWidth', { value: '1px', configurable: true });
    }
    if (element.classList.contains('agent-settings-scroll')) {
      Object.defineProperty(style, 'paddingTop', { value: '8px', configurable: true });
      Object.defineProperty(style, 'paddingBottom', { value: '8px', configurable: true });
    }
    return style;
  });
  const bounds = vi
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockImplementation(function (this: HTMLElement) {
      const height = this.classList.contains('conversation-composer')
        ? 300
        : this.classList.contains('repository-chat-picker')
          ? 260
          : this.classList.contains('chat-input')
            ? 240
            : this.classList.contains('agent-settings-panel')
              ? 100
              : this.classList.contains('agent-settings-header') ||
                  this.classList.contains('agent-settings-footer')
                ? 60
                : this.tagName === 'SELECT'
                  ? 56
                  : 0;
      return {
        top: 0,
        bottom: height,
        height,
        width: 320,
        left: 0,
        right: 320,
        x: 0,
        y: 0,
        toJSON() {},
      } as DOMRect;
    });
  try {
    render(
      <div className="conversation-composer conversation-composer--new">
        <div className="repository-chat-picker">Prepared checkout</div>
        <div className="chat-input">
          <AgentSettingsPicker {...props} summary={{ ...props.summary, thinking: 'high' }} />
        </div>
      </div>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Luna, High, OpenShell/ }));
    const panel = screen.getByRole('region', { name: 'Agent settings' });
    expect(panel.style.getPropertyValue('--agent-settings-minimum')).toBe('194px');
    expect(panel.style.getPropertyValue('--agent-settings-space')).toBe('194px');
    expect(
      Number.parseFloat(panel.style.getPropertyValue('--agent-settings-space')) - 120 - 18,
    ).toBe(56);
    fireEvent.click(screen.getByRole('button', { name: 'Close agent settings' }));
    expect(screen.queryByRole('region', { name: 'Agent settings' })).toBeNull();
  } finally {
    styles.mockRestore();
    bounds.mockRestore();
  }
});

it('scrolls only an oversized bound composer and restores its styles on dismissal', () => {
  let chatHeight = 600;
  const bounds = vi
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockImplementation(function (this: HTMLElement) {
      const height = this.classList.contains('workspace-chat')
        ? chatHeight
        : this.classList.contains('conversation-heading')
          ? 100
          : this.classList.contains('chat-input')
            ? 600
            : this.classList.contains('agent-settings-panel')
              ? 140
              : this.classList.contains('agent-settings-header') ||
                  this.classList.contains('agent-settings-footer')
                ? 60
                : 0;
      return {
        top: 0,
        bottom: height,
        height,
        width: 320,
        left: 0,
        right: 320,
        x: 0,
        y: 0,
        toJSON() {},
      } as DOMRect;
    });
  try {
    const view = render(
      <div className="workspace-chat">
        <header className="conversation-heading">Conversation</header>
        <div className="chat-messages">Transcript</div>
        <div className="conversation-composer" style={{ overflowY: 'visible' }}>
          <div className="chat-input">
            <div role="status">Queued messages retain their attachments</div>
            <textarea aria-label="Message" />
            <AgentSettingsPicker {...props} />
            <button>Send message</button>
          </div>
        </div>
      </div>,
    );
    const wrapper = view.container.querySelector<HTMLElement>('.conversation-composer')!;
    const trigger = screen.getByRole('button', { name: /^Agent settings/ });
    fireEvent.click(trigger);
    expect(wrapper.style.overflowY).toBe('auto');
    expect(wrapper.style.maxHeight).toBe('500px');
    chatHeight = 400;
    fireEvent(window, new Event('resize'));
    expect(wrapper.style.maxHeight).toBe('300px');
    expect(screen.getByRole('button', { name: 'Close agent settings' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close agent settings' }));
    expect(wrapper.style.overflowY).toBe('visible');
    expect(wrapper.style.maxHeight).toBe('');
    expect(wrapper.style.flexShrink).toBe('');
    expect(document.activeElement).toBe(trigger);
  } finally {
    bounds.mockRestore();
  }
});

it('keeps independent settings and keyboard focus outside a conversation composer', () => {
  render(
    <div>
      <section aria-label="Builder">
        <AgentSettingsPicker {...props} />
      </section>
      <section aria-label="Task">
        <AgentSettingsPicker {...props} />
      </section>
    </div>,
  );
  const triggers = screen.getAllByRole('button', { name: /^Agent settings/ });
  fireEvent.click(triggers[1]);
  const region = screen.getByRole('region', { name: 'Agent settings' });
  fireEvent.change(region.querySelector('select')!, { target: { value: 'Bob' } });
  fireEvent.keyDown(region, { key: 'Escape' });
  expect(triggers[0].getAttribute('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(triggers[1]);
  // Shared settings embedded outside chat must have their own bounded scrolling surface.
  expect(region.style.getPropertyValue('--agent-settings-space')).not.toBe('');
});
