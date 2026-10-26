import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientMessage, ServerEvent } from "@pitavern/shared";

export interface TavernSocket {
  connected: boolean;
  send: (message: ClientMessage) => boolean;
}

/** 同一动画帧合并连续正文增量；其他事件先冲刷正文，保持事件顺序。 */
export function useTavernSocket(onEvent: (event: ServerEvent) => void): TavernSocket {
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    let closed = false;
    let retryTimer: ReturnType<typeof setTimeout>;
    let frame: number | undefined;
    let pending: Extract<ServerEvent, { type: "chat.delta" }> | undefined;
    const flush = () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
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
          frame ??= requestAnimationFrame(flush);
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
      if (frame !== undefined) cancelAnimationFrame(frame);
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
