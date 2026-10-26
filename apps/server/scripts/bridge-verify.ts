/**
 * M2 桥接组装器对齐验证：用真实猫神预设 + 封神演义卡（111 条内嵌世界书）
 * 组装一次完整上下文并逐项断言。npm run verify:bridge
 */
import assert from "node:assert";
import path from "node:path";
import { CharacterStore } from "../src/stdata/characters.ts";
import { loadPreset, presetsDir, resolveOrder } from "../src/context/preset.ts";
import { assembleBridgeContext } from "../src/context/bridge.ts";
import { normalizeCardBook, scanWorldInfo } from "../src/context/worldinfo.ts";
import type { RegexScript } from "../src/context/regex.ts";
import type { StChatLine } from "../src/stdata/types.ts";

const ST_DATA = path.resolve(import.meta.dirname, "../../../data/st");
const PRESET = "猫神1.5";

const preset = loadPreset(path.join(presetsDir(ST_DATA), `${PRESET}.json`));
const card = new CharacterStore(path.join(ST_DATA, "characters")).getCharacter("封神演义--异闻录版");
assert.ok(card, "封神演义卡应可解析");

// ---- 1. prompt_order 引擎
const order = resolveOrder(preset);
assert.equal(order.length, 53, "猫神预设全局档应为 53 条顺序");
console.log(`✓ prompt_order 解析：${order.length} 条（启用 ${(order.filter((o) => o.enabled)).length} 条）`);

// ---- 2. 组装（含世界书关键词、正则、深度注入的全部触发条件）
const lines: StChatLine[] = [
  { name: card.name, is_user: false, is_system: false, send_date: "", mes: card.firstMes || "（酒馆的门被推开……）" },
  { name: "测试员", is_user: true, is_system: false, send_date: "", mes: "我先在酒馆里坐下，听说陆压道人的故事。" },
  {
    name: card.name,
    is_user: false,
    is_system: false,
    send_date: "",
    mes: "<think_nya~>用户提到陆压，查一下设定</think_nya~>酒保压低声音：那位西昆仑散人，可是连仙人都敢斩的。",
  },
  {
    name: card.name,
    is_user: false,
    is_system: false,
    send_date: "",
    // depth 7（>=6）：小总结1 应把它折叠成只剩 <summary>
    mes: "前情很长很长 <summary>第一段剧情总结：测试员入座听书。</summary> 后面还有尾巴",
  },
  { name: "测试员", is_user: true, is_system: false, send_date: "", mes: "再讲讲。" },
  { name: card.name, is_user: false, is_system: false, send_date: "", mes: "（他斟了杯酒）且听下回分解。" },
  { name: "测试员", is_user: true, is_system: false, send_date: "", mes: "好。" },
  { name: card.name, is_user: false, is_system: false, send_date: "", mes: "……" },
  { name: "测试员", is_user: true, is_system: false, send_date: "", mes: "继续。" },
  { name: card.name, is_user: false, is_system: false, send_date: "", mes: "（酒过三巡）夜深了。" },
  { name: "测试员", is_user: true, is_system: false, send_date: "", mes: "今晚就到这，结账。对了，明天继续讲陆压道人的故事。" },
];

// 卡内书（111 条：14 常驻 + 86 关键词）
const bookEntries = normalizeCardBook(card.characterBook, "卡内书");

// 预设里原本的 depth0 条目不在 prompt_order 中（ST 同样不会启用），
// 这里补一条合成的绝对深度条目验证注入机制本身
const ABS_ID = "test-abs-inject";
preset.prompts.push({
  identifier: ABS_ID,
  role: "system",
  content: "|测试深度注入|",
  injection_position: 1,
  injection_depth: 0,
});
preset.prompt_order.find((o) => o.character_id === 100001)!.order.push({ identifier: ABS_ID, enabled: true });

const assembled = assembleBridgeContext({
  preset,
  card,
  persona: { name: "测试员", description: "路过的旅人" },
  chatLines: lines,
  worldEntries: bookEntries,
  regexScripts: (preset.extensions as { regex_scripts?: RegexScript[] })?.regex_scripts ?? [],
  options: {
    scanDepth: 2,
    recursionSteps: 0,
    caseSensitive: false,
    matchWholeWords: true,
    maxHistoryChars: 10_000_000,
  },
});

