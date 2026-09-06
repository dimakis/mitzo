import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { SKILL_WATCHER_DEBOUNCE_MS } from '../constants.js';

const fsMock = vi.hoisted(() => ({ watch: vi.fn(), existsSync: vi.fn() }));
vi.mock('fs', () => fsMock);
import { SkillWatcher } from '../skill-watcher.js';

// Drive native watcher callbacks directly: OS event delivery/coalescing is not
// deterministic, especially immediately after registering a recursive watcher.
describe('SkillWatcher', () => {
  let watchers: SkillWatcher[];
  let native: Array<EventEmitter & { close: ReturnType<typeof vi.fn> }>;
  let callbacks: Array<(event: string, filename: string | null) => void>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    watchers = [];
    native = [];
    callbacks = [];
    fsMock.existsSync.mockReturnValue(true);
    fsMock.watch.mockImplementation((_dir, _options, callback) => {
      const handle = Object.assign(new EventEmitter(), { close: vi.fn() });
      native.push(handle);
      callbacks.push(callback);
      return handle;
    });
  });

  afterEach(() => {
    for (const watcher of watchers) watcher.destroy();
    vi.useRealTimers();
  });

  function create(dirs = ['/skills']) {
    const invalidate = vi.fn();
    const watcher = new SkillWatcher(dirs, invalidate);
    watchers.push(watcher);
    return { watcher, invalidate };
  }

  it.each(['rename', 'change'])('invalidates on SKILL.md %s events', (event) => {
    const { invalidate } = create();
    expect(fsMock.watch).toHaveBeenCalledWith('/skills', { recursive: true }, expect.any(Function));
    callbacks[0](event, 'deploy/SKILL.md');
    expect(invalidate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(SKILL_WATCHER_DEBOUNCE_MS);
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it('handles root-level SKILL.md changes', () => {
    const { invalidate } = create();
    callbacks[0]('change', 'SKILL.md');
    vi.runAllTimers();
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it.each(['deploy/README.md', 'deploy/NOT-SKILL.md', null])(
    'ignores unrelated filename %s',
    (name) => {
      const { invalidate } = create();
      callbacks[0]('change', name);
      vi.runAllTimers();
      expect(invalidate).not.toHaveBeenCalled();
    },
  );

  it('debounces rapid changes across watched directories', () => {
    const { invalidate } = create(['/one', '/two']);
    callbacks[0]('rename', 'one/SKILL.md');
    vi.advanceTimersByTime(SKILL_WATCHER_DEBOUNCE_MS - 1);
    callbacks[1]('change', 'two/SKILL.md');
    vi.advanceTimersByTime(SKILL_WATCHER_DEBOUNCE_MS - 1);
    expect(invalidate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it('skips missing directories', () => {
    fsMock.existsSync.mockReturnValue(false);
    create();
    expect(fsMock.watch).not.toHaveBeenCalled();
  });

  it('handles watch registration errors', () => {
    fsMock.watch.mockImplementation(() => {
      throw new Error('watch unavailable');
    });
    expect(() => create()).not.toThrow();
  });

  it('watchDir is idempotent', () => {
    const { watcher } = create();
    watcher.watchDir('/skills');
    expect(fsMock.watch).toHaveBeenCalledTimes(1);
  });

  it('closes handles and cancels pending or late invalidations on destroy', () => {
    const { watcher, invalidate } = create();
    callbacks[0]('change', 'SKILL.md');
    watcher.destroy();
    callbacks[0]('change', 'SKILL.md');
    watcher.watchDir('/another');
    vi.runAllTimers();
    expect(native[0].close).toHaveBeenCalledTimes(1);
    expect(fsMock.watch).toHaveBeenCalledTimes(1);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('invalidates and removes a failed watcher so it can be registered again', () => {
    const { watcher, invalidate } = create();
    native[0].emit('error', new Error('lost watch'));
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(native[0].close).toHaveBeenCalledTimes(1);
    watcher.watchDir('/skills');
    expect(fsMock.watch).toHaveBeenCalledTimes(2);
  });
});
