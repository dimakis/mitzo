// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SessionTray } from '../SessionTray';
import { MAX_IMAGE_ATTACHMENTS } from '../../lib/constants';

vi.mock('../ContextPanel', () => ({
  ContextPanel: ({
    selected,
    onToggle,
  }: {
    selected: string[];
    onToggle: (name: string) => void;
  }) => <button onClick={() => onToggle('constitution')}>Context: {selected.join(',')}</button>,
}));

vi.mock('../SessionBanner', () => ({
  SessionBanner: () => <div>Native session context</div>,
}));

afterEach(cleanup);

const props = {
  messages: [],
  current: null,
  selectedContextBlocks: ['boot-context'],
  draftImages: [],
  onToggleContextBlock: vi.fn(),
  onAddImages: vi.fn(),
  onRemoveImage: vi.fn(),
};

describe('SessionTray', () => {
  it('starts as a compact top handle and opens without taking layout space', () => {
    render(<SessionTray {...props} />);

    const tray = screen.getByTestId('session-tray');
    const handle = screen.getByRole('button', { name: 'Open session tray' });
    expect(tray.dataset.snap).toBe('peek');
    expect(screen.getByTestId('session-tray-content').getAttribute('aria-hidden')).toBe('true');

    fireEvent.click(handle);
    expect(tray.dataset.snap).toBe('half');
    expect(screen.getByRole('button', { name: 'Close session tray' })).toBeTruthy();
  });

  it('moves through snap points with vertical swipes from the handle', () => {
    render(<SessionTray {...props} />);
    const handle = screen.getByRole('button', { name: 'Open session tray' });

    fireEvent.pointerDown(handle, { clientY: 4, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientY: 100, pointerId: 1 });
    expect(screen.getByTestId('session-tray').dataset.snap).toBe('half');

    fireEvent.pointerDown(handle, { clientY: 100, pointerId: 2 });
    fireEvent.pointerUp(handle, { clientY: 190, pointerId: 2 });
    // Browsers synthesize a click after the pointer gesture; it must not undo the swipe.
    fireEvent.click(handle);
    expect(screen.getByTestId('session-tray').dataset.snap).toBe('full');

    fireEvent.pointerDown(handle, { clientY: 190, pointerId: 3 });
    fireEvent.pointerUp(handle, { clientY: 90, pointerId: 3 });
    expect(screen.getByTestId('session-tray').dataset.snap).toBe('half');
  });

  it('houses native context controls and source attachment actions', () => {
    const onToggle = vi.fn();
    const onAdd = vi.fn();
    render(
      <SessionTray
        {...props}
        bootContext={{} as never}
        onToggleContextBlock={onToggle}
        onAddImages={onAdd}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open session tray' }));

    expect(screen.getByText('Native session context')).toBeTruthy();
    fireEvent.click(screen.getByText('Context: boot-context'));
    expect(onToggle).toHaveBeenCalledWith('constitution');
    fireEvent.click(screen.getByRole('button', { name: 'Add source' }));
    expect(onAdd).toHaveBeenCalledOnce();
  });

  it('disables adding sources when the attachment limit is reached', () => {
    const onAdd = vi.fn();
    render(
      <SessionTray
        {...props}
        draftImages={Array.from({ length: MAX_IMAGE_ATTACHMENTS }, (_, index) => ({
          data: `image-${index}`,
          mediaType: 'image/png',
          preview: `data:image/png;base64,image-${index}`,
        }))}
        onAddImages={onAdd}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open session tray' }));

    const addSource = screen.getByRole('button', { name: 'Add source' }) as HTMLButtonElement;
    expect(addSource.disabled).toBe(true);
    fireEvent.click(addSource);
    expect(onAdd).not.toHaveBeenCalled();
  });

  it('preserves thumbnail DOM identity when a middle image is removed', () => {
    const images = ['one', 'two', 'three'].map((name) => ({
      data: name,
      mediaType: 'image/png',
      preview: `data:image/png;base64,${name}`,
    }));
    const { rerender } = render(<SessionTray {...props} draftImages={images} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open session tray' }));
    const thirdRow = screen.getByRole('button', { name: 'Remove pasted image 3' }).parentElement;

    rerender(<SessionTray {...props} draftImages={[images[0], images[2]]} />);

    expect(screen.getByRole('button', { name: 'Remove pasted image 2' }).parentElement).toBe(
      thirdRow,
    );
  });

  it('renders collected session sources and outputs', () => {
    render(
      <SessionTray
        {...props}
        messages={[
          {
            messageId: 'user-1',
            role: 'user',
            contextBlocks: ['project-spec'],
            blocks: [{ blockId: 'u1', blockType: 'text', content: 'Use this' }],
          },
          {
            messageId: 'assistant-1',
            role: 'assistant',
            blocks: [
              {
                blockId: 'a1',
                blockType: 'tool_use',
                content: 'Preview: http://localhost:3196',
                toolName: 'Write',
                rawInput: { type: 'write', path: '/tmp/report.md' },
              },
            ],
          },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open session tray' }));

    expect(screen.getByText('project-spec')).toBeTruthy();
    expect(screen.getByText('Write')).toBeTruthy();
    expect(screen.getByRole('link', { name: /localhost:3196/ }).getAttribute('href')).toBe(
      'http://localhost:3196',
    );
    expect(screen.getByText('report.md')).toBeTruthy();
  });

  it('closes on Escape', () => {
    render(<SessionTray {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open session tray' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByTestId('session-tray').dataset.snap).toBe('peek');
  });
});
