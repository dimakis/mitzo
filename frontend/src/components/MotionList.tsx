import { Component, createRef, type ReactElement } from 'react';
import { animateMotion } from '../lib/motion';
import { useReducedMotion } from '../hooks/useReducedMotion';

type Props = { children: ReactElement[]; className?: string; scrollSelector?: string };
type Snapshot = {
  positions: Map<string, number>;
  anchor?: { key: string; top: number };
  scroller: HTMLElement | null;
};

/** The pre-mutation snapshot measures keyed DOM rows before React moves them. */
class MovingRows extends Component<Props & { reduced: boolean }, object, Snapshot | null> {
  private root = createRef<HTMLDivElement>();
  private animations = new Set<Animation>();

  private cancel = () => {
    this.animations.forEach((animation) => animation.cancel());
    this.animations.clear();
  };

  getSnapshotBeforeUpdate(previous: Props): Snapshot | null {
    if (
      previous.children.map((child) => child.key).join('\0') ===
      this.props.children.map((child) => child.key).join('\0')
    )
      return null;
    const root = this.root.current;
    if (!root) return null;
    const scroller = root.closest<HTMLElement>(this.props.scrollSelector ?? '.session-list-scroll');
    const snapshot: Snapshot = { positions: new Map(), scroller };
    const viewport = scroller?.getBoundingClientRect();
    for (const child of root.children) {
      const row = child as HTMLElement;
      const key = row.dataset.motionKey;
      if (!key) continue;
      const rect = row.getBoundingClientRect();
      snapshot.positions.set(key, rect.top);
      if (
        !snapshot.anchor &&
        scroller?.scrollTop &&
        viewport &&
        rect.bottom > viewport.top &&
        rect.top < viewport.bottom
      )
        snapshot.anchor = { key, top: rect.top };
    }
    return snapshot;
  }

  componentDidUpdate(_previous: Props, _state: object, snapshot: Snapshot | null) {
    if (this.props.reduced) this.cancel();
    if (!snapshot) return;
    this.cancel();
    const rows = [...(this.root.current?.children ?? [])] as HTMLElement[];
    const anchor = rows.find((row) => row.dataset.motionKey === snapshot.anchor?.key);
    if (anchor && snapshot.scroller && snapshot.anchor)
      snapshot.scroller.scrollTop += anchor.getBoundingClientRect().top - snapshot.anchor.top;
    if (this.props.reduced) return;
    // Read all target positions before starting compositor-only translations.
    const moves = rows.map((row) => ({
      row,
      from: snapshot.positions.get(row.dataset.motionKey!),
      to: row.getBoundingClientRect().top,
    }));
    for (const { row, from, to } of moves) {
      if (from === undefined || Math.abs(from - to) < 0.5) continue;
      const animation = animateMotion(row, 'reorder', true, {
        translate: `0 ${from - to}px`,
        // A rising row stays visible while its siblings slide underneath.
        zIndex: from > to ? '1' : '0',
      });
      if (!animation) continue;
      this.animations.add(animation);
      void animation.finished.then(
        () => this.animations.delete(animation),
        () => this.animations.delete(animation),
      );
    }
  }

  componentWillUnmount() {
    this.cancel();
  }
  render() {
    return (
      <div ref={this.root} className={this.props.className}>
        {this.props.children}
      </div>
    );
  }
}

export function MotionList(props: Props) {
  return <MovingRows {...props} reduced={useReducedMotion()} />;
}
