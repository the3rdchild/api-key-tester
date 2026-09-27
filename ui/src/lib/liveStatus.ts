// Whether keyway's /live push socket is up, for the one indicator in the top
// bar. Each screen keeps its own socket (the client, the runner, the vault),
// so this counts the open ones instead of trusting whichever reported last —
// on a screen switch the old socket's close can land after the new one opens.

import { useSyncExternalStore } from 'react';

let open = 0;
const listeners = new Set<() => void>();

function bump(by: number): void {
  const was = open > 0;
  open += by;
  if (was !== open > 0) for (const l of listeners) l();
}

/** Count this socket while it's open. Listeners, so the caller's own
 *  onopen/onclose handlers stay as they are. */
export function trackLive(ws: WebSocket): void {
  let up = false;
  ws.addEventListener('open', () => {
    up = true;
    bump(1);
  });
  ws.addEventListener('close', () => {
    if (up) bump(-1);
    up = false;
  });
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useLiveConnected(): boolean {
  return useSyncExternalStore(subscribe, () => open > 0, () => false);
}
