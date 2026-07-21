import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyEntry, WSEvent } from '../../../shared/types.ts';
import { api } from './api.ts';

export function useStore() {
  const [keys, setKeys] = useState<KeyEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const [lastFileChange, setLastFileChange] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { keys } = await api.listKeys();
      setKeys(keys);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // initial load + WS subscription
  useEffect(() => {
    refresh();

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/live`);
      wsRef.current = ws;

      ws.onopen = () => setWsConnected(true);
      ws.onclose = () => {
        setWsConnected(false);
        reconnectTimer.current = window.setTimeout(connect, 1500);
      };
      ws.onerror = () => ws.close();
      ws.onmessage = (ev) => {
        let evt: WSEvent;
        try {
          evt = JSON.parse(ev.data);
        } catch {
          return;
        }
        switch (evt.type) {
          case 'store:changed':
            setKeys(evt.keys);
            break;
          case 'file:changed':
            setLastFileChange(new Date().toLocaleTimeString());
            break;
          case 'test:started':
            setKeys((prev) =>
              prev.map((k) =>
                k.id === evt.keyId
                  ? { ...k, status: { ...k.status, state: 'pending' } }
                  : k,
              ),
            );
            break;
          case 'test:done':
            setKeys((prev) =>
              prev.map((k) => (k.id === evt.keyId ? { ...k, status: evt.status } : k)),
            );
            break;
        }
      };
    };
    connect();

    return () => {
      wsRef.current?.close();
      if (reconnectTimer.current) window.clearTimeout(reconnectTimer.current);
    };
  }, [refresh]);

  return { keys, loading, error, refresh, wsConnected, lastFileChange };
}
