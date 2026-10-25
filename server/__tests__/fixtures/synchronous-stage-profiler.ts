import { vi } from 'vitest';
import { FrozenHostCodexBootstrapAuthority } from '../../frozen-host-codex-bootstrap.js';
import { FrozenHostCodexLogin } from '../../frozen-host-codex-login.js';
import { FrozenHostCodexExecutable } from '../../frozen-host-codex-executable.js';
import { OrdinaryLocalCodexHostRuntime } from '../../ordinary-local-codex-host-runtime.js';
import { OwnedLocalCodexChatAdmission } from '../../owned-local-codex-chat-admission.js';
import { CodexConversationStore } from '../../codex-conversation-store.js';
import { EventStore } from '../../event-store.js';
import * as accountProfiles from '../../account-profiles.js';
import * as nativeReaders from '../../local-repository-native-read.js';
type SyncFunction = (...args: never[]) => unknown;
type Totals = {
  calls: number;
  outermostCalls: number;
  recursiveCalls: number;
  maxRecursionDepth: number;
  inclusiveMs: number;
  exclusiveMs: number;
};
const rounded = (value: number) => Number(value.toFixed(3));
const empty = (): Totals => ({
  calls: 0,
  outermostCalls: 0,
  recursiveCalls: 0,
  maxRecursionDepth: 0,
  inclusiveMs: 0,
  exclusiveMs: 0,
});

/** Test-only synchronous entry profiling. Never inspects arguments/results,
 * awaits promises, changes return identity, or holds a frame across an await. */
export class SynchronousStageProfiler {
  private readonly stages = new Map<string, Totals>();
  private readonly windows = new Map<string, Map<string, Totals>>();
  private readonly depths = new Map<string, number>();
  private readonly stack: Array<{ childrenMs: number }> = [];
  constructor(
    private readonly clock = () => performance.now(),
    private readonly classify = (_time: number) => 'measured',
  ) {}
  wrap<T extends SyncFunction>(stage: string, original: T): T {
    const clock = () => this.clock();
    const classify = (time: number) => this.classify(time);
    const { stages, windows, depths, stack } = this;
    return function (this: unknown, ...args: Parameters<T>): ReturnType<T> {
      const started = clock();
      const window = classify(started);
      let entries = windows.get(window);
      if (!entries) {
        entries = new Map();
        windows.set(window, entries);
      }
      const stats = [stages, entries].map((values) => {
        let value = values.get(stage);
        if (!value) {
          value = empty();
          values.set(stage, value);
        }
        return value;
      });
      const depth = (depths.get(stage) ?? 0) + 1;
      depths.set(stage, depth);
      for (const value of stats) {
        value.calls++;
        value.outermostCalls += depth === 1 ? 1 : 0;
        value.recursiveCalls += depth > 1 ? 1 : 0;
        value.maxRecursionDepth = Math.max(value.maxRecursionDepth, depth);
      }
      const frame = { childrenMs: 0 };
      stack.push(frame);
      try {
        return Reflect.apply(original, this, args) as ReturnType<T>;
      } finally {
        const elapsed = Math.max(0, clock() - started);
        stack.pop();
        depths.set(stage, depth - 1);
        const parent = stack.at(-1);
        if (parent) parent.childrenMs += elapsed;
        for (const value of stats) {
          value.inclusiveMs += elapsed;
          value.exclusiveMs += Math.max(0, elapsed - frame.childrenMs);
        }
      }
    } as T;
  }
  reset() {
    if (this.stack.length) throw Error('Cannot reset an active synchronous profile');
    this.stages.clear();
    this.windows.clear();
    this.depths.clear();
  }
  snapshot() {
    const project = (entries: Map<string, Totals>) => ({
      instrumentedMs: rounded(
        [...entries.values()].reduce((sum, value) => sum + value.exclusiveMs, 0),
      ),
      stages: Object.fromEntries(
        [...entries].map(([key, value]) => [
          key,
          {
            ...value,
            inclusiveMs: rounded(value.inclusiveMs),
            exclusiveMs: rounded(value.exclusiveMs),
          },
        ]),
      ),
    });
    return {
      ...project(this.stages),
      windows: Object.fromEntries(
        [...this.windows].map(([key, entries]) => [key, project(entries)]),
      ),
    };
  }
}

/** Plain wrappers let fixture instance spies capture their original receiver
 * without treating a prototype spy as the instance spy and recursing into it. */
export function installSynchronousStage(
  profile: SynchronousStageProfiler,
  target: object,
  key: string,
  stage: string,
): () => void {
  const own = Object.getOwnPropertyDescriptor(target, key);
  let descriptor = own;
  for (
    let parent = Object.getPrototypeOf(target) as object | null;
    !descriptor && parent;
    parent = Object.getPrototypeOf(parent) as object | null
  )
    descriptor = Object.getOwnPropertyDescriptor(parent, key);
  if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'function')
    throw Error('Missing synchronous profiling method');
  const wrapped = profile.wrap(stage, descriptor.value as SyncFunction);
  Object.defineProperty(target, key, { ...descriptor, value: wrapped });
  return () => {
    if (own) Object.defineProperty(target, key, own);
    else Reflect.deleteProperty(target, key);
  };
}

type ReaderEntry = { elapsedMs: number; deadlineRemainingMs: number };
type HelperEntry = {
  startedMs: number;
  startDeadlineRemainingMs: number | null;
  endedMs: number | null;
  endDeadlineRemainingMs: number | null;
  elapsedMs: number | null;
  success: boolean | null;
};
/** Bounded metadata-only marks. These clocks observe the deadline; they never
 * change it, and no source path, input, output, error or account is retained. */
