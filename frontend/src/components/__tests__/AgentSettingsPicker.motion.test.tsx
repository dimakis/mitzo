// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AgentSettingsPicker } from '../AgentSettingsPicker';

// Deterministic layout/WAAPI model, not browser pointer acceptance. The browser
// regression exercises these same boundaries with the actual CSS and hit testing.
type Held = {
  frames: Keyframe[];
  duration: number;
  currentTime: number;
  playState: string;
  finish(): void;
  cancel: ReturnType<typeof vi.fn>;
  effect: {
    getKeyframes(): Keyframe[];
    setKeyframes(frames: Keyframe[]): void;
    getTiming(): { duration: number };
    updateTiming(timing: { duration: number }): void;
  };
};
const active = new Map<HTMLElement, Held>();
const created: Held[] = [];
let contentHeight = 400;
let budgetAtStart = '';
let reduced = false;
const mediaListeners = new Set<() => void>();
const rect = (height: number) =>
  ({ height, top: 0, bottom: height, left: 0, right: 390, width: 390 }) as DOMRect;
function naturalHeight(panel: HTMLElement) {
  return Math.max(
    Number.parseFloat(panel.style.getPropertyValue('--agent-settings-minimum')) || 132,
    Math.min(
      contentHeight,
      window.innerHeight * 0.7,
      Number.parseFloat(panel.style.getPropertyValue('--agent-settings-space')) ||
        window.innerHeight * 0.45,
    ),
  );
}
function renderedHeight(panel: HTMLElement) {
  const animation = active.get(panel);
  if (!animation?.frames.length) return naturalHeight(panel);
  const [start, end] = animation.frames;
  const progress = Math.min(1, animation.currentTime / animation.duration);
  const height =
    Number.parseFloat(String(start.height)) * (1 - progress) +
    Number.parseFloat(String(end.height)) * progress;
  return start.minHeight === '0px' && start.maxHeight === 'none'
    ? height
    : Math.max(132, Math.min(naturalHeight(panel), height));
}
beforeEach(() => {
  active.clear();
  created.length = 0;
  contentHeight = 400;
  budgetAtStart = '';
  reduced = false;
  vi.stubGlobal('matchMedia', () => ({
    matches: reduced,
    addEventListener: (_: string, fn: () => void) => mediaListeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => mediaListeners.delete(fn),
  }));
  const computed = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => {
    const style = computed(element);
    if (element === document.documentElement) {
      const get = style.getPropertyValue.bind(style);
      style.getPropertyValue = (name) =>
        name === '--motion-duration-standard'
          ? '200ms'
          : name === '--motion-ease'
            ? 'linear'
            : get(name);
    }
    return style;
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.classList.contains('agent-settings-panel')) return rect(renderedHeight(this));
    if (this.classList.contains('agent-settings-picker')) {
      const panel = this.querySelector<HTMLElement>('.agent-settings-panel')!;
      return rect(renderedHeight(panel) + 100);
    }
    if (
      this.classList.contains('agent-settings-header') ||
      this.classList.contains('agent-settings-footer')
    )
      return rect(44);
    return rect(this.matches('button,select') ? 44 : 0);
  });
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => 1200);
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  Object.defineProperty(HTMLElement.prototype, 'animate', {
    configurable: true,
    value: function (this: HTMLElement, frames: Keyframe[], options: KeyframeAnimationOptions) {
      budgetAtStart = this.style.getPropertyValue('--agent-settings-space');
      let finish!: () => void;
      const held: Held = {
        frames,
        duration: Number(options.duration),
        currentTime: 0,
        playState: 'paused',
        finish: () => {
          held.currentTime = held.duration;
          held.playState = 'finished';
          finish();
        },
        cancel: vi.fn(() => {
          active.delete(this);
          held.playState = 'idle';
        }),
        effect: {
          getKeyframes: () => held.frames,
          setKeyframes: (next) => {
            held.frames = next;
          },
          getTiming: () => ({ duration: held.duration }),
          updateTiming: ({ duration }) => {
            held.duration = duration;
          },
        },
      };
      active.set(this, held);
      created.push(held);
      return Object.assign(held, { finished: new Promise<void>((resolve) => (finish = resolve)) });
    },
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  mediaListeners.clear();
  delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
});
const settings = (loaded = false) => (
  <AgentSettingsPicker
    summary={{ agent: 'Task', location: 'openshell' }}
    agent={<p>Task agent</p>}
    accountModel={
      <label>
        Account
        <select aria-label="Account">
          <option>Task account</option>
        </select>
      </label>
    }
    execution={<button type="button">Local Mac</button>}
    details={loaded ? <p>Asynchronously loaded settings taller than the viewport</p> : null}
  />
);
function open() {
  fireEvent.click(screen.getByRole('button', { name: /^Agent settings/ }));
  return screen.getByRole('region', { name: 'Agent settings' });
}

