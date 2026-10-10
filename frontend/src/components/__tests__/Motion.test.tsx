// @vitest-environment jsdom
import { StrictMode, useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MotionRoutes } from '../MotionRoutes';
import { MotionPresence } from '../MotionPresence';
import { CollapsibleSection } from '../CollapsibleSection';
import { WorkspaceControls } from '../WorkspaceControls';
import { useMotionPresence } from '../../hooks/useMotionPresence';

let reduced = false;
const listeners = new Set<() => void>();
const animations: { cancel: ReturnType<typeof vi.fn>; finish: () => void }[] = [];
const animate = vi.fn();

beforeEach(() => {
  reduced = false;
  animations.length = 0;
  animate.mockReset();
  vi.stubGlobal('matchMedia', () => ({
    matches: reduced,
    addEventListener: (_: string, callback: () => void) => listeners.add(callback),
    removeEventListener: (_: string, callback: () => void) => listeners.delete(callback),
  }));
  vi.stubGlobal('getComputedStyle', () => ({
    getPropertyValue: (name: string) => (name.includes('duration') ? '180ms' : 'ease-out'),
  }));
  animate.mockImplementation(() => {
    let finish!: () => void;
    const animation = {
      cancel: vi.fn(),
      finished: new Promise<void>((r) => {
        finish = r;
      }),
    };
    animations.push({ cancel: animation.cancel, finish });
    return animation;
  });
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: animate });
});
afterEach(() => {
  cleanup();
  listeners.clear();
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
});

function Conversation() {
  const [draft, setDraft] = useState('');
  const navigate = useNavigate();
  return (
    <main>
      <input aria-label="Draft" value={draft} onChange={(e) => setDraft(e.target.value)} />
      <Link to="/chat/two">Next</Link>
      <Link to="?panel=details">Query</Link>
      <button onClick={() => navigate(-1)}>Back</button>
    </main>
  );
}
function navigation() {
  return render(
    <StrictMode>
      <MemoryRouter initialEntries={['/chat/one']}>
        <MotionRoutes>
          <Routes>
            <Route path="/chat/:id" element={<Conversation />} />
          </Routes>
        </MotionRoutes>
      </MemoryRouter>
    </StrictMode>,
  );
}

describe('shared navigation motion', () => {
  it('animates navigation without remounting drafts, replaying on renders, or moving fixed controls', () => {
    navigation();
    expect(animate).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Draft'), { target: { value: 'keep this' } });
    fireEvent.click(screen.getByText('Next'));
    expect((screen.getByLabelText('Draft') as HTMLInputElement).value).toBe('keep this');
    expect(animate).toHaveBeenCalledTimes(1);
    expect(animate.mock.calls[0][0]).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    expect(animate.mock.calls[0][1]).toMatchObject({ duration: 180 });
    fireEvent.change(screen.getByLabelText('Draft'), { target: { value: 'stream update' } });
    fireEvent.click(screen.getByText('Query'));
    expect(animate).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('Back'));
    fireEvent.click(screen.getByText('Back'));
    expect(animate).toHaveBeenCalledTimes(2);
    expect(animations[0].cancel).toHaveBeenCalled();
  });

  it('disables navigation motion when Reduce Motion is enabled during an animation', () => {
    navigation();
    fireEvent.click(screen.getByText('Next'));
    act(() => {
      reduced = true;
      listeners.forEach((listener) => listener());
    });
    expect(animations[0].cancel).toHaveBeenCalled();
    fireEvent.click(screen.getByText('Back'));
    expect(animate).toHaveBeenCalledTimes(1);
  });
});

