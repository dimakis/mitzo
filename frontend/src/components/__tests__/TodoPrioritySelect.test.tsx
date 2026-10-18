// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TodoPrioritySelect } from '../TodoPrioritySelect';

afterEach(cleanup);

it('offers exactly 1–10, serializes saves, and keeps the last confirmed value after failure', async () => {
  let finish!: () => void;
  const save = vi.fn().mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  function Fixture() {
    const [priority, setPriority] = useState(5);
    return (
      <TodoPrioritySelect
        priority={priority}
        onChange={async (next) => {
          await save(next);
          setPriority(next);
        }}
      />
    );
  }
  render(<Fixture />);
  const select = screen.getByRole('combobox', { name: 'Priority' }) as HTMLSelectElement;
  expect([...select.options].map((option) => [option.value, option.text])).toEqual(
    Array.from({ length: 10 }, (_, index) => [String(index + 1), `${index + 1} / 10`]),
  );
  fireEvent.change(select, { target: { value: '7' } });
  expect(select.disabled).toBe(true);
  expect(select.value).toBe('5');
  fireEvent.change(select, { target: { value: '9' } });
  expect(save).toHaveBeenCalledTimes(1);
  await act(async () => finish());
  await waitFor(() => expect(select.disabled).toBe(false));
  expect(select.value).toBe('7');
  save.mockRejectedValueOnce(Error('lost response'));
  fireEvent.change(select, { target: { value: '9' } });
  expect(await screen.findByRole('alert')).toHaveProperty(
    'textContent',
    'Couldn’t confirm this priority. Refresh to check its status.',
  );
  expect(select.value).toBe('7');
  expect(select.getAttribute('aria-describedby')).toBe(screen.getByRole('alert').id);
  save.mockResolvedValueOnce(undefined);
  fireEvent.change(select, { target: { value: '10' } });
  await waitFor(() => expect(select.value).toBe('10'));
  expect(screen.queryByRole('alert')).toBeNull();
});

it('does not carry a pending save or an old failure into a different item', async () => {
  let reject!: (error: Error) => void;
  const save = () =>
    new Promise<void>((_, fail) => {
      reject = fail;
    });
  const { rerender } = render(<TodoPrioritySelect key="first" priority={7} onChange={save} />);
  fireEvent.change(screen.getByRole('combobox'), { target: { value: '8' } });
  rerender(<TodoPrioritySelect key="second" priority={2} onChange={vi.fn()} />);
  await act(async () => reject(Error('old save failed')));
  const select = screen.getByRole('combobox') as HTMLSelectElement;
  expect(select.value).toBe('2');
  expect(select.disabled).toBe(false);
  expect(screen.queryByRole('alert')).toBeNull();
});
