import { describe, expect, it } from 'vitest';
import { fitDesktopPanels, panelLimits, type PanelWidths } from '../desktop-panel-layout';

const expanded = {
  navigation: 'expanded',
  conversations: 'expanded',
  resources: 'expanded',
} as const;
const preferred: PanelWidths = { navigation: 220, conversations: 340, resources: 380 };

describe('desktop panel sizing', () => {
  it('keeps preferred widths when the viewport has room', () => {
    expect(fitDesktopPanels(preferred, expanded, 1600)).toEqual(preferred);
  });
  it('fits all panels on narrow desktops while preserving a usable conversation', () => {
    for (const width of [768, 800, 1024]) {
      const fitted = fitDesktopPanels(preferred, expanded, width);
      const total = Object.values(fitted).reduce((sum, value) => sum + value, 0);
      expect(width - total - 18).toBeGreaterThanOrEqual(Math.min(320, width / 3) - 1);
      for (const panel of Object.keys(fitted) as (keyof PanelWidths)[])
        expect(fitted[panel]).toBeGreaterThanOrEqual(panelLimits[panel].min);
    }
    expect(preferred).toEqual({ navigation: 220, conversations: 340, resources: 380 });
  });
  it('reserves only the collapsed bars and omits absent panels', () => {
    expect(
      fitDesktopPanels(
        preferred,
        {
          navigation: 'collapsed',
          conversations: 'absent',
          resources: 'collapsed',
        },
        800,
      ),
    ).toEqual({ navigation: 60, conversations: 0, resources: 36 });
  });
  it('bounds invalid and oversized saved widths', () => {
    const fitted = fitDesktopPanels(
      { navigation: NaN, conversations: -30, resources: 9999 },
      expanded,
      2000,
    );
    expect(fitted.navigation).toBe(panelLimits.navigation.default);
    expect(fitted.conversations).toBe(panelLimits.conversations.min);
    expect(fitted.resources).toBe(panelLimits.resources.max);
  });
});
