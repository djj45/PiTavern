import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientMessage, ServerEvent } from "@pitavern/shared";

export interface TavernSocket {
  connected: boolean;
  send: (message: ClientMessage) => boolean;
}

/** Batch text at most every 50ms; flush before other events to preserve stream order. */
export function useTavernSocket(onEvent: (event: ServerEvent) => void): TavernSocket {
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    let closed = false;
    let retryTimer: ReturnType<typeof setTimeout>;
    let frame: ReturnType<typeof setTimeout> | undefined;
    let pending: Extract<ServerEvent, { type: "chat.delta" }> | undefined;
    const flush = () => {
      if (frame !== undefined) clearTimeout(frame);
      frame = undefined;
      if (pending) {
        const event = pending;
        pending = undefined;
        onEventRef.current(event);
      }
    };
    const connect = () => {
      if (closed) return;
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${location.host}/ws`);
      wsRef.current = ws;
      ws.onopen = () => { if (!closed) setConnected(true); };
      ws.onclose = () => {
        if (closed) return;
        flush();
        setConnected(false);
        retryTimer = setTimeout(connect, 2000);
      };
      ws.onmessage = (msg) => {
        if (closed) return;
        let event: ServerEvent;
        try { event = JSON.parse(String(msg.data)) as ServerEvent; }
        catch { return; }
        if (event.type === "chat.delta") {
          if (pending && pending.chatId !== event.chatId) flush();
          pending = pending ? { ...pending, delta: pending.delta + event.delta } : event;
          frame ??= setTimeout(flush, 50);
        } else {
          flush();
          onEventRef.current(event);
        }
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retryTimer);
      if (frame !== undefined) clearTimeout(frame);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, []);

  const send = useCallback((message: ClientMessage): boolean => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return false;
    try {
      wsRef.current.send(JSON.stringify(message));
      return true;
    } catch { return false; }
  }, []);
  return { connected, send };
}
