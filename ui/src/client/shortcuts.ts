// Every keyboard shortcut in one list, so the help panel and the command
// palette hints can't drift from each other. The handlers themselves live
// where the state is (App for screens, ClientView for tabs and requests).

export interface Shortcut {
  /** Alternatives: each entry is one chord, e.g. [['Ctrl', 'K'], ['Alt', 'K']]. */
  keys: string[][];
  label: string;
  /** Only where it works, when that isn't everywhere. */
  scope?: string;
}

export interface ShortcutGroup {
  title: string;
  icon: string;
  items: Shortcut[];
}

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: 'General',
    icon: 'fa-compass',
    items: [
      { keys: [['?'], ['Alt', '/']], label: 'Show this shortcut panel' },
      { keys: [['Ctrl', 'K'], ['Alt', 'K']], label: 'Command palette: Search requests & history', scope: 'API client' },
      { keys: [['Esc']], label: 'Close dialog / panel' },
    ],
  },
  {
    title: 'Screens',
    icon: 'fa-table-columns',
    items: [
      { keys: [['Alt', 'Shift', '1']], label: 'Go to API client' },
      { keys: [['Alt', 'Shift', '2']], label: 'Go to Runner' },
      { keys: [['Alt', 'Shift', '3']], label: 'Go to Vault' },
    ],
  },
  {
    title: 'Tabs',
    icon: 'fa-window-restore',
    items: [
      { keys: [['Alt', 'T']], label: 'New request tab', scope: 'API client' },
      { keys: [['Alt', 'W']], label: 'Close current tab', scope: 'API client' },
      { keys: [['Alt', 'Shift', 'T']], label: 'Reopen last closed tab', scope: 'API client' },
      { keys: [['Alt', 'D']], label: 'Duplicate current tab', scope: 'API client' },
      { keys: [['Alt', ']']], label: 'Next tab', scope: 'API client' },
      { keys: [['Alt', '[']], label: 'Previous tab', scope: 'API client' },
    ],
  },
  {
    title: 'Request',
    icon: 'fa-paper-plane',
    items: [
      { keys: [['Ctrl', 'Enter']], label: 'Send request', scope: 'API client' },
      { keys: [['Ctrl', 'S']], label: 'Save request', scope: 'API client' },
      { keys: [['Alt', 'L']], label: 'Focus the URL bar', scope: 'API client' },
      { keys: [['Alt', 'C']], label: 'Copy request as cURL', scope: 'API client' },
      { keys: [['Alt', 'Shift', 'F']], label: 'Format JSON body', scope: 'API client' },
    ],
  },
  {
    title: 'Import & export',
    icon: 'fa-right-left',
    items: [
      { keys: [['Alt', 'I']], label: 'Import cURL', scope: 'API client' },
      { keys: [['Alt', 'Shift', 'I']], label: 'Import collection (Postman · Insomnia · OpenAPI)', scope: 'API client' },
      { keys: [['Alt', 'Shift', 'E']], label: 'Export collection (Postman · .http · JSON)', scope: 'API client' },
    ],
  },
];

/** "Alt+Shift+T" - the short form used in tooltips and palette hints. */
export function chordText(keys: string[]): string {
  return keys.join('+');
}

/** True while the user is typing somewhere, so bare keys like "?" stay text. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}
