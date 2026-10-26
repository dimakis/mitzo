import { afterEach, expect, it, vi } from 'vitest';
import {
  preparationReadDeadline,
  preparationCommandTimeout,
} from '../local-repository-preparation-read-policy.js';
import { withLocalRepositoryPreparationEnvelope } from '../local-repository-preparation-operation.js';

afterEach(() => vi.useRealTimers());
it('normalizes only private preparation read stages to sixty seconds', () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  expect(preparationReadDeadline(301000, new AbortController().signal)).toBe(61000);
});
it.each([5000, 19000])('retains earlier absolute overall/evidence expiry %i', (deadline) => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  expect(preparationReadDeadline(deadline, new AbortController().signal)).toBe(deadline);
});
it('refuses an expired stage before a reader can be captured', () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  expect(() => preparationReadDeadline(1000, new AbortController().signal)).toThrow();
});
it('retains original abort before any read or command', () => {
  const controller = new AbortController();
  controller.abort(Error('original Stop'));
  expect(() => preparationReadDeadline(Date.now() + 300000, controller.signal)).toThrow(
    'original Stop',
  );
  expect(() => preparationCommandTimeout(Date.now() + 60000, controller.signal)).toThrow(
    'original Stop',
  );
});
it('never widens individual private Git commands beyond thirty seconds', () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  expect(preparationCommandTimeout(61000)).toBe(30000);
  vi.setSystemTime(56000);
  expect(preparationCommandTimeout(61000)).toBe(5000);
  vi.setSystemTime(61000);
  expect(() => preparationCommandTimeout(61000)).toThrow();
});
it('keeps the fixed envelope and effect-stage deadline unchanged', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  await withLocalRepositoryPreparationEnvelope(new AbortController().signal, async (envelope) => {
    expect(envelope.deadline).toBe(301000);
    expect(envelope.stageDeadline()).toBe(31000);
    expect(preparationReadDeadline(envelope.deadline, envelope.signal)).toBe(61000);
    await vi.advanceTimersByTimeAsync(295000);
    expect(preparationReadDeadline(envelope.deadline, envelope.signal)).toBe(301000);
    expect(envelope.stageDeadline()).toBe(301000);
  });
});
