// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MicButton } from '../MicButton';

afterEach(() => cleanup());

describe('MicButton', () => {
  it('renders nothing when not available', () => {
    const { container } = render(
      <MicButton
        available={false}
        recording={false}
        transcribing={false}
        micBlocked={false}
        onRecordStart={vi.fn()}
        onRecordStop={vi.fn()}
        onRecordCancel={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders mic button when available', () => {
    render(
      <MicButton
        available={true}
        recording={false}
        transcribing={false}
        micBlocked={false}
        onRecordStart={vi.fn()}
        onRecordStop={vi.fn()}
        onRecordCancel={vi.fn()}
      />,
    );
    expect(screen.getByTitle('Tap to record')).toBeTruthy();
  });

  it('shows recording state with red styling', () => {
    const { container } = render(
      <MicButton
        available={true}
        recording={true}
        transcribing={false}
        micBlocked={false}
        onRecordStart={vi.fn()}
        onRecordStop={vi.fn()}
        onRecordCancel={vi.fn()}
      />,
    );
    expect(container.querySelector('.mic-btn--recording')).toBeTruthy();
  });

  it('shows correct title for recording state', () => {
    render(
      <MicButton
        available={true}
        recording={true}
        transcribing={false}
        micBlocked={false}
        onRecordStart={vi.fn()}
        onRecordStop={vi.fn()}
        onRecordCancel={vi.fn()}
      />,
    );
    expect(screen.getByTitle('Tap to stop')).toBeTruthy();
  });

  it('shows transcribing state with spinner', () => {
    const { container } = render(
      <MicButton
        available={true}
        recording={false}
        transcribing={true}
        micBlocked={false}
        onRecordStart={vi.fn()}
        onRecordStop={vi.fn()}
        onRecordCancel={vi.fn()}
      />,
    );
    expect(container.querySelector('.mic-btn--transcribing')).toBeTruthy();
  });

  it('shows mic-blocked state', () => {
    render(
      <MicButton
        available={true}
        recording={false}
        transcribing={false}
        micBlocked={true}
        onRecordStart={vi.fn()}
        onRecordStop={vi.fn()}
        onRecordCancel={vi.fn()}
      />,
    );
    expect(screen.getByTitle('Microphone blocked')).toBeTruthy();
  });

  it('calls onRecordStart on click when idle', () => {
    const onStart = vi.fn();
    render(
      <MicButton
        available={true}
        recording={false}
        transcribing={false}
        micBlocked={false}
        onRecordStart={onStart}
        onRecordStop={vi.fn()}
        onRecordCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTitle('Tap to record'));
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it('calls onRecordStop on click when recording', () => {
    const onStop = vi.fn();
    render(
      <MicButton
        available={true}
        recording={true}
        transcribing={false}
        micBlocked={false}
        onRecordStart={vi.fn()}
        onRecordStop={onStop}
        onRecordCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTitle('Tap to stop'));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('does not call onRecordCancel on pointer leave when recording', () => {
    const onCancel = vi.fn();
    render(
      <MicButton
        available={true}
        recording={true}
        transcribing={false}
        micBlocked={false}
        onRecordStart={vi.fn()}
        onRecordStop={vi.fn()}
        onRecordCancel={onCancel}
      />,
    );
    fireEvent.pointerLeave(screen.getByTitle('Tap to stop'));
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('does not start recording on pointerDown alone', () => {
    const onStart = vi.fn();
    render(
      <MicButton
        available={true}
        recording={false}
        transcribing={false}
        micBlocked={false}
        onRecordStart={onStart}
        onRecordStop={vi.fn()}
        onRecordCancel={vi.fn()}
      />,
    );
    fireEvent.pointerDown(screen.getByTitle('Tap to record'));
    expect(onStart).not.toHaveBeenCalled();
  });

  it('is disabled while transcribing', () => {
    const onStart = vi.fn();
    render(
      <MicButton
        available={true}
        recording={false}
        transcribing={true}
        micBlocked={false}
        onRecordStart={onStart}
        onRecordStop={vi.fn()}
        onRecordCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(onStart).not.toHaveBeenCalled();
  });
});
