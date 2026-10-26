import http from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { ClientMessage } from "@pitavern/shared";
import { PITAVERN_VERSION } from "@pitavern/shared";
import type { SessionManager } from "../session/manager.ts";

/** WS 层：所有客户端共享同一事件总线（单用户本地应用，chatId 由前端过滤） */
export function attachWebSocket(server: http.Server, sessions: SessionManager): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const { pathname } = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (pathname !== "/ws") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  });

  wss.on("connection", (ws: WebSocket) => {
    ws.send(JSON.stringify({ type: "hello", version: PITAVERN_VERSION }));

    const unsubscribe = sessions.onEvent((event) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
    });

    ws.on("message", (data) => {
      let message: ClientMessage;
      try {
        message = JSON.parse(String(data)) as ClientMessage;
      } catch {
        return;
      }
      switch (message.type) {
        case "ping":
          ws.send(JSON.stringify({ type: "pong" }));
          break;
        case "chat.send":
          void sessions.send(message.chatId, message.text);
          break;
        case "chat.abort":
          sessions.abort(message.chatId);
          break;
      }
    });

    ws.on("close", unsubscribe);
  });
}