it('measures the actual picker after its budget and interpolates without min/max plateaus', async () => {
  contentHeight = 1200;
  render(settings());
  const panel = open();
  const held = created[0];
  expect(budgetAtStart).toBe('668px');
  const destination = naturalHeight(panel);
  expect(held.frames[1].height).toBe(`${destination}px`);
  for (const fraction of [0, 0.1, 0.5, 0.9, 1]) {
    held.currentTime = held.duration * fraction;
    expect(panel.getBoundingClientRect().height).toBeCloseTo(destination * fraction);
  }
  const before = panel.getBoundingClientRect().height;
  await act(async () => held.finish());
  expect(panel.getBoundingClientRect().height).toBe(before);
  expect(panel.dataset.motionActive).toBeUndefined();
  expect(panel.style.minHeight).toBe('');
  expect(panel.style.maxHeight).toBe('');
});

it('retargets loaded content from the held rendered frame without replaying or replacing controls', async () => {
  const view = render(settings());
  const panel = open();
  const control = screen.getByRole('button', { name: 'Local Mac' });
  const held = created[0];
  held.currentTime = 80;
  const before = panel.getBoundingClientRect().height;
  const scroll = panel.querySelector<HTMLElement>('.agent-settings-scroll')!;
  scroll.scrollTop = 68;
  contentHeight = 1200;
  await act(async () => view.rerender(settings(true)));
  expect(panel.getBoundingClientRect().height).toBeCloseTo(before);
  expect(held.frames[1].height).toBe(`${naturalHeight(panel)}px`);
  expect(held.duration).toBe(120);
  expect(scroll.scrollTop).toBe(68);
  expect(created).toHaveLength(1);
  expect(screen.getByRole('button', { name: 'Local Mac' })).toBe(control);
  await act(async () => held.finish());
  expect(panel.getBoundingClientRect().height).toBe(naturalHeight(panel));
  contentHeight = 300;
  view.rerender(settings());
  expect(panel.getBoundingClientRect().height).toBe(300);
  expect(created).toHaveLength(1);
});

it('keeps the interrupted frame, exit inertness, focus and Reduce Motion release', () => {
  render(settings());
  const panel = open();
  const control = screen.getByRole('button', { name: 'Local Mac' });
  control.focus();
  created[0].currentTime = 100;
  const height = panel.getBoundingClientRect().height;
  fireEvent.keyDown(control, { key: 'Escape' });
  expect(created[1].frames[0].height).toBe(`${height}px`);
  expect(panel.hasAttribute('inert')).toBe(true);
  expect(panel.getAttribute('aria-hidden')).toBe('true');
  expect(document.activeElement).toBe(screen.getByRole('button', { name: /^Agent settings/ }));
  fireEvent.click(document.activeElement!);
  expect(control.isConnected).toBe(true);
  act(() => {
    reduced = true;
    mediaListeners.forEach((listener) => listener());
  });
  expect(created.at(-1)!.cancel).toHaveBeenCalled();
  expect(panel.hidden).toBe(false);
  expect(panel.dataset.motionActive).toBeUndefined();
});

it('retargets a shrinking viewport without restarting the entrance deadline', () => {
  contentHeight = 1200;
  render(settings());
  const panel = open();
  const held = created[0];
  held.currentTime = 100;
  const before = panel.getBoundingClientRect().height;
  vi.stubGlobal('innerHeight', 500);
  fireEvent(window, new Event('resize'));
  expect(panel.getBoundingClientRect().height).toBeCloseTo(before);
  expect(held.frames[1].height).toBe('350px');
  expect(held.duration).toBe(100);
  expect(created).toHaveLength(1);
});
