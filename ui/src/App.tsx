import { useEffect, useState } from 'react';

import { ClientView } from './client/ClientView.tsx';
import { KiwiMark } from './client/KiwiMark.tsx';
import { buildRequestTemplate } from './lib/requestTemplate.ts';
import type { RequestSpec } from '../../shared/collections.ts';
import type { KeyEntry } from '../../shared/types.ts';
import { RunnerView } from './client/RunnerView.tsx';
import { isTypingTarget } from './client/shortcuts.ts';
import { ShortcutsDialog } from './client/ShortcutsDialog.tsx';
import { VaultView } from './components/VaultView.tsx';
import { loadLocal, saveLocal } from './lib/storage.ts';
import { useTheme, type Theme } from './lib/theme.ts';

type Screen = 'client' | 'runner' | 'vault';

const SCREEN_KEY = 'screen';

/** App shell: the API client is the product, the key vault is a tab of it. */
export default function App() {
  const { theme, cycle } = useTheme();
  /** A request handed over from the vault, waiting for the client to open it. */
  const [pending, setPending] = useState<Partial<RequestSpec> | null>(null);
  const [screen, setScreen] = useState<Screen>(() => {
    const saved = loadLocal(SCREEN_KEY);
    return saved === 'vault' || saved === 'runner' ? saved : 'client';
  });

  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  useEffect(() => {
    saveLocal(SCREEN_KEY, screen);
  }, [screen]);

  // App-wide keys: the shortcut panel and switching screens. e.code, because
  // Shift turns "1" into "!" (and "/" into "?") on e.key.
  useEffect(() => {
    const screens: Record<string, Screen> = { Digit1: 'client', Digit2: 'runner', Digit3: 'vault' };
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && e.shiftKey && screens[e.code]) {
        e.preventDefault();
        setScreen(screens[e.code]!);
        return;
      }
      if ((e.altKey && e.code === 'Slash') || (e.key === '?' && !e.altKey && !isTypingTarget(e.target))) {
        e.preventDefault();
        setShortcutsOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /** Build a provider-shaped request for this key and open it in the client.
   *  Auth points at the vault rather than pasting the secret into a header. */
  const handOver = async (entry: KeyEntry) => {
    const template = await buildRequestTemplate(entry);
    setPending({
      name: `${entry.provider}${entry.label ? ` · ${entry.label}` : ''}`,
      method: template.method,
      url: template.url,
      headers: Object.entries(template.headers)
        .filter(([k]) => k.toLowerCase() !== 'authorization' && !k.toLowerCase().includes('api-key'))
        .map(([key, value]) => ({ key, value, enabled: true })),
      auth: { type: 'vault', keyId: entry.id },
      body: template.body ? { mode: 'json', text: template.body } : { mode: 'none' },
    });
    setScreen('client');
  };

  return (
    <div className="flex h-full flex-col">
      <nav className="flex shrink-0 items-center gap-1 border-b border-slate-200 bg-white px-3 py-1.5 dark:border-slate-800 dark:bg-slate-900">
        <span className="mr-2 flex items-center gap-1.5 text-sm font-bold">
          <KiwiMark className="h-4 w-4" /> Keyway
        </span>
        <ScreenTab active={screen === 'client'} onClick={() => setScreen('client')} icon="fa-bolt">
          API client
        </ScreenTab>
        <ScreenTab active={screen === 'runner'} onClick={() => setScreen('runner')} icon="fa-play">
          Runner
        </ScreenTab>
        <ScreenTab active={screen === 'vault'} onClick={() => setScreen('vault')} icon="fa-key">
          Vault
        </ScreenTab>

        <button
          type="button"
          onClick={() => setShortcutsOpen(true)}
          title="Keyboard shortcuts (?)"
          aria-label="Keyboard shortcuts"
          className="ml-auto flex items-center gap-1.5 rounded px-2 py-1 text-xs text-slate-500 hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 dark:text-slate-400 dark:hover:bg-slate-800"
        >
          <i className="fa-solid fa-keyboard" />
          <span className="hidden sm:inline">Shortcuts</span>
        </button>
        <ThemeToggle theme={theme} onCycle={cycle} />
      </nav>

      <main className="min-h-0 flex-1">
        {screen === 'client' && (
          <ClientView
            pendingRequest={pending}
            onPendingConsumed={() => setPending(null)}
            onShowShortcuts={() => setShortcutsOpen(true)}
          />
        )}
        {screen === 'runner' && <RunnerView />}
        {screen === 'vault' && <VaultView onTryInClient={(entry) => void handOver(entry)} />}
      </main>

      <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
    </div>
  );
}

const THEME_META: Record<Theme, { icon: string; label: string; next: string }> = {
  light: { icon: 'fa-sun', label: 'Light', next: 'dark' },
  dark: { icon: 'fa-moon', label: 'Dark', next: 'system' },
  system: { icon: 'fa-circle-half-stroke', label: 'System', next: 'light' },
};

function ThemeToggle({ theme, onCycle }: { theme: Theme; onCycle: () => void }) {
  const meta = THEME_META[theme];
  return (
    <button
      type="button"
      onClick={onCycle}
      title={`Theme: ${meta.label} — click for ${meta.next}`}
      aria-label={`Theme: ${meta.label}. Switch to ${meta.next}.`}
      className="flex items-center gap-1.5 rounded px-2 py-1 text-xs text-slate-500 hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 dark:text-slate-400 dark:hover:bg-slate-800"
    >
      <i className={`fa-solid ${meta.icon}`} />
      <span className="hidden sm:inline">{meta.label}</span>
    </button>
  );
}

function ScreenTab({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={`rounded px-3 py-1 text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 ${
        active
          ? 'bg-indigo-600 text-white'
          : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'
      }`}
    >
      <i className={`fa-solid ${icon}`} /> {children}
    </button>
  );
}
