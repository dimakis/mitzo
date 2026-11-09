import { useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  defaultPanelWidths,
  desktopPanels,
  dividerWidth,
  fitDesktopPanels,
  minimumCenterWidth,
  panelLimits,
  type DesktopPanel,
  type PanelModes,
  type PanelWidths,
} from '../lib/desktop-panel-layout';
import { useLayoutPreference } from './useLayoutPreference';

function decodeWidths(raw: string): PanelWidths {
  const value = JSON.parse(raw);
  if (
    !value ||
    !desktopPanels.every(
      (panel) => typeof value[panel] === 'number' && Number.isFinite(value[panel]),
    )
  )
    throw new Error('InvalidLayoutPreference');
  return value;
}
export function useDesktopPanelLayout(modes: PanelModes) {
  const container = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState(() => window.innerWidth);
  const [preferred, save, unavailable] = useLayoutPreference(
    'mitzo-desktop-panel-widths',
    defaultPanelWidths,
    decodeWidths,
  );
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const measure = () => setAvailable(element.getBoundingClientRect().width || window.innerWidth);
    measure();
    const observer =
      typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(element);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);
  const widths = fitDesktopPanels(preferred, modes, available);
  const used = desktopPanels.reduce(
    (total, panel) => total + widths[panel] + (modes[panel] === 'expanded' ? dividerWidth : 0),
    0,
  );
  function maximum(panel: DesktopPanel) {
    return Math.max(
      panelLimits[panel].min,
      Math.min(
        panelLimits[panel].max,
        widths[panel] + available - used - minimumCenterWidth(available),
      ),
    );
  }
  function resize(panel: DesktopPanel, value: number) {
    const next = { ...preferred };
    for (const key of desktopPanels) if (modes[key] === 'expanded') next[key] = widths[key];
    next[panel] = Math.max(panelLimits[panel].min, Math.min(maximum(panel), value));
    save(next);
  }
  const style = Object.fromEntries(
    desktopPanels.map((panel) => [`--desktop-${panel}-width`, `${widths[panel]}px`]),
  ) as CSSProperties;
  return { container, widths, style, maximum, resize, unavailable };
}
