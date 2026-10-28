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
      if (!message || typeof message !== "object") return;
      if ("chatId" in message && typeof message.chatId !== "string") return;
      switch (message.type) {
        case "ping":
          ws.send(JSON.stringify({ type: "pong" }));
          break;
        case "chat.send":
          if (typeof message.text === "string" && message.text.trim() && message.text.length <= 1_000_000) void sessions.send(message.chatId, message.text);
          else ws.send(JSON.stringify({ type: "chat.error", chatId: message.chatId, message: "消息不能为空且不能超过 100 万字符" }));
          break;
        case "chat.regenerate":
          if (typeof message.messageId === "string" && typeof message.expectedText === "string") {
            void sessions.regenerate(message.chatId, message.messageId, message.expectedText);
          } else ws.send(JSON.stringify({ type: "chat.error", chatId: message.chatId, message: "重生成参数无效" }));
          break;
        case "chat.abort":
          sessions.abort(message.chatId);
          break;
        case "chat.sync": {
          // 快照和后续增量使用同一连接，保证客户端按服务器顺序应用。
          try {
            const snapshot = sessions.snapshot(message.chatId);
            ws.send(JSON.stringify(snapshot
              ? { type: "chat.snapshot", chatId: message.chatId, snapshot }
              : { type: "chat.error", chatId: message.chatId, message: "聊天不存在" }));
          } catch (error) {
            ws.send(JSON.stringify({ type: "chat.error", chatId: message.chatId, message: error instanceof Error ? error.message : String(error) }));
          }
          break;
        }
      }
    });

    ws.on("close", unsubscribe);
  });
}
