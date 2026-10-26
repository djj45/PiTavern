#!/usr/bin/env node
/**
 * 本地 mock 中转：OpenAI Chat Completions 兼容（含 SSE 流式），
 * 用于无真实 API Key 时的端到端联调。
 */
import http from "node:http";

const PORT = Number(process.env.MOCK_PORT ?? 18789);
const REPLY = "（她抬起眼，烛光在眸中晃了晃）今晚的风很吵……你是来找酒，还是来找故事的？";

const server = http.createServer((req, res) => {
  if (req.method !== "POST" || !req.url?.includes("/chat/completions")) {
    res.writeHead(404).end();
    return;
  }
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const payload = JSON.parse(body || "{}");
    console.log(`[mock] model=${payload.model} stream=${payload.stream} messages=${payload.messages?.length ?? 0}`);
    const chars = [...REPLY];
    if (payload.stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      let i = 0;
      const timer = setInterval(() => {
        if (i < chars.length) {
          const chunk = {
            id: "mock-1",
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: { content: chars[i] }, finish_reason: null }],
          };
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          i++;
        } else {
          res.write('data: {"id":"mock-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n');
          res.write("data: [DONE]\n\n");
          res.end();
          clearInterval(timer);
        }
      }, 30);
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: "mock-1",
          object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: REPLY }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: chars.length, total_tokens: 10 + chars.length },
        }),
      );
    }
  });
});

server.listen(PORT, () => console.log(`[mock] OpenAI 兼容 mock 中转已启动 http://127.0.0.1:${PORT}/v1`));
