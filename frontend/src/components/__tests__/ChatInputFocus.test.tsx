// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatInput } from '../ChatInput';

vi.mock('../SlashPicker', () => ({ SlashPicker: () => null }));
vi.mock('../SessionResourcesDialog', () => ({ SessionResourcesDialog: () => null }));
vi.mock('../MicButton', () => ({ MicButton: () => null }));
vi.mock('../../lib/haptics', () => ({ impactMedium: vi.fn() }));
afterEach(() => {
  cleanup();
  document.querySelector('[data-focus-fixture]')?.remove();
  localStorage.clear();
});

it('preserves a file control already focused when the returning composer mounts', () => {
  const options = document.createElement('button');
  options.dataset.focusFixture = 'true';
  options.textContent = 'File options';
  document.body.append(options);
  options.focus();
  render(<ChatInput onSend={() => false} onStop={() => {}} running={false} />);
  expect(document.activeElement).toBe(options);
});

it('focuses the composer on mount when no control owns focus', () => {
  expect(document.activeElement).toBe(document.body);
  render(<ChatInput onSend={() => false} onStop={() => {}} running={false} />);
  expect(document.activeElement).toBe(screen.getByLabelText('Message Mitzo'));
});
