import { useEffect, useState } from 'react';

const KEYBOARD_QUERY = '(any-hover: hover) and (any-pointer: fine)';
const DESKTOP_VIM_KEY = 'mitzo-document-editor-vim:keyboard';
const TOUCH_VIM_KEY = 'mitzo-document-editor-vim:touch';
const RELATIVE_KEY = 'mitzo-document-editor-relative-lines';

function read(key: string) {
  try {
    return localStorage.getItem(key) === 'true';
  } catch {
    return false;
  }
}
function write(key: string, value: boolean) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // Preferences are optional; editing remains available without storage.
  }
}

export function useDocumentEditorPreferences() {
  const [keyboard, setKeyboard] = useState(
    () => typeof window.matchMedia === 'function' && window.matchMedia(KEYBOARD_QUERY).matches,
  );
  const [desktopVim, setDesktopVim] = useState(() => read(DESKTOP_VIM_KEY));
  const [touchVim, setTouchVim] = useState(() => read(TOUCH_VIM_KEY));
  const [relativeLineNumbers, setRelative] = useState(() => read(RELATIVE_KEY));

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(KEYBOARD_QUERY);
    const update = (event: MediaQueryListEvent) => setKeyboard(event.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  return {
    keyboard,
    vim: keyboard ? desktopVim : touchVim,
    setVim(value: boolean) {
      if (keyboard) setDesktopVim(value);
      else setTouchVim(value);
      write(keyboard ? DESKTOP_VIM_KEY : TOUCH_VIM_KEY, value);
    },
    relativeLineNumbers,
    setRelativeLineNumbers(value: boolean) {
      setRelative(value);
      write(RELATIVE_KEY, value);
    },
  };
}
