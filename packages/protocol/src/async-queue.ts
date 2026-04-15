/**
 * A pushable async iterable queue.
 *
 * Allows one producer to push values and one consumer to iterate with
 * `for await`. Designed for the streaming-input query pattern where user
 * messages are pushed into a long-lived SDK query.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private resolve: (() => void) | null = null;
  private closed = false;

  /** Push a value to the queue. No-op if already closed. */
  push(value: T): void {
    if (this.closed) return;
    this.queue.push(value);
    this.resolve?.();
    this.resolve = null;
  }

  /** Close the queue. The consumer iterator will finish after draining remaining values. */
  close(): void {
    this.closed = true;
    this.resolve?.();
    this.resolve = null;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.closed) return;
      await new Promise<void>((res) => {
        this.resolve = res;
      });
    }
  }
}
