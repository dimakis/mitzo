export const panelLimits = {
  navigation: { min: 144, max: 320, default: 168, collapsed: 60 },
  conversations: { min: 160, max: 520, default: 280, collapsed: 36 },
  resources: { min: 180, max: 640, default: 280, collapsed: 36 },
};
export type DesktopPanel = keyof typeof panelLimits;
export type PanelWidths = Record<DesktopPanel, number>;
export type PanelModes = Record<DesktopPanel, 'expanded' | 'collapsed' | 'absent'>;
export const desktopPanels = Object.keys(panelLimits) as DesktopPanel[];
export const defaultPanelWidths = Object.fromEntries(
  desktopPanels.map((panel) => [panel, panelLimits[panel].default]),
) as PanelWidths;
// Divider geometry is shared with ResizeDivider.css. Keep the center usable at
// the 768px desktop breakpoint without discarding preferences on window resize.
export const dividerWidth = 6;
export const minimumCenterWidth = (width: number) => Math.min(320, width / 3);

export function fitDesktopPanels(
  preferred: PanelWidths,
  modes: PanelModes,
  width: number,
): PanelWidths {
  const widths = { ...preferred };
  let minimum = 0,
    extra = 0,
    dividers = 0;
  for (const panel of desktopPanels) {
    const limits = panelLimits[panel];
    if (modes[panel] !== 'expanded') {
      widths[panel] = modes[panel] === 'collapsed' ? limits.collapsed : 0;
      minimum += widths[panel];
      continue;
    }
    const value = Number.isFinite(preferred[panel]) ? preferred[panel] : limits.default;
    widths[panel] = Math.max(limits.min, Math.min(limits.max, value));
    minimum += limits.min;
    extra += widths[panel] - limits.min;
    dividers += dividerWidth;
  }
  const budget = Math.max(0, width - minimumCenterWidth(width) - dividers - minimum);
  const ratio = extra > 0 ? Math.min(1, budget / extra) : 1;
  for (const panel of desktopPanels)
    if (modes[panel] === 'expanded')
      widths[panel] = panelLimits[panel].min + (widths[panel] - panelLimits[panel].min) * ratio;
  return widths;
}
