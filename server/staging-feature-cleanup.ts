/** Original process-local adapter capabilities. No receipt JSON, process lookup
 * or idle observation can insert a capability. Deadline expiry keeps this object
 * and its original pending promises alive for owner reconciliation. */
export class StagingOwnedCleanup {
  private readonly handles: Array<() => Promise<void>> = [];
  private acknowledgment?: Promise<void>;
  private sealed = false;
  confirmed = false;
  retain(close: () => Promise<void>): void {
    if (this.sealed || this.handles.length >= 8)
      throw new Error('Staging cleanup capability set sealed');
    this.handles.push(close);
  }
  async confirm(timeoutMs: number): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000)
      throw new Error('Staging cleanup budget invalid');
    this.sealed = true;
    this.acknowledgment ??= Promise.allSettled(
      this.handles.map((close) => Promise.resolve().then(close)),
    ).then((results) => {
      if (!results.length || results.some((result) => result.status !== 'fulfilled'))
        throw new Error('Original staging cleanup unconfirmed');
      this.confirmed = true;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.acknowledgment,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('Original staging cleanup unconfirmed')),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
export interface StagingFeatureAdapterOptions {
  beforeDispatch(): void;
  maxModelRounds: 2;
  fixturePath: string;
  retainCleanup(close: () => Promise<void>): void;
}
