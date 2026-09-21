// Light / dark / follow-the-system.
//
// Tailwind is configured with darkMode: 'class', so the whole job is putting
// (or not putting) `dark` on <html>. `color-scheme` goes with it: without it
// the browser still paints native things - dropdown popups, scrollbars, date
// pickers - in light colours on a dark page.

import { useCallback, useEffect, useState } from 'react';

import { loadLocal, saveLocal } from './storage.ts';

export type Theme = 'light' | 'dark' | 'system';

const KEY = 'theme';

function systemPrefersDark(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

function apply(theme: Theme): void {
  const dark = theme === 'dark' || (theme === 'system' && systemPrefersDark());
  const root = document.documentElement;
  root.classList.toggle('dark', dark);
  root.style.colorScheme = dark ? 'dark' : 'light';
}

/** Applied before React renders, so there is no flash of the wrong theme. */
export function initTheme(): void {
  apply(readTheme());
}

export function readTheme(): Theme {
  const saved = loadLocal(KEY);
  return saved === 'dark' || saved === 'light' ? saved : 'system';
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(readTheme);

  useEffect(() => {
    apply(theme);
    saveLocal(KEY, theme);
  }, [theme]);

  // Only follow the OS while the user has asked us to.
  useEffect(() => {
    if (theme !== 'system') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => apply('system');
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [theme]);

  const cycle = useCallback(() => {
    setThemeState((t) => (t === 'light' ? 'dark' : t === 'dark' ? 'system' : 'light'));
  }, []);

  return { theme, setTheme: setThemeState, cycle };
}
