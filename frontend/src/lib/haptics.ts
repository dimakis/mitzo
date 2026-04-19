import { Capacitor } from '@capacitor/core';
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';

export function impactLight(): void {
  if (Capacitor.isNativePlatform()) Haptics.impact({ style: ImpactStyle.Light });
}

export function impactMedium(): void {
  if (Capacitor.isNativePlatform()) Haptics.impact({ style: ImpactStyle.Medium });
}

export function notifySuccess(): void {
  if (Capacitor.isNativePlatform()) Haptics.notification({ type: NotificationType.Success });
}

export function notifyWarning(): void {
  if (Capacitor.isNativePlatform()) Haptics.notification({ type: NotificationType.Warning });
}

export function selectionChanged(): void {
  if (Capacitor.isNativePlatform()) Haptics.selectionChanged();
}