// 单独验证卡内书扫描行为
const scan = scanWorldInfo(bookEntries, lines.map((l) => l.mes), {
  scanDepth: 2,
  recursionSteps: 0,
  caseSensitive: false,
  matchWholeWords: true,
});
assert.ok(scan.activated.some((e) => e.constant), "常驻条目应激活");
assert.ok(scan.activated.some((e) => e.content.includes('Character("陆压道人")')), "关键词『陆压』应激活陆压道人条目");
console.log(`✓ 世界书扫描：${scan.activated.length}/${bookEntries.length} 条激活（含常驻与『陆压』关键词命中）`);

// ---- 3. 结构断言
const { messages, sampling, stats } = assembled;
const textsOf = (role: string) =>
  messages.filter((m) => m.role === role).map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
const allText = messages
  .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
  .join("\n");

assert.equal(messages[0].role, "system", "首条消息应为 system");
assert.ok(allText.includes("小猫之神"), "预设内容（猫神壳）应进入上下文");
assert.ok(!allText.includes("{{char}}") && !allText.includes("{{user}}"), "宏应全部替换");
assert.ok(allText.includes("[World_Law"), "卡内书常驻条目应进入上下文（经由扫描结果注入）");
assert.ok(allText.includes('Character("陆压道人")'), "关键词激活的条目应进入上下文");
console.log(`✓ 结构：${messages.length} 条消息，system ${stats.systemChars} 字，预设条目 ${stats.promptEntries} 条`);

// 小总结1（depth≥6 的 assistant 消息折叠为仅 <summary>）
const summarized = textsOf("assistant").find((t) => t.includes("第一段剧情总结"));
assert.ok(summarized, "折叠后的消息应保留 summary");
assert.ok(!summarized!.includes("前情很长"), "summary 之外的正文应被折叠掉");
// 思维链对AI隐藏（depth≥1 的 assistant 消息去除 <think_nya~>；预设条目里的格式说明不算）
const thinkMsg = textsOf("assistant").find((t) => t.includes("酒保压低声音"));
assert.ok(thinkMsg, "含思维链的消息应存在");
assert.ok(!thinkMsg!.includes("<think_nya~"), "历史消息中的思维链标签应被去除");
console.log("✓ 提示词正则：小总结1 折叠 + 思维链隐藏");

// 最后一条 user = 本轮用户消息；其后紧跟 depth 0 绝对注入（猫神的 |小猫之神_世界书|）。
// chatHistory 之后还有尾部条目（继续游戏等 system 提示），这是 ST 的正常 order 语义。
const lastUserIdx = messages.map((m) => m.role).lastIndexOf("user");
assert.ok(lastUserIdx > 0, "应存在用户消息");
assert.equal((messages[lastUserIdx] as { content: string }).content, "今晚就到这，结账。对了，明天继续讲陆压道人的故事。");
const afterUser = messages[lastUserIdx + 1];
assert.ok(afterUser && afterUser.role === "system", "depth 0 绝对注入应紧跟最新用户消息");
assert.ok((afterUser as { content: string }).content.includes("|测试深度注入|"), "depth 0 绝对注入内容正确");
console.log("✓ 深度注入：depth 0 绝对注入位于最新用户消息之后");

// 采样参数透传
assert.equal(sampling.temperature, 1.09);
assert.equal(sampling.samplingParams?.top_p, 0.98);
assert.equal(sampling.maxTokens, 65535);
console.log("✓ 采样参数：temperature 1.09 / top_p 0.98 / maxTokens 65535");

console.log("\n=== M2 桥接组装器对齐验证全部通过 ===");
console.log(`\n[组装统计] ${JSON.stringify(stats)}`);
console.log("\n[system 消息预览]");
for (const m of messages.filter((x) => x.role === "system").slice(0, 4)) {
  const t = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
  console.log(`--- (${t.length} 字) ${t.slice(0, 100).replace(/\n/g, "⏎")}…`);
}
