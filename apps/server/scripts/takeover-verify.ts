/**
 * M5 接管模式确定性验证：npm run verify:takeover
 * 全部使用合成角色卡和世界书，不依赖用户的 data/st 数据。
 */
import assert from "node:assert/strict";
import type { SystemMessage } from "@earendil-works/pi-ai";
import { assembleTakeoverContext } from "../src/context/takeover.ts";
import { createSetStateTool } from "../src/agent/tools/set-state.ts";
import type { ToolContext } from "../src/agent/tools/index.ts";
import { createTavernTools } from "../src/agent/tools/index.ts";
import { normalizeCardBook } from "../src/context/worldinfo.ts";
import { normalizeCard, type StChatLine } from "../src/stdata/types.ts";

const card = normalizeCard("chara_card_v2", {
  name: "测试看板娘",
  description: "{{char}} 是深夜酒馆的看板娘，记得 {{user}}。",
  personality: "对 {{user}} 温柔而敏锐",
  scenario: "所在地点：{{getvar::location}}",
  first_mes: "{{char}} 对 {{user}} 说：今晚只剩二楼东侧一间房，要住吗？",
  character_book: { entries: [
    { id: 0, keys: [], constant: true, insertion_order: 20, content: "[常驻设定] {{char}} 保管着 {{getvar::item}}。" },
    { id: 1, keys: ["旅客"], constant: false, content: "[关键词设定] 旅客来自城北。" },
    { id: 2, keys: [], constant: true, enabled: false, content: "[禁用设定] 不应注入。" },
    { id: 3, keys: [], constant: true, insertion_order: 10, content: "[世界规则] 酒馆在夜晚营业。" },
  ] },
}, "");
const worldEntries = normalizeCardBook(card.characterBook, "合成世界书");
const persona = { name: "测试员", description: "来找 {{char}} 的旅人" };
const metadata = {
  variables: { location: "酒馆大堂", item: "银剑" },
  projection: "测试员在酒馆大堂；银剑已交给掌柜保管。",
};
const options = { recentTurns: 3, stateProjection: true, useProtocol: false };

// 8 轮历史（含第 8 轮本轮用户消息）
const lines: StChatLine[] = [
  { name: card.name, is_user: false, is_system: false, send_date: "", mes: card.firstMes },
];
for (let i = 1; i <= 8; i++) {
  lines.push({ name: persona.name, is_user: true, is_system: false, send_date: "", mes: `第${i}轮用户行动。` });
  lines.push({ name: card.name, is_user: false, is_system: false, send_date: "", mes: `第${i}轮剧情回应。` });
}
lines.pop();
const assemble = (chatLines: StChatLine[], recentTurns = 3) => assembleTakeoverContext({
  card, persona, chatLines, worldEntries, metadata, options: { ...options, recentTurns },
});
const result = assemble(lines);
const system = result.messages[0] as SystemMessage;
assert.equal(system.role, "system");
assert.ok(system.sections);
assert.equal(system.sections.card, "测试看板娘 是深夜酒馆的看板娘，记得 测试员。");
assert.match(system.sections.cardScene ?? "", /对 测试员 温柔而敏锐/);
assert.match(system.sections.cardScene ?? "", /所在地点：酒馆大堂/);
assert.equal(system.sections.worldbook, "[世界规则] 酒馆在夜晚营业。\n[常驻设定] 测试看板娘 保管着 银剑。");
assert.equal(result.stats.constantEntries, 2);
assert.doesNotMatch(system.sections.worldbook, /关键词设定|禁用设定/);
assert.match(system.sections.persona ?? "", /来找 测试看板娘 的旅人/);
assert.match(system.sections.projection ?? "", /银剑已交给掌柜/);
assert.match(system.sections.projection ?? "", /取代更早的快照/);
assert.ok(typeof system.content === "string");
assert.match(system.content, /上下文规则（接管模式）/);
assert.match(system.content, /tavern_set_state/);
assert.ok(!("protocol" in system.sections));
console.log("✓ 合成卡 sections、常驻排序与过滤、角色/用户/变量宏替换、状态投影回注");

assert.equal(result.stats.historyMessages, 5, "第 6/7 轮全文 + 第 8 轮用户消息");
assert.equal(result.stats.droppedMessages, 11, "窗口外的开场白及前 5 轮应丢弃");
assert.match(JSON.stringify(result.messages.slice(1)), /第6轮用户行动/);
assert.match(JSON.stringify(result.messages.slice(1)), /第8轮用户行动/);
assert.doesNotMatch(JSON.stringify(result.messages.slice(1)), /第1轮|第5轮|二楼东侧/);

for (const [turn, keep, includesGreeting] of [[1, 3, true], [3, 3, true], [4, 3, false], [1, 1, true], [2, 1, false]] as const) {
  const early = assemble(lines.slice(0, turn * 2), keep);
  assert.equal(JSON.stringify(early.messages).includes("二楼东侧一间房"), includesGreeting, `第 ${turn} 轮、保留 ${keep} 轮时的开场白窗口`);
}
const first = assemble(lines.slice(0, 2));
assert.match(JSON.stringify(first.messages), /测试看板娘 对 测试员 说/);
assert.equal(first.stats.historyMessages, 2);
assert.equal(assemble(lines.slice(1, 2)).stats.historyMessages, 1, "无开场白时仍保留首条用户消息");
assert.equal(lines[0].mes, card.firstMes, "历史宏替换不能修改存档原文");
assert.match(card.description, /\{\{char\}\}/, "不能修改原角色卡");
assert.match(worldEntries[0].content, /\{\{getvar::item\}\}/, "不能修改原世界书");
console.log("✓ 近 N 轮历史、首轮开场白及窗口边界、宏替换保持存档原文");

const withProtocol = assembleTakeoverContext({
  card, persona, chatLines: lines, worldEntries,
  metadata: {}, options: { ...options, useProtocol: true },
});
assert.ok((withProtocol.messages[0] as SystemMessage).sections?.protocol);
assert.ok(!(withProtocol.messages[0] as SystemMessage).sections?.projection);
console.log("✓ 协议 section 与空投影处理");

const captured: string[] = [];
const ctx: ToolContext = {
  chatId: "t", lines, worldEntries, variables: {}, skillsDir: "", substitute: (s) => s,
  enforcement: { turn: 1, usedThisTurn: 0, cooldownUntilTurn: 0 }, maxRecallsPerTurn: 6, recallCooldownTurns: 10,
  setState: (p) => captured.push(p),
};
const setState = createSetStateTool(ctx) as { execute: (id: string, p: { state: string }) => Promise<{ isError?: boolean }> };
const ok = await setState.execute("t", { state: "测试员在酒馆大堂，夜深。" });
assert.ok(!ok.isError && captured.length === 1 && captured[0].includes("酒馆大堂"));
assert.ok((await setState.execute("t", { state: "   " })).isError);
const disabled = await (createSetStateTool({ ...ctx, setState: undefined }) as typeof setState).execute("t", { state: "x" });
assert.ok(disabled.isError);
assert.equal(createTavernTools(ctx).length, 4);
console.log("✓ tavern_set_state（写入回调 / 空拒绝 / 未启用报错）");
console.log("\n=== M5 接管模式验证全部通过 ===");
