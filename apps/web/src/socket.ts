import { useEffect, useRef, useState } from "react";
import type { ClientMessage, ServerEvent } from "@pitavern/shared";

export interface TavernSocket {
  connected: boolean;
  send: (message: ClientMessage) => void;
}

/** WS 连接：断线 2 秒自动重连；onEvent 始终指向最新渲染的回调 */
export function useTavernSocket(onEvent: (event: ServerEvent) => void): TavernSocket {
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    let closed = false;
    let retryTimer: ReturnType<typeof setTimeout>;

    const connect = () => {
      if (closed) return;
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${location.host}/ws`);
      wsRef.current = ws;
      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        if (!closed) retryTimer = setTimeout(connect, 2000);
      };
      ws.onmessage = (msg) => {
        try {
          onEventRef.current(JSON.parse(String(msg.data)) as ServerEvent);
        } catch {
          // 忽略无法解析的帧
        }
      };
    };

    connect();
    return () => {
      closed = true;
      clearTimeout(retryTimer);
      wsRef.current?.close();
    };
  }, []);

  return {
    connected,
    send: (message) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify(message));
    },
  };
}