export class NativeReadBoundaryProfile {
  private origin: number;
  private deadline: number | undefined;
  private deadlineAt: number | undefined;
  private readonly readers: ReaderEntry[] = [];
  private readonly helpers: HelperEntry[] = [];
  private droppedReaders = 0;
  private droppedHelpers = 0;
  constructor(
    private readonly clock = () => performance.now(),
    private readonly wall = () => Date.now(),
  ) {
    this.origin = clock();
  }
  reset() {
    this.origin = this.clock();
    this.deadline = undefined;
    this.deadlineAt = undefined;
    this.readers.length = 0;
    this.helpers.length = 0;
    this.droppedReaders = 0;
    this.droppedHelpers = 0;
  }
  readerEntry(deadline: number) {
    const now = this.clock(),
      remaining = deadline - this.wall();
    this.deadline = deadline;
    this.deadlineAt = now + remaining;
    if (this.readers.length < 4)
      this.readers.push({
        elapsedMs: rounded(now - this.origin),
        deadlineRemainingMs: rounded(remaining),
      });
    else this.droppedReaders++;
  }
  windowAt(time: number) {
    return this.deadlineAt === undefined
      ? 'before-reader'
      : time < this.deadlineAt
        ? 'reader-budget'
        : 'after-deadline';
  }
  beginHelper(): (success: boolean) => void {
    if (this.helpers.length >= 12) {
      this.droppedHelpers++;
      return () => {};
    }
    const started = this.clock();
    const entry: HelperEntry = {
      startedMs: rounded(started - this.origin),
      startDeadlineRemainingMs:
        this.deadline === undefined ? null : rounded(this.deadline - this.wall()),
      endedMs: null,
      endDeadlineRemainingMs: null,
      elapsedMs: null,
      success: null,
    };
    this.helpers.push(entry);
    return (success) => {
      if (entry.endedMs !== null) return;
      const now = this.clock();
      entry.endedMs = rounded(now - this.origin);
      entry.elapsedMs = rounded(now - started);
      entry.success = success;
      entry.endDeadlineRemainingMs =
        this.deadline === undefined ? null : rounded(this.deadline - this.wall());
    };
  }
  snapshot() {
    return {
      readerEntries: this.readers.map((entry) => ({ ...entry })),
      helpers: this.helpers.map((entry) => ({ ...entry })),
      droppedReaderEntries: this.droppedReaders,
      droppedHelpers: this.droppedHelpers,
    };
  }
}

export function installSignedNativeReadStages(
  profile: SynchronousStageProfiler,
  boundaries: NativeReadBoundaryProfile,
) {
  const restores: Array<() => void> = [];
  const restoreAll = () => restores.reverse().forEach((restore) => restore());
  try {
    // Install plain wrappers before any fixture owner captures these references.
    // The fixture later spies on an admission INSTANCE; a prototype vi.spyOn
    // would share that mock and recurse when its captured original is invoked.
    for (const [target, method, stage] of [
      [FrozenHostCodexBootstrapAuthority.prototype, 'assertSync', 'bootstrap.current'],
      [FrozenHostCodexBootstrapAuthority.prototype, 'profile', 'bootstrap.profile'],
      [
        FrozenHostCodexBootstrapAuthority.prototype,
        'assertColdOwnerIdentity',
        'bootstrap.coldIdentity',
      ],
      [FrozenHostCodexLogin.prototype, 'assertFilesCurrent', 'login.files'],
      [FrozenHostCodexExecutable.prototype, 'assertCurrent', 'executable.current'],
      [OrdinaryLocalCodexHostRuntime.prototype, 'assertCurrentSync', 'runtime.current'],
      [OwnedLocalCodexChatAdmission.prototype, 'assertReceipt', 'admission.receipt'],
      [OwnedLocalCodexChatAdmission.prototype, 'assertCurrentSync', 'admission.current'],
      [CodexConversationStore.prototype, 'pendingNativeHostTool', 'nativeStore.pendingTool'],
      [CodexConversationStore.prototype, 'readHostCustody', 'nativeStore.hostCustody'],
      [CodexConversationStore.prototype, 'commandStatus', 'nativeStore.commandStatus'],
      [EventStore.prototype, 'getSession', 'events.session'],
      [EventStore.prototype, 'getSessionRuntimeBinding', 'events.runtimeBinding'],
    ] as const)
      restores.push(installSynchronousStage(profile, target, method, stage));
    const load = accountProfiles.loadAccountProfiles;
    const loadSpy = vi
      .spyOn(accountProfiles, 'loadAccountProfiles')
      .mockImplementation(profile.wrap('accounts.load', load));
    restores.push(() => loadSpy.mockRestore());
    const capture = nativeReaders.captureNativeLocalRepositoryReader;
    const captureSpy = vi
      .spyOn(nativeReaders, 'captureNativeLocalRepositoryReader')
      .mockImplementation(function (this: unknown, ...args: Parameters<typeof capture>) {
        try {
          const options = args[1];
          if (options !== null && (typeof options === 'object' || typeof options === 'function')) {
            const deadline = Object.getOwnPropertyDescriptor(options, 'deadline');
            if (deadline && 'value' in deadline && typeof deadline.value === 'number')
              boundaries.readerEntry(deadline.value);
          }
        } catch {
          // Optional metadata observation must never replace the original
          // async call with a synchronous failure (including proxy traps).
        }
        // Observe invocation only; return the exact original Promise without a
        // .then handler, extra await, different receiver or altered options.
        return Reflect.apply(capture, this, args) as ReturnType<typeof capture>;
      });
    restores.push(() => captureSpy.mockRestore());
    return restoreAll;
  } catch (error) {
    restoreAll();
    throw error;
  }
}
