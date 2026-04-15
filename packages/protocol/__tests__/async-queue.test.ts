import { describe, it, expect } from 'vitest';
import { AsyncQueue } from '../src/async-queue.js';

describe('AsyncQueue', () => {
  it('yields values pushed before iteration', async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.push(2);
    q.close();

    const values: number[] = [];
    for await (const v of q) values.push(v);
    expect(values).toEqual([1, 2]);
  });

  it('yields values pushed during iteration', async () => {
    const q = new AsyncQueue<string>();
    const values: string[] = [];

    const consumer = (async () => {
      for await (const v of q) values.push(v);
    })();

    q.push('a');
    q.push('b');
    // Give the consumer a tick to process
    await new Promise((r) => setTimeout(r, 10));
    q.close();
    await consumer;

    expect(values).toEqual(['a', 'b']);
  });

  it('close() terminates iteration after drain', async () => {
    const q = new AsyncQueue<number>();
    q.push(1);

    const values: number[] = [];
    const consumer = (async () => {
      for await (const v of q) values.push(v);
    })();

    await new Promise((r) => setTimeout(r, 10));
    q.close();
    await consumer;

    expect(values).toEqual([1]);
  });

  it('push after close is a no-op', async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.close();
    q.push(2); // should be ignored

    const values: number[] = [];
    for await (const v of q) values.push(v);
    expect(values).toEqual([1]);
  });

  it('empty queue closes cleanly', async () => {
    const q = new AsyncQueue<number>();
    q.close();

    const values: number[] = [];
    for await (const v of q) values.push(v);
    expect(values).toEqual([]);
  });

  it('consumer waits for values when queue is empty', async () => {
    const q = new AsyncQueue<number>();
    const values: number[] = [];

    const consumer = (async () => {
      for await (const v of q) values.push(v);
    })();

    // Consumer should be waiting
    await new Promise((r) => setTimeout(r, 10));
    expect(values).toEqual([]);

    q.push(42);
    await new Promise((r) => setTimeout(r, 10));
    expect(values).toEqual([42]);

    q.close();
    await consumer;
  });

  it('implements AsyncIterable protocol', () => {
    const q = new AsyncQueue<number>();
    expect(Symbol.asyncIterator in q).toBe(true);
    q.close();
  });
});
