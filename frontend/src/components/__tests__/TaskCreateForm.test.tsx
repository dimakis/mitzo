// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { TaskCreateForm } from '../TaskCreateForm';

afterEach(() => {
  cleanup();
});

describe('TaskCreateForm', () => {
  it('renders the form with input and buttons', () => {
    render(<TaskCreateForm onCreate={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByPlaceholderText('Add task...')).toBeTruthy();
    expect(screen.getByText('Add')).toBeTruthy();
    expect(screen.getByText('Cancel')).toBeTruthy();
  });

  it('submit calls onCreate with title', async () => {
    const onCreate = vi.fn();
    render(<TaskCreateForm onCreate={onCreate} onCancel={vi.fn()} />);

    const input = screen.getByPlaceholderText('Add task...');
    fireEvent.change(input, { target: { value: 'New task' } });
    fireEvent.submit(input.closest('form')!);

    expect(onCreate).toHaveBeenCalledWith('New task', undefined);
  });

  it('submit is disabled when input is empty', () => {
    render(<TaskCreateForm onCreate={vi.fn()} onCancel={vi.fn()} />);
    const addBtn = screen.getByText('Add') as HTMLButtonElement;
    expect(addBtn.disabled).toBe(true);
  });

  it('escape calls onCancel', () => {
    const onCancel = vi.fn();
    render(<TaskCreateForm onCreate={vi.fn()} onCancel={onCancel} />);

    const input = screen.getByPlaceholderText('Add task...');
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(onCancel).toHaveBeenCalled();
  });

  it('cancel button calls onCancel', () => {
    const onCancel = vi.fn();
    render(<TaskCreateForm onCreate={vi.fn()} onCancel={onCancel} />);

    fireEvent.click(screen.getByText('Cancel'));
    expect(onCancel).toHaveBeenCalled();
  });

  it('shows different placeholder for child task', () => {
    render(<TaskCreateForm parentId="parent-1" onCreate={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByPlaceholderText('Add sub-task...')).toBeTruthy();
  });
});
