#!/usr/bin/env node
/**
 * 本地 mock 中转：OpenAI Chat Completions 兼容（含 SSE 流式），
 * 用于无真实 API Key 时的端到端联调。
 */
import fs from "node:fs";
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
    console.log(`[mock] model=${payload.model} stream=${payload.stream} messages=${payload.messages?.length ?? 0} tools=${payload.tools?.length ?? 0}`);
    try {
      fs.writeFileSync("/tmp/mock-last-request.json", JSON.stringify(payload, null, 2));
    } catch {}
    const chars = [...REPLY];

    // 工具循环模拟：game_tool 协议优先（think+game 双调用），
    // 否则 worldbook_search；最后一条是 tool 结果 → 收尾输出正文
    const lastMsg = payload.messages?.[payload.messages.length - 1];
    if (Array.isArray(payload.tools) && payload.tools.length > 0 && lastMsg?.role !== "tool") {
      const toolNames = payload.tools.map((t) => t.function?.name);
      let calls = null;
      if (toolNames.includes("game_content")) {
        calls = [
          { index: 0, id: "call_mock_think", type: "function", function: { name: "tavern_think", arguments: JSON.stringify({ thinking: "用户问了银剑，我调用世界书确认设定。" }) } },
          { index: 1, id: "call_mock_game", type: "function", function: { name: "game_content", arguments: JSON.stringify({ content: "（她抚过剑脊，剑身发出清越的鸣响）这是会认主的家伙。\n<summary>测试员拔出银剑，酒保说明银剑特性。</summary>" }) } },
        ];
        console.log("[mock] → protocol tool_calls tavern_think + game_content");
      } else if (toolNames.includes("worldbook_search") && lastMsg?.role === "user") {
        calls = [{ index: 0, id: "call_mock_1", type: "function", function: { name: "worldbook_search", arguments: JSON.stringify({ query: "银剑", read: true }) } }];
        console.log("[mock] → tool_call worldbook_search(银剑)");
      }
      if (calls) {
        const chunk = {
          id: "mock-2",
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: { role: "assistant", tool_calls: calls }, finish_reason: null }],
        };
        if (payload.stream) {
          res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          res.write('data: {"id":"mock-2","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n');
          res.write("data: [DONE]\n\n");
          res.end();
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            id: "mock-2",
            object: "chat.completion",
            choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: calls.map(({ index, ...rest }) => rest) }, finish_reason: "tool_calls" }],
          }));
        }
        return;
      }
    }

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
