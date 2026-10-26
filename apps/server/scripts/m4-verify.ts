/**
 * M4 确定性验证（不经 LLM）：输出协议还原 + 流式宽松提取 + 历史压缩。npm run verify:m4
 */
import assert from "node:assert";
import {
  consumeProtocolCalls,
  extractStreamingContentDelta,
  extractSummary,
  createProtocolTools,
  GAME_TOOL_NAME,
} from "../src/agent/protocol/game-content.ts";
import { compressHistory } from "../src/context/compression.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";

// ---- 1. consumeProtocolCalls：工具参数 → 正文/思考
{
  const consumed = consumeProtocolCalls([
    { name: "tavern_think", arguments: { thinking: "先查设定" } },
    { name: GAME_TOOL_NAME, arguments: { content: "（正文）她抬起头。\n<summary>她抬头</summary>" } },
  ]);
  assert.ok(consumed);
  assert.equal(consumed.content, "（正文）她抬起头。\n<summary>她抬头</summary>");
  assert.equal(consumed.thinking, "先查设定");
  assert.equal(extractSummary(consumed.content), "她抬头");

  // argumentsError 宽松回退
  const loose = consumeProtocolCalls([
    { name: GAME_TOOL_NAME, arguments: {}, argumentsRaw: '{"content":"宽松正文"}' },
  ]);
  assert.equal(loose?.content, "宽松正文");
  console.log("✓ consumeProtocolCalls（对象参数 + 坏 JSON 宽松回退 + summary 提取）");
}

// ---- 2. 流式宽松提取：部分 JSON 增量
{
  const steps = ['{"con', 'tent":"第一', '段\\n内', '容","x":1}'];
  let raw = "";
  let visible = "";
  for (const step of steps) {
    raw += step;
    visible = extractStreamingContentDelta(raw);
  }
  assert.equal(visible, "第一段\n内容", "应还原转义并提取到闭合引号前");
  assert.equal(extractStreamingContentDelta('{"thinking":"..."}'), "", "非 content 字段应返回空");
  console.log("✓ extractStreamingContentDelta（partial JSON 增量 + 转义还原）");
}

// ---- 3. 协议工具 terminate 语义
{
  const tools = createProtocolTools();
  const game = tools.find((t) => t.name === GAME_TOOL_NAME)!;
  const think = tools.find((t) => t.name === "tavern_think")!;
  const gameResult = await game.execute("t", { content: "正文" });
  const thinkResult = await think.execute("t", { thinking: "思考" });
  assert.equal(gameResult.terminate, true, "game_content 应 terminate（正文即终点）");
  assert.equal(thinkResult.terminate, false, "tavern_think 不 terminate（后面还有正文）");
  console.log("✓ 协议工具 terminate 语义");
}

// ---- 4. 历史压缩
{
  const mk = (role: "user" | "assistant", text: string): Message =>
    role === "user"
      ? { role, content: text, timestamp: Date.now() }
      : {
          role,
          content: [{ type: "text", text }],
          api: "openai-completions",
          provider: "pitavern",
          model: "imported",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop",
          timestamp: Date.now(),
        };

  const system: Message = { role: "system", content: "系统提示", timestamp: Date.now() };
  const history: Message[] = [];
  for (let i = 1; i <= 12; i++) {
    history.push(mk("user", `第${i}轮用户消息。${"长".repeat(200)}`));
    history.push(
      mk(
        "assistant",
        i <= 8
          ? `第${i}轮剧情正文。${"很长".repeat(150)}\n<summary>第${i}轮：发生了事${i}。</summary>`
          : `第${i}轮剧情正文。${"很长".repeat(150)}`,
      ),
    );
  }
  const messages = [system, ...history] as AgentMessage[];

  // 预算内：不压缩
  const idle = compressHistory(messages, { enabled: true, keepFullTurns: 6 }, 10_000_000);
  assert.ok(!idle.stats.triggered);
  assert.equal(idle.messages.length, messages.length);

  // 超预算：旧轮折叠（keep 6 轮 = 12 条尾部；前 12 条压缩）
  const squashed = compressHistory(messages, { enabled: true, keepFullTurns: 6 }, 5_000);
  assert.ok(squashed.stats.triggered);
  assert.equal(squashed.stats.squashedMessages, 12);
  assert.ok(squashed.stats.compressedChars < squashed.stats.originalChars, "总量应下降");
  const squashMsg = squashed.messages.find(
    (m) => (m as { role: string }).role === "assistant" && JSON.stringify((m as { content: unknown }).content).includes("已压缩"),
  ) as Message;
  const squashText = typeof squashMsg.content === "string" ? squashMsg.content : JSON.stringify(squashMsg.content);
  const oldOriginalChars = history.slice(0, 12).reduce((sum, m) => sum + (typeof m.content === "string" ? m.content.length : JSON.stringify(m.content).length), 0);
  assert.ok(squashText.length < oldOriginalChars * 0.5, `压缩块（${squashText.length}）应小于被压缩原文（${oldOriginalChars}）的一半`);
  assert.ok(squashText.includes("|用户|") && squashText.includes("|游戏剧情|"), "轮次标记");
  assert.ok(squashText.includes("第1轮：发生了事1"), "旧轮摘要保留");
  assert.ok(squashText.includes("<|sep|>"), "分隔符");
  // 尾部全文保留
  const tailTexts = squashed.messages.slice(-2).map((m) => {
    const c = (m as Message).content;
    return typeof c === "string" ? c : "";
  });
  assert.ok(tailTexts.some((t) => t.includes("第12轮")), "尾部轮保留全文");

  console.log(
    `✓ 历史压缩（${squashed.stats.originalChars} → ${squashed.stats.compressedChars} 字，旧轮 12 条折叠，summary 优先保留）`,
  );
}

console.log("\n=== M4 输出协议 + 历史压缩验证全部通过 ===");
