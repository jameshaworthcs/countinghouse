// Per-browser conveniences: theme and privacy mode (localStorage, guarded).

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

type ThemePref = 'light' | 'dark' | 'system';

function read(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage unavailable
  }
}

interface Prefs {
  theme: ThemePref;
  resolvedTheme: 'light' | 'dark';
  setTheme: (t: ThemePref) => void;
  privacy: boolean;
  togglePrivacy: () => void;
}

const PrefsContext = createContext<Prefs | null>(null);

export function PrefsProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemePref>(() => read('finance.theme', 'system') as ThemePref);
  const [privacy, setPrivacy] = useState(() => read('finance.privacy', 'off') === 'on');
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setSystemDark(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const resolvedTheme = theme === 'system' ? (systemDark ? 'dark' : 'light') : theme;
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', resolvedTheme);
  }, [resolvedTheme]);
  useEffect(() => {
    if (privacy) document.documentElement.setAttribute('data-privacy', 'on');
    else document.documentElement.removeAttribute('data-privacy');
  }, [privacy]);

  const setTheme = useCallback((t: ThemePref) => {
    write('finance.theme', t);
    setThemeState(t);
  }, []);
  const togglePrivacy = useCallback(() => {
    setPrivacy((p) => {
      write('finance.privacy', p ? 'off' : 'on');
      return !p;
    });
  }, []);

  const value = useMemo<Prefs>(() => ({ theme, resolvedTheme, setTheme, privacy, togglePrivacy }), [theme, resolvedTheme, setTheme, privacy, togglePrivacy]);
  return <PrefsContext.Provider value={value}>{children}</PrefsContext.Provider>;
}

export function usePrefs(): Prefs {
  const ctx = useContext(PrefsContext);
  if (!ctx) throw new Error('usePrefs outside PrefsProvider');
  return ctx;
}
