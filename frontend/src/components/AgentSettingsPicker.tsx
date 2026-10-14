import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useMotionPresence } from '../hooks/useMotionPresence';
import { UiIcon } from './UiIcon';
import './AgentSettingsPicker.css';

export function AgentSettingsPicker({
  summary,
  agent,
  accountModel,
  execution,
  details,
  onDone,
  disabled = false,
  attention = false,
}: {
  summary: {
    agent: string;
    account?: string;
    model?: string;
    thinking?: string;
    location?: 'openshell' | 'local';
  };
  agent: ReactNode;
  accountModel: ReactNode;
  execution: ReactNode;
  details?: ReactNode;
  onDone?: () => void;
  disabled?: boolean;
  attention?: boolean;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(attention);
  useEffect(() => {
    if (attention) setOpen(true);
  }, [attention]);
  const { ref, present } = useMotionPresence(open, 'disclosure', false);
  const dismiss = () => {
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  };
  useLayoutEffect(() => {
    const panel = ref.current;
    const owner = panel?.parentElement;
    if (!open || !panel || !owner) return;
    const composer = owner.closest<HTMLElement>('.chat-input');
    const wrapper = owner.closest<HTMLElement>('.conversation-composer');
    const chat = owner.closest<HTMLElement>('.workspace-chat');
    const observed = new Set<Element>();
    const previousWrapperStyle = wrapper
      ? {
          maxHeight: wrapper.style.maxHeight,
          overflowY: wrapper.style.overflowY,
          flexShrink: wrapper.style.flexShrink,
        }
      : null;
    const pixels = (value: string) => Number.parseFloat(value) || 0;
    const occupied = (element: HTMLElement) => {
      const style = getComputedStyle(element);
      return (
        element.getBoundingClientRect().height +
        pixels(style.marginTop) +
        pixels(style.marginBottom)
      );
    };
    const measure = () => {
      const viewport = window.visualViewport;
      const bottom = viewport ? viewport.offsetTop + viewport.height : window.innerHeight;
      const nav = document.querySelector<HTMLElement>('.mobile-tabs');
      const boundary = Math.min(bottom, nav?.getBoundingClientRect().top || bottom);
      const newConversation = wrapper?.classList.contains('conversation-composer--new');
      const surface = newConversation ? wrapper : (chat ?? wrapper);
      const top = surface?.getBoundingClientRect().top ?? viewport?.offsetTop ?? 0;
      const surfaceBottom = surface?.getBoundingClientRect().bottom || boundary;
      const surfaceStyle = surface ? getComputedStyle(surface) : null;
      let reserved = Math.max(
        0,
        (composer?.getBoundingClientRect().height ?? owner.getBoundingClientRect().height) -
          panel.getBoundingClientRect().height,
      );
      const siblings = new Set<HTMLElement>();
      // Flexible transcript space may shrink; headings, preparation receipts,
      // alerts and other controls retain their measured space.
      if (chat && !newConversation)
        for (const child of chat.children) {
          if (
            child instanceof HTMLElement &&
            child !== wrapper &&
            !child.contains(owner) &&
            !child.classList.contains('chat-messages')
          )
            siblings.add(child);
        }
      if (wrapper)
        for (const child of wrapper.children) {
          if (child instanceof HTMLElement && child !== composer && !child.contains(owner))
            siblings.add(child);
        }
      for (const sibling of siblings) reserved += occupied(sibling);
      const surfaceSpacing = surfaceStyle
        ? pixels(surfaceStyle.paddingTop) +
          pixels(surfaceStyle.paddingBottom) +
          pixels(surfaceStyle.rowGap) * Math.max(0, (surface?.children.length ?? 1) - 1)
        : 0;
      reserved += surfaceSpacing;
      if (wrapper && !newConversation) {
        const outside = [...siblings]
          .filter((sibling) => !wrapper.contains(sibling))
          .reduce((height, sibling) => height + occupied(sibling), 0);
        const wrapperBudget = Math.max(
          0,
          Math.min(boundary, surfaceBottom) - top - outside - surfaceSpacing,
        );
        const chromeHeight = [
          ...panel.querySelectorAll<HTMLElement>('.agent-settings-header, .agent-settings-footer'),
        ].reduce((height, element) => height + occupied(element), 0);
        const control = pixels(getComputedStyle(panel).getPropertyValue('--control-height')) || 44;
        const fallback =
          Math.min(boundary, surfaceBottom) - top - reserved < chromeHeight + control;
        const maxHeight = fallback ? `${wrapperBudget}px` : previousWrapperStyle!.maxHeight;
        const overflowY = fallback ? 'auto' : previousWrapperStyle!.overflowY;
        const flexShrink = fallback ? '1' : previousWrapperStyle!.flexShrink;
        if (wrapper.style.maxHeight !== maxHeight) wrapper.style.maxHeight = maxHeight;
        if (wrapper.style.overflowY !== overflowY) wrapper.style.overflowY = overflowY;
        if (wrapper.style.flexShrink !== flexShrink) wrapper.style.flexShrink = flexShrink;
      }
      const next = new Set<Element>([
        owner,
        ...[composer, wrapper, chat].filter((node): node is HTMLElement => !!node),
        ...siblings,
      ]);
      for (const node of next)
        if (!observed.has(node)) {
          observer?.observe(node);
          observed.add(node);
        }
      for (const node of observed)
        if (!next.has(node)) {
          observer?.unobserve(node);
          observed.delete(node);
        }
      const chrome = [
        ...panel.querySelectorAll<HTMLElement>('.agent-settings-header, .agent-settings-footer'),
      ].reduce((height, element) => height + occupied(element), 0);
      // A preparation card or large-text draft may consume all free space. Keep
      // the dismissal controls and one scrollable control row intact; the
      // surrounding conversation scroll surface then owns the extra height.
      const controlHeight =
        pixels(getComputedStyle(panel).getPropertyValue('--control-height')) || 44;
      const minimum = `${chrome + controlHeight}px`;
      if (panel.style.getPropertyValue('--agent-settings-minimum') !== minimum)
        panel.style.setProperty('--agent-settings-minimum', minimum);
      const available = `${Math.max(chrome + controlHeight, Math.min(boundary, surfaceBottom) - top - reserved)}px`;
      if (panel.style.getPropertyValue('--agent-settings-space') !== available)
        panel.style.setProperty('--agent-settings-space', available);
    };
    let frame: number | undefined;
    const scheduleMeasure = () => {
      if (frame !== undefined) return;
      frame = window.requestAnimationFrame(() => {
        frame = undefined;
        measure();
      });
    };
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(scheduleMeasure);
    const mutations = new MutationObserver(measure);
    mutations.observe(wrapper ?? owner, { childList: true, subtree: true, characterData: true });
    measure();
    window.addEventListener('resize', measure);
    window.visualViewport?.addEventListener('resize', measure);
    window.visualViewport?.addEventListener('scroll', measure);
    return () => {
      if (wrapper && previousWrapperStyle) {
        wrapper.style.maxHeight = previousWrapperStyle.maxHeight;
        wrapper.style.overflowY = previousWrapperStyle.overflowY;
        wrapper.style.flexShrink = previousWrapperStyle.flexShrink;
      }
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      observer?.disconnect();
      mutations.disconnect();
      window.removeEventListener('resize', measure);
      window.visualViewport?.removeEventListener('resize', measure);
      window.visualViewport?.removeEventListener('scroll', measure);
    };
  }, [open, ref]);
  const location =
    summary.location === 'local'
      ? 'Local Mac'
      : summary.location === 'openshell'
        ? 'OpenShell'
        : undefined;
  const thinking = summary.thinking?.replace(
    /^(low|medium|high|xhigh|minimal|max|none)$/i,
    (value) => value.charAt(0).toUpperCase() + value.slice(1),
  );
  return (
    <div className="agent-settings-picker">
      <button
        type="button"
        ref={trigger}
        className="agent-settings-trigger"
        aria-label={[
          'Agent settings',
          summary.agent,
          summary.account,
          summary.model,
          thinking,
          location,
        ]
          .filter(Boolean)
          .join(', ')}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        <UiIcon name="bot" />
        <strong>{summary.agent}</strong>
        <span>
          {[summary.account, summary.model, thinking, location].filter(Boolean).join(' · ')}
        </span>
        <UiIcon name="down" />
      </button>
      <div
        id={id}
        ref={ref}
        role="region"
        aria-label="Agent settings"
        className="agent-settings-panel motion-disclosure"
        hidden={!present}
        inert={!open}
        aria-hidden={!open || undefined}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && open) {
            event.preventDefault();
            event.stopPropagation();
            dismiss();
          }
        }}
      >
        <div className="agent-settings-header">
          <strong>Agent settings</strong>
          <button type="button" aria-label="Close agent settings" onClick={dismiss}>
            <UiIcon name="close" />
          </button>
        </div>
        <div className="agent-settings-body agent-settings-scroll">
          <div className="agent-settings-agent">{agent}</div>
          <div className="agent-settings-account-model">{accountModel}</div>
          {execution}
          {details}
        </div>
        <div className="agent-settings-footer">
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              onDone?.();
              dismiss();
            }}
          >
            Done <UiIcon name="check" />
          </button>
        </div>
      </div>
    </div>
  );
}
