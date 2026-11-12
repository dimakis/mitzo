// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { hiddenPickerModels, setHiddenPickerModels, pickerModels } from '../model-visibility';
afterEach(() => {
  setHiddenPickerModels('work', []);
  setHiddenPickerModels('personal', []);
  localStorage.clear();
});
it('shows new models automatically and retains account-scoped hidden IDs across catalog changes', () => {
  const models = [
    { id: 'first', label: 'First' },
    { id: 'second', label: 'Second' },
  ];
  setHiddenPickerModels('work', ['first']);
  expect(pickerModels('work', models).map((m) => m.id)).toEqual(['second']);
  expect(pickerModels('personal', models)).toEqual(models);
  expect(pickerModels('work', [...models, { id: 'new', label: 'New' }]).map((m) => m.id)).toEqual([
    'second',
    'new',
  ]);
  expect(hiddenPickerModels('work')).toEqual(['first']);
  expect(pickerModels('work', models, 'first')).toEqual(models);
  setHiddenPickerModels('work', ['first', 'second']);
  expect(pickerModels('work', models)).toEqual([]);
});
