import type { Message } from "@earendil-works/pi-ai";
export const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
export const userMessage = (content: string): Message => ({ role: "user", content, timestamp: 0 });
export const assistantMessage = (content: string): Message => ({ role: "assistant", content: [{ type: "text", text: content }], api: "openai-completions", provider: "fixture", model: "fixture", usage: zeroUsage, stopReason: "stop", timestamp: 0 });
export function longContextFixture(turns: number): { messages: Message[]; facts: string[] } {
  const facts = ["旧井底的铜匣藏着蓝色地图", "莉雅承诺在月圆之夜归还银钥匙", "北塔暗号已经改成白鸦"];
  const messages: Message[] = [{ role: "system", content: "当前权威状态：金钱77，长剑1，地点集市。旧剧情不能修改账本。", timestamp: 0 }];
  for (let turn = 1; turn <= turns; turn++) {
    messages.push(userMessage(`第${turn}轮：观察周围。`));
    const fact = turn === 1 ? `发现线索：${facts[0]}。` : turn === 17 ? `约定：${facts[1]}。` : turn === turns - 20 ? `发现反转：${facts[2]}。` : "";
    messages.push(assistantMessage("风吹过古城，灯光照亮石墙。".repeat(60) + fact));
  }
  messages.push(userMessage("旧井的地图、莉雅归还钥匙的承诺与北塔暗号分别是什么？请确认当前金额与位置。"));
  return { messages, facts };
}
export function toolContextFixture(): Message[] {
  return [userMessage("旧回合查询"), { ...assistantMessage(""), content: [{ type: "toolCall", id: "old-call", name: "lookup", arguments: { query: "地图" } }] } as Message,
    { role: "toolResult", toolCallId: "old-call", toolName: "lookup", content: [{ type: "text", text: "无关记录。".repeat(20000) + "线索：码头钟楼的入口在地下。" }], isError: false, timestamp: 0 },
    assistantMessage("记录了线索。"), userMessage("当前回合查询"),
    { ...assistantMessage(""), content: [{ type: "toolCall", id: "current-call", name: "lookup", arguments: { query: "当前状态" } }] } as Message,
    { role: "toolResult", toolCallId: "current-call", toolName: "lookup", content: [{ type: "text", text: "本轮结果保持完整".repeat(1000) }], isError: false, timestamp: 0 }];
}

/** 12 nested inactive continuations; selecting each alternate exposes only the next level. */
export function deepBranchFixture(depth = 12): { source: string; steps: Array<{ userMessageId: string; selected: number }> } {
  const reply = (mes: string) => ({ name: "向导", is_user: false, is_system: false, send_date: "", mes });
  let continuation: string[] = [];
  for (let level = depth - 1; level >= 0; level--) {
    const active = reply(`路线${level}原选：线索是红雀${level}。`);
    const alternate = reply(`路线${level}反转：线索是白鸦${level}。`);
    const turn = { name: "旅人", is_user: true, is_system: false, send_date: "", mes: `选择路线${level}。`, extra: {
      messageId: `branch-turn-${level}`, _pitavernReplies: { selected: 0, versions: [
        { messages: [active], state: {} }, { messages: [alternate], state: {}, continuation },
      ] },
    } };
    continuation = [JSON.stringify(turn), JSON.stringify(active)];
  }
  return { source: [JSON.stringify({ user_name: "旅人", character_name: "向导", chat_metadata: {} }), ...continuation].join("\n") + "\n",
    steps: Array.from({ length: depth }, (_, level) => ({ userMessageId: `branch-turn-${level}`, selected: 1 })) };
}
