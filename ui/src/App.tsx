import { useEffect, useState } from 'react';

import { ClientView } from './client/ClientView.tsx';
import { KiwiMark } from './client/KiwiMark.tsx';
import { RunnerView } from './client/RunnerView.tsx';
import { VaultView } from './components/VaultView.tsx';
import { loadLocal, saveLocal } from './lib/storage.ts';

type Screen = 'client' | 'runner' | 'vault';

const SCREEN_KEY = 'screen';

/** App shell: the API client is the product, the key vault is a tab of it. */
export default function App() {
  const [screen, setScreen] = useState<Screen>(() => {
    const saved = loadLocal(SCREEN_KEY);
    return saved === 'vault' || saved === 'runner' ? saved : 'client';
  });

  useEffect(() => {
    saveLocal(SCREEN_KEY, screen);
  }, [screen]);

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
      </nav>

      <main className="min-h-0 flex-1">
        {screen === 'client' && <ClientView />}
        {screen === 'runner' && <RunnerView />}
        {screen === 'vault' && <VaultView />}
      </main>
    </div>
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