describe('shared presence motion', () => {
  it('cancels an exiting popover when it becomes an inline control', () => {
    function ResponsiveSurface({ open, inline }: { open: boolean; inline: boolean }) {
      const { ref, present } = useMotionPresence(open, 'popover', false, !inline);
      return (
        <div ref={ref} hidden={!inline && !present}>
          Responsive actions
        </div>
      );
    }
    const view = render(<ResponsiveSurface open={false} inline={false} />);
    view.rerender(<ResponsiveSurface open inline={false} />);
    view.rerender(<ResponsiveSurface open={false} inline={false} />);
    const exit = animations.at(-1)!;
    view.rerender(<ResponsiveSurface open={false} inline />);
    expect(exit.cancel).toHaveBeenCalled();
    expect(animate).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Responsive actions').hidden).toBe(false);
    view.rerender(<ResponsiveSurface open={false} inline={false} />);
    expect(screen.getByText('Responsive actions').hidden).toBe(true);
    expect(animate).toHaveBeenCalledTimes(2);
  });
  it('animates existing section toggles and hides closing content from accessibility immediately', async () => {
    render(
      <CollapsibleSection title="Section" storageKey="motion-section">
        <button>Nested action</button>
      </CollapsibleSection>,
    );
    expect(animate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Section' }));
    expect(animate).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Nested action' })).toBeNull();
    expect(screen.getByText('Nested action')).toBeTruthy();
    await act(async () => animations.at(-1)!.finish());
    expect(screen.queryByText('Nested action')).toBeNull();
  });

  it('preserves mounted workspace settings through an animated close', async () => {
    render(
      <WorkspaceControls status="Ready">
        <input aria-label="Setting" />
      </WorkspaceControls>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Workspace controls/ }));
    fireEvent.change(screen.getByLabelText('Setting'), { target: { value: 'saved draft' } });
    fireEvent.click(screen.getByRole('button', { name: /Workspace controls/ }));
    expect(animate).toHaveBeenCalled();
    await act(async () => animations.at(-1)!.finish());
    fireEvent.click(screen.getByRole('button', { name: /Workspace controls/ }));
    expect((screen.getByLabelText('Setting') as HTMLInputElement).value).toBe('saved draft');
  });
  it('keeps exiting surfaces visible but inert, then removes them after the exit completes', async () => {
    const view = render(
      <MotionPresence open>
        <button>Action</button>
      </MotionPresence>,
    );
    view.rerender(
      <MotionPresence open={false}>
        <button>Action</button>
      </MotionPresence>,
    );
    const surface = screen.getByText('Action').parentElement!;
    expect(surface.hasAttribute('inert')).toBe(true);
    expect(surface.getAttribute('aria-hidden')).toBe('true');
    await act(async () => animations.at(-1)!.finish());
    expect(screen.queryByText('Action')).toBeNull();
  });

  it('cancels stale exits on a rapid reopen and does not replay as children update', async () => {
    const view = render(<MotionPresence open>First</MotionPresence>);
    view.rerender(<MotionPresence open={false}>First</MotionPresence>);
    const exit = animations.at(-1)!;
    view.rerender(<MotionPresence open>Second</MotionPresence>);
    expect(exit.cancel).toHaveBeenCalled();
    await act(async () => exit.finish());
    expect(screen.getByText('Second')).toBeTruthy();
    const count = animate.mock.calls.length;
    view.rerender(<MotionPresence open>Streaming update</MotionPresence>);
    expect(animate).toHaveBeenCalledTimes(count);
  });

  it('collapses immediately with Reduce Motion and degrades without Web Animations', () => {
    reduced = true;
    const view = render(<MotionPresence open>Content</MotionPresence>);
    view.rerender(<MotionPresence open={false}>Content</MotionPresence>);
    expect(screen.queryByText('Content')).toBeNull();
    expect(animate).not.toHaveBeenCalled();
    reduced = false;
    delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
    view.rerender(<MotionPresence open>Content</MotionPresence>);
    view.rerender(<MotionPresence open={false}>Content</MotionPresence>);
    expect(screen.queryByText('Content')).toBeNull();
  });

  it('cancels animations when a surface unmounts', () => {
    const view = render(<MotionPresence open>Content</MotionPresence>);
    view.unmount();
    expect(animations[0].cancel).toHaveBeenCalled();
  });
});
