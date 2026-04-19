import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: vi.fn() },
}));

vi.mock('@capacitor/haptics', () => ({
  Haptics: {
    impact: vi.fn(),
    notification: vi.fn(),
    selectionChanged: vi.fn(),
  },
  ImpactStyle: { Light: 'LIGHT', Medium: 'MEDIUM', Heavy: 'HEAVY' },
  NotificationType: { Success: 'SUCCESS', Warning: 'WARNING', Error: 'ERROR' },
}));

import { Capacitor } from '@capacitor/core';
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';
import {
  impactLight,
  impactMedium,
  notifySuccess,
  notifyWarning,
  selectionChanged,
} from '../haptics';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('haptics', () => {
  it('fires impact on native platform', () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    impactLight();
    expect(Haptics.impact).toHaveBeenCalledWith({ style: ImpactStyle.Light });

    impactMedium();
    expect(Haptics.impact).toHaveBeenCalledWith({ style: ImpactStyle.Medium });
  });

  it('fires notification on native platform', () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    notifySuccess();
    expect(Haptics.notification).toHaveBeenCalledWith({ type: NotificationType.Success });

    notifyWarning();
    expect(Haptics.notification).toHaveBeenCalledWith({ type: NotificationType.Warning });
  });

  it('fires selectionChanged on native platform', () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    selectionChanged();
    expect(Haptics.selectionChanged).toHaveBeenCalled();
  });

  it('no-ops in browser environment', () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
    impactLight();
    impactMedium();
    notifySuccess();
    notifyWarning();
    selectionChanged();
    expect(Haptics.impact).not.toHaveBeenCalled();
    expect(Haptics.notification).not.toHaveBeenCalled();
    expect(Haptics.selectionChanged).not.toHaveBeenCalled();
  });
});
