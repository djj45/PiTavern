/**
 * M3 工具四件套确定性验证（不经 LLM，直接驱动 execute）：npm run verify:tools
 * 重点：召回限次（每轮≤6）与完整正文冷却（10 轮）的运行时强制。
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTavernTools } from "../src/agent/tools/index.ts";
import type { ToolContext } from "../src/agent/tools/context.ts";
import { lineTurns } from "../src/agent/tools/context.ts";
import { CharacterStore } from "../src/stdata/characters.ts";
import { normalizeCardBook } from "../src/context/worldinfo.ts";
import type { StChatLine } from "../src/stdata/types.ts";

const ST_DATA = path.resolve(import.meta.dirname, "../../../data/st");
const card = new CharacterStore(path.join(ST_DATA, "characters")).getCharacter("封神演义--异闻录版")!;
const worldEntries = normalizeCardBook(card.characterBook, "卡内书");

const lines: StChatLine[] = [
  { name: card.name, is_user: false, is_system: false, send_date: "", mes: "（酒馆开门）" }, // turn 0 开场白
  { name: "测试员", is_user: true, is_system: false, send_date: "", mes: "第1轮：听说陆压道人来了。" },
  { name: card.name, is_user: false, is_system: false, send_date: "", mes: "（他放下酒杯）陆压？那可是狠角色。" },
  { name: "测试员", is_user: true, is_system: false, send_date: "", mes: "第2轮：银剑交给你保管。" },
  { name: card.name, is_user: false, is_system: false, send_date: "", mes: "（他接过银剑）放心。" },
  { name: "测试员", is_user: true, is_system: false, send_date: "", mes: "第3轮：今晚讲什么？" },
];

// 轮次标注正确性
{
  const turns = lineTurns(lines);
  assert.deepEqual(turns, [0, 1, 1, 2, 2, 3], "开场白=0，用户消息开新轮，助手随轮");
  console.log("✓ 轮次标注（开场白=0，用户消息开新轮）");
}

// 临时 skills 目录
const skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pitavern-skills-"));
fs.mkdirSync(path.join(skillsDir, "战斗规则", "references"), { recursive: true });
fs.writeFileSync(path.join(skillsDir, "战斗规则", "references", "combat.md"), "# 战斗规则\n先攻决定顺序。");

const ctx: ToolContext = {
  chatId: "test",
  lines,
  worldEntries,
  variables: { 好感度: 35, 金币: 120, 角色: { 名字: "测试员", 状态: { 体力: 8 } } },
  skillsDir,
  substitute: (s) => s,
  enforcement: { turn: 3, usedThisTurn: 0, cooldownUntilTurn: 0 },
  maxRecallsPerTurn: 6,
  recallCooldownTurns: 10,
};
const tools = createTavernTools(ctx);
const byName = (name: string) => {
  const tool = tools.find((t) => t.name === name);
  assert.ok(tool, `工具 ${name} 应存在`);
  return tool!;
};
const call = async (name: string, args: Record<string, unknown>) => {
  const tool = byName(name) as { execute: (id: string, p: unknown) => Promise<{ content: { type: string; text?: string }[]; details: { summary?: string }; isError?: boolean }> };
  return tool.execute("t", args);
};

// ---- 1. worldbook_search
{
  const search = await call("worldbook_search", { query: "陆压 钉头七箭" });
  assert.ok(!search.isError);
  const text = search.content[0].text!;
  assert.ok(text.includes("[WB-"), "应返回带编号的命中");
  assert.ok(search.details.summary?.includes("命中"));
  const ref = /\[WB-(\d+)\]/.exec(text)![1];

  const read = await call("worldbook_search", { refs: [ref] });
  assert.ok(read.content[0].text!.includes('Character("陆压道人")'), "refs 应返回完整正文");

  const direct = await call("worldbook_search", { query: "云中子", read: true });
  assert.ok(direct.details.summary?.includes("读取"));
  assert.ok(direct.content[0].text!.includes('Character("云中子")'), "read=true 应直接返回全文");

  const zero = await call("worldbook_search", { query: "量子波动速读" });
  assert.ok(zero.content[0].text!.includes("零命中不代表设定不存在"));
  console.log(`✓ worldbook_search（片段→refs 全文两级检索；summary="${search.details.summary}"）`);
}

// ---- 2. tavern_recall_history：限次与冷却的运行时强制
{
  // query 模式 ×6 全部放行
  for (let i = 0; i < 6; i++) {
    const r = await call("tavern_recall_history", { query: "银剑" });
    assert.ok(!r.isError, `第 ${i + 1} 次应放行`);
  }
  assert.equal(ctx.enforcement.usedThisTurn, 6);
  // 第 7 次被拒
  const refused = await call("tavern_recall_history", { query: "银剑" });
  assert.ok(refused.isError && refused.content[0].text!.includes("上限"), "第 7 次应被运行时拒绝");
  assert.equal(ctx.enforcement.usedThisTurn, 6, "被拒的调用不消耗配额");

  // 新一轮：配额复位，turn 模式读完整正文 → 触发 10 轮冷却
  ctx.enforcement.turn = 4;
  ctx.enforcement.usedThisTurn = 0;
  const full = await call("tavern_recall_history", { turn: 2, radius: 1 });
  assert.ok(!full.isError);
  assert.ok(full.content[0].text!.includes("银剑交给你保管"), "turn 模式应返回完整正文");
  assert.ok(full.details.summary?.includes("完整正文"));
  assert.equal(ctx.enforcement.cooldownUntilTurn, 4 + 10 + 1, "冷却应到第 15 轮（含当轮）");

  // 冷却期内 query 模式也被拒
  const duringCooldown = await call("tavern_recall_history", { query: "银剑" });
  assert.ok(duringCooldown.isError && duringCooldown.content[0].text!.includes("冷却"), "冷却期内应被拒绝");

  // 冷却结束（turn 15）恢复
  ctx.enforcement.turn = 15;
  const after = await call("tavern_recall_history", { query: "陆压" });
  assert.ok(!after.isError && after.content[0].text!.includes("陆压"));
  console.log("✓ tavern_recall_history（6 次/轮上限；turn 全文召回后 10 轮冷却；均由运行时强制）");
}

// ---- 3. tavern_read_variables
{
  const list = await call("tavern_read_variables", { action: "list" });
  assert.ok(list.content[0].text!.includes("好感度: number"));
  const search = await call("tavern_read_variables", { action: "search", query: "状态" });
  assert.ok(search.content[0].text!.includes("角色.状态.体力"), "search 应命中嵌套路径");
  const read = await call("tavern_read_variables", { action: "read", path: "角色" });
  assert.ok(read.content[0].text!.includes("状态: object"), "对象只返回一层");
  assert.ok(!read.content[0].text!.includes("体力: number"), "不递归展开");
  const missing = await call("tavern_read_variables", { action: "read", path: "不存在的路径" });
  assert.ok(missing.isError);
  console.log("✓ tavern_read_variables（list/search/read 分页 + 对象一层展开）");
}

// ---- 4. tavern_read_skill_reference
{
  const ok = await call("tavern_read_skill_reference", { name: "战斗规则", path: "references/combat.md" });
  assert.ok(ok.content[0].text!.includes("先攻"));
  const dir = await call("tavern_read_skill_reference", { name: "战斗规则", path: "" });
  assert.ok(dir.content[0].text!.includes("references"), "目录列出内容");
  const escape = await call("tavern_read_skill_reference", { name: "../..", path: "etc/passwd" });
  assert.ok(escape.isError, "目录穿越应被拒绝");
  console.log("✓ tavern_read_skill_reference（读取/列目录/防穿越）");
}

fs.rmSync(skillsDir, { recursive: true, force: true });
console.log("\n=== M3 工具四件套验证全部通过 ===");
