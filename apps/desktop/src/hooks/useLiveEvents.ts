import { useEffect, useState } from "react";
import type { EventDTO } from "../client/api.js";

/** Live event subscription over the daemon WebSocket; reconnects with backoff. */
export function useLiveEvents(onEvent: (e: EventDTO) => void): boolean {
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let retryMs = 1000;
    const connect = () => {
      if (closed) return;
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const wsBase = location.protocol.startsWith("http")
      ? `${proto}://${location.host}`
      : "ws://127.0.0.1:47710";
    ws = new WebSocket(`${wsBase}/ws`);
      ws.onopen = () => {
        setConnected(true);
        retryMs = 1000;
      };
      ws.onmessage = (msg) => {
        try {
          onEvent(JSON.parse(msg.data as string) as EventDTO);
        } catch {
          // ignore malformed frames — they are transport noise, not state
        }
      };
      ws.onclose = () => {
        setConnected(false);
        setTimeout(connect, retryMs);
        retryMs = Math.min(retryMs * 2, 15_000);
      };
      ws.onerror = () => ws?.close();
    };
    connect();
    return () => {
      closed = true;
      ws?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return connected;
}
