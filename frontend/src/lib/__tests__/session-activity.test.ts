import { expect, it } from 'vitest';
import { mergeSessionActivities, mergeSessionModel } from '../session-activity';

const saved = { id: 'one', summary: 'Saved chat', lastModified: 1, model: 'Luna' };
const activity = {
  sessionId: 'one',
  clientId: 'client',
  title: 'Saved chat',
  state: 'working' as const,
  flags: [],
  lastEventAt: 2,
};

it('clears a cached known model when the newer receipt read is unavailable', () => {
  const failed = { ...activity, modelUnavailable: true, modelObservedAt: 20 };
  const result = mergeSessionActivities([{ ...saved, modelObservedAt: 10 }], [failed]).get('one');
  expect(result).toMatchObject({ modelUnavailable: true, modelObservedAt: 20 });
  expect(result?.model).toBeUndefined();
  expect(result?.summary).toBe('Saved chat');
});

it('restores a fresh known model after an unavailable observation', () => {
  const unknown = { ...saved, model: undefined, modelUnavailable: true, modelObservedAt: 20 };
  const recovered = { ...activity, model: 'Sol', modelObservedAt: 30 };
  expect(mergeSessionActivities([unknown], [recovered]).get('one')).toMatchObject({
    model: 'Sol',
    modelUnavailable: false,
    modelObservedAt: 30,
  });
});

it('keeps legacy fallback metadata when the activity does not report model evidence', () => {
  expect(mergeSessionActivities([saved], [activity]).get('one')?.model).toBe('Luna');
});

it('retains unavailable display evidence across disconnect without restoring active state', () => {
  const failed = { ...activity, modelUnavailable: true, modelObservedAt: 20 };
  const result = mergeSessionActivities([saved], [], [failed]).get('one');
  expect(result?.model).toBeUndefined();
  expect(result?.modelUnavailable).toBe(true);
  expect(result?.isActive).toBeUndefined();
  expect(
    mergeSessionActivities([{ ...saved, model: 'Sol', modelObservedAt: 30 }], [], [failed]).get(
      'one',
    ),
  ).toMatchObject({ model: 'Sol', modelUnavailable: false, modelObservedAt: 30 });
});

it('uses fresh search uncertainty over a cached list and fresh overview recovery over old search', () => {
  const failedSearch = { modelUnavailable: true, modelObservedAt: 20 };
  const unknown = mergeSessionModel({ model: 'Luna', modelObservedAt: 10 }, failedSearch);
  expect(unknown).toMatchObject({ modelUnavailable: true, modelObservedAt: 20 });
  expect(unknown.model).toBeUndefined();
  expect(mergeSessionModel({ model: 'Sol', modelObservedAt: 30 }, failedSearch)).toMatchObject({
    model: 'Sol',
    modelUnavailable: false,
    modelObservedAt: 30,
  });
});

it('clears a cached preview model and preserves conservative uncertainty at equal read times', () => {
  const cached = { model: 'Luna', modelObservedAt: 20 };
  const failed = { modelUnavailable: true, modelObservedAt: 20 };
  expect(mergeSessionModel(failed, cached).model).toBeUndefined();
  expect(mergeSessionModel(cached, failed).model).toBeUndefined();
  expect(mergeSessionModel({ model: 'Sol', modelObservedAt: 30 }, failed)).toMatchObject({
    model: 'Sol',
    modelUnavailable: false,
    modelObservedAt: 30,
  });
});
