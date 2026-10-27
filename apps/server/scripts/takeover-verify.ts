/**
 * M5 接管模式确定性验证：npm run verify:takeover
 * sections 结构 / 常驻注入与关键词条目排除 / 历史截断 / 状态投影回注 / set_state 工具。
 */
import assert from "node:assert";
import path from "node:path";
import { assembleTakeoverContext } from "../src/context/takeover.ts";
import { createSetStateTool } from "../src/agent/tools/set-state.ts";
import type { ToolContext } from "../src/agent/tools/index.ts";
import { createTavernTools } from "../src/agent/tools/index.ts";
import { CharacterStore } from "../src/stdata/characters.ts";
import { normalizeCardBook } from "../src/context/worldinfo.ts";
import type { StChatLine } from "../src/stdata/types.ts";

const ST_DATA = path.resolve(import.meta.dirname, "../../../data/st");
const realCard = new CharacterStore(path.join(ST_DATA, "characters")).getCharacter("封神演义--异闻录版")!;
const worldEntries = normalizeCardBook(realCard.characterBook, "卡内书");
// 封神卡 description 为空，组装断言用合成卡（世界书仍用真实的 111 条卡内书）
const card: typeof realCard = {
  ...realCard,
  name: "测试看板娘",
  description: "她是深夜酒馆的看板娘，记得每一位客人。".repeat(5),
  personality: "温柔而敏锐",
  scenario: "深夜的酒馆",
};

// 8 轮历史（含第 8 轮本轮用户消息）
const lines: StChatLine[] = [
  { name: card.name, is_user: false, is_system: false, send_date: "", mes: "（酒馆开门）" },
];
for (let i = 1; i <= 8; i++) {
  lines.push({ name: "测试员", is_user: true, is_system: false, send_date: "", mes: `第${i}轮用户行动。` });
  lines.push({ name: card.name, is_user: false, is_system: false, send_date: "", mes: `第${i}轮剧情回应。` });
}
lines.pop(); // 第 8 轮还没有剧情回应（正在生成），末条是本轮用户消息
assert.equal(lines[lines.length - 1].mes, "第8轮用户行动。");

// ---- 1. 组装：sections + 常驻注入 + 关键词排除 + 历史截断 + 投影回注
const result = assembleTakeoverContext({
  card,
  persona: { name: "测试员", description: "路过的旅人" },
  chatLines: lines,
  worldEntries,
  metadata: { projection: "测试员在酒馆大堂；陆压道人在邻桌饮酒；银剑已交给掌柜保管。" },
  options: { recentTurns: 3, stateProjection: true, useProtocol: false },
});

const system = result.messages[0] as { role: string; content: string; sections?: Record<string, string> };
assert.equal(system.role, "system");
assert.ok(system.sections, "应使用 named sections");
assert.ok(system.sections!.card?.includes("深夜酒馆的看板娘"), "人物卡进 card section");
assert.ok(system.sections!.worldbook, "常驻世界书 section 应存在");
assert.ok(system.sections!.worldbook!.includes("[World_Law"), "常驻条目应注入");
assert.ok(!system.sections!.worldbook!.includes('Character("陆压道人")'), "关键词条目不得注入（靠工具检索）");
assert.ok(system.sections!.persona?.includes("路过的旅人"));
assert.ok(system.sections!.projection?.includes("银剑已交给掌柜"), "投影应回注");
assert.ok(system.sections!.projection!.includes("取代更早的快照"), "投影应声明新快照语义");
assert.ok(system.content.includes("上下文规则（接管模式）"), "接管指引应在 content");
assert.ok(system.content.includes("tavern_set_state"), "应指引状态投影更新");
assert.ok(!("protocol" in system.sections!), "未开协议不应有 protocol section");
console.log(`✓ sections 组装（${result.stats.systemSections.join("/")}；常驻 ${result.stats.constantEntries} 条，关键词 0 注入）`);

// 历史截断：8 轮保留最近 3 轮（6/7/8），第 8 轮只有用户消息 → 5 条
assert.equal(result.stats.historyMessages, 5, "第6轮×2 + 第7轮×2 + 第8轮用户 = 5 条");
assert.equal(result.stats.droppedMessages, 10, "开场白后的前 5 轮(10 条)应被丢弃");
const historyText = result.messages.slice(1).map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
assert.ok(historyText.includes("第6轮用户行动") && historyText.includes("第8轮用户行动"), "近 3 轮保留");
assert.ok(!historyText.includes("第1轮用户行动") && !historyText.includes("第5轮用户行动"), "更早轮不进上下文");
console.log("✓ 历史截断（近 3 轮保留，早期 10 条丢弃——召回制上下文）");

// 协议 section
const withProtocol = assembleTakeoverContext({
  card, persona: { name: "测试员", description: "" }, chatLines: lines, worldEntries,
  metadata: {}, options: { recentTurns: 3, stateProjection: true, useProtocol: true },
});
assert.ok((withProtocol.messages[0] as { sections?: Record<string, string> }).sections?.protocol, "协议应进独立 section");
// 无投影时不建 projection section
assert.ok(!(withProtocol.messages[0] as { sections?: Record<string, string> }).sections?.projection, "无投影数据不建 section");
console.log("✓ 协议 section 与空投影处理");

// ---- 2. tavern_set_state 工具
const captured: string[] = [];
const ctx: ToolContext = {
  chatId: "t", lines, worldEntries, variables: {}, skillsDir: "/tmp", substitute: (s) => s,
  enforcement: { turn: 1, usedThisTurn: 0, cooldownUntilTurn: 0 }, maxRecallsPerTurn: 6, recallCooldownTurns: 10,
  setState: (p) => captured.push(p),
};
const setState = createSetStateTool(ctx) as { execute: (id: string, p: { state: string }) => Promise<{ details: { summary?: string }; isError?: boolean }> };
const ok = await setState.execute("t", { state: "测试员在酒馆大堂，夜深。" });
assert.ok(!ok.isError && captured.length === 1 && captured[0].includes("酒馆大堂"));
const empty = await setState.execute("t", { state: "   " });
assert.ok(empty.isError, "空状态应被拒绝");
const noStateCtx = { ...ctx, setState: undefined };
const disabled = await (createSetStateTool(noStateCtx) as typeof setState).execute("t", { state: "x" });
assert.ok(disabled.isError, "未启用投影时应报错");
// 四件套不受影响
assert.equal(createTavernTools(ctx).length, 4, "四件套保持 4 个（set_state 按模式追加）");
console.log("✓ tavern_set_state（写入回调 / 空拒绝 / 未启用报错）");

console.log("\n=== M5 接管模式验证全部通过 ===");
