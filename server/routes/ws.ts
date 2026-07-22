// WebSocket hub - minimal pub/sub used by routes/runner to push live updates.
//
// Hono (with @hono/node-server) gives us the raw Node http.Server in the
// "server" export of index.ts; we upgrade there using 'ws'. To avoid an extra
// dependency, we instead use Bun's native WebSocket support when running under
// Bun. This module exposes a transport-agnostic `broadcast()`.

import type { WSEvent } from '../../shared/types.ts';

export type Socket = {
  send(data: string): void;
  close?(): void;
};

const sockets = new Set<Socket>();

export function addSocket(s: Socket): () => void {
  sockets.add(s);
  return () => sockets.delete(s);
}

export function broadcast(evt: WSEvent): void {
  const data = JSON.stringify(evt);
  for (const s of sockets) {
    try {
      s.send(data);
    } catch {
      sockets.delete(s);
    }
  }
}

export function socketCount(): number {
  return sockets.size;
}
