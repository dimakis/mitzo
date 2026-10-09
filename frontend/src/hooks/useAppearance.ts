import { useCallback, useState } from 'react';

export const ACCENTS = [
  { value: 'lavender', label: 'Lavender' },
  { value: 'teal', label: 'Teal' },
  { value: 'rose', label: 'Rose' },
  { value: 'amber', label: 'Amber' },
  { value: 'blue', label: 'Blue' },
  { value: 'mint', label: 'Mint' },
  { value: 'coral', label: 'Coral' },
  { value: 'plum', label: 'Plum' },
] as const;
export const FONTS = [
  { value: 'system', label: 'System' },
  { value: 'arial', label: 'Arial' },
  { value: 'georgia', label: 'Georgia' },
  { value: 'verdana', label: 'Verdana' },
  { value: 'trebuchet', label: 'Trebuchet MS' },
  { value: 'palatino', label: 'Palatino' },
  { value: 'courier', label: 'Courier New' },
] as const;
type Accent = (typeof ACCENTS)[number]['value'];
type Font = (typeof FONTS)[number]['value'];

function savedAppearance() {
  const accent = localStorage.getItem('mitzo-accent');
  const font = localStorage.getItem('mitzo-font');
  return {
    accent: ACCENTS.find((choice) => choice.value === accent)?.value ?? 'lavender',
    font: FONTS.find((choice) => choice.value === font)?.value ?? 'system',
  };
}
function applyAppearance(accent: Accent, font: Font) {
  document.documentElement.dataset.accent = accent;
  document.documentElement.dataset.font = font;
}
/** Restore before React renders so every route starts with the same preference. */
export function initAppearance() {
  const { accent, font } = savedAppearance();
  applyAppearance(accent, font);
}
export function useAppearance() {
  const [appearance, setAppearance] = useState(savedAppearance);
  const save = useCallback((accent: Accent, font: Font) => {
    localStorage.setItem('mitzo-accent', accent);
    localStorage.setItem('mitzo-font', font);
    applyAppearance(accent, font);
    setAppearance({ accent, font });
  }, []);
  return {
    ...appearance,
    setAccent: (accent: Accent) => save(accent, savedAppearance().font),
    setFont: (font: Font) => save(savedAppearance().accent, font),
    reset: () => save('lavender', 'system'),
  };
}
