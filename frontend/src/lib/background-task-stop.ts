/** Consumer boundary for an independently authorized task-only adapter.
 * The current SDK producer does NOT provide this capability. Never construct
 * it from a task ID, a display receipt, or the parent conversation's Stop API.
 * The eventual owner must revalidate this entire binding before effects and
 * durably retain the request/receipt for cold recovery. */
export interface TaskExecutionIdentity {
  sessionId: string;
  processGeneration: string;
  taskId: string;
  runId: string;
  parentToolId: string;
  subagentMessageId: string;
}
export interface TaskStopRequest {
  readonly execution: Readonly<TaskExecutionIdentity>;
  readonly requestId: string;
}
export interface TaskStopReceipt extends TaskStopRequest {
  revision: number;
  status: 'requested' | 'refused' | 'unknown';
}
export interface TaskStopAdapter {
  stop(request: TaskStopRequest): Promise<TaskStopReceipt>;
  /** Read the original receipt; never dispatch or retry an effect here. */
  read(request: TaskStopRequest): Promise<TaskStopReceipt>;
}
interface StopState {
  status: 'idle' | 'pending' | TaskStopReceipt['status'];
  checking: boolean;
  checkFailed: boolean;
}
const keys: (keyof TaskExecutionIdentity)[] = [
  'sessionId',
  'processGeneration',
  'taskId',
  'runId',
  'parentToolId',
  'subagentMessageId',
];

/** Owned outside the mounted row, so navigation cannot create another request. */
export class BackgroundTaskStopController {
  readonly execution: Readonly<TaskExecutionIdentity>;
  private original?: TaskStopRequest;
  private revision = -1;
  private state: StopState = { status: 'idle', checking: false, checkFailed: false };
  private listeners = new Set<() => void>();

  constructor(
    execution: TaskExecutionIdentity,
    private readonly adapter: TaskStopAdapter,
    private readonly requestId: () => string = () => crypto.randomUUID(),
    private readonly diagnostic = (code: string, requestId: string) => {
      console.warn('background_task_stop', { code, requestId });
    },
  ) {
    if (keys.some((key) => typeof execution[key] !== 'string' || !execution[key]))
      throw new Error('An exact task execution binding is required');
    this.execution = Object.freeze({ ...execution });
  }

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(patch: Partial<StopState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  private accept(receipt: TaskStopReceipt) {
    if (
      !receipt ||
      receipt.requestId !== this.original?.requestId ||
      !receipt.execution ||
      keys.some((key) => receipt.execution[key] !== this.execution[key]) ||
      !Number.isSafeInteger(receipt.revision) ||
      receipt.revision < 0 ||
      !['requested', 'refused', 'unknown'].includes(receipt.status)
    ) {
      throw new Error('Unmatched task Stop receipt');
    }
    if (receipt.revision <= this.revision) return;
    this.revision = receipt.revision;
    this.update({ status: receipt.status });
  }
  private async bounded(operation: Promise<TaskStopReceipt>) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Task Stop response deadline')), 15_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  async request() {
    // Including refusal/unknown: a second click is never a fresh mutation.
    if (this.original) return;
    this.original = Object.freeze({ execution: this.execution, requestId: this.requestId() });
    this.update({ status: 'pending' });
    try {
      this.accept(await this.bounded(this.adapter.stop(this.original)));
    } catch {
      this.diagnostic('stop_request_failed', this.original.requestId);
      this.update({ status: 'unknown' });
    }
  }
  async check() {
    if (!this.original || this.state.checking || this.state.status === 'pending') return;
    this.update({ checking: true, checkFailed: false });
    try {
      this.accept(await this.bounded(this.adapter.read(this.original)));
    } catch {
      this.diagnostic('stop_receipt_read_failed', this.original.requestId);
      this.update({ checkFailed: true });
    } finally {
      this.update({ checking: false });
    }
  }
}
