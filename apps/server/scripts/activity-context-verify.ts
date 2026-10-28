/** Deterministic local fixtures; no external model requests. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { Message, Models } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { INSTRUCT_TEMPLATES, type ContextDiagnosticsDto, type GenerationRecordDto } from "@pitavern/shared";
import { ActivityStore, emptyUsage } from "../src/stdata/activity.ts";
import { createTokenCounter, inputBudget, measureContext } from "../src/context/tokens.ts";
import { compressHistory } from "../src/context/compression.ts";
import { createTavernAgent } from "../src/agent/engine.ts";
import { scanWorldInfo, normalizeWorldFile } from "../src/context/worldinfo.ts";
import { assembleBridgeContext } from "../src/context/bridge.ts";
import { normalizeCard } from "../src/stdata/types.ts";
import { defaultConfig } from "../src/config.ts";
import { buildModels, resolveModel } from "../src/providers/models.ts";
import { renderInstruct } from "../src/context/instruct.ts";

const root = path.resolve(import.meta.dirname, "../../../data/test-runs");
fs.mkdirSync(root, { recursive: true });
const runDir = fs.mkdtempSync(path.join(root, "activity-context-"));
const modern = createTokenCounter("gpt-4o");
const legacy = createTokenCounter("gpt-4");
assert.equal(modern.name, "o200k_base"); assert.equal(legacy.name, "cl100k_base");
assert.equal(modern.count("hello world"), 2);
assert.equal(legacy.count("hello world"), 2);
assert.equal(createTokenCounter("custom-alias").kind, "estimate");
assert.equal(createTokenCounter("custom-alias", "o200k_base").count("中文与 emoji 🙂"), modern.count("中文与 emoji 🙂"));
assert.doesNotThrow(() => modern.count("literal <|endoftext|> template"));
assert.ok(createTokenCounter("unknown").count("🙂".repeat(30)) >= 40);
assert.deepEqual(inputBudget(8000, 2000), { contextWindow: 8000, outputReserved: 2000, safetyMargin: 600, inputBudget: 5400 });
assert.equal(inputBudget(1000, 2000).inputBudget, 0);

const user = (content: string): Message => ({ role: "user", content, timestamp: 0 });
const tool = { name: "lookup", description: "查询资料", parameters: Type.Object({ query: Type.String() }) };
const messages: Message[] = [
  { role: "system", content: "base", sections: { state: "OLD".repeat(1000) }, toolsAdded: [tool], timestamp: 0 },
  user("问题"),
  { role: "system", content: "", sections: { state: "NEW" }, toolsAdded: [tool], timestamp: 1 },
];
const folded: Message[] = [{ role: "system", content: "base", sections: { state: "NEW" }, toolsAdded: [tool], timestamp: 0 }, user("问题")];
assert.deepEqual(measureContext(messages, modern), measureContext(folded, modern), "system sections 与工具重声明只能计费一次");
assert.ok(measureContext(messages, modern).breakdown.tools > 0);
const textMessages: Message[] = [{ role: "system", content: "系统说明", timestamp: 0 }, user("中文问题🙂")];
const textFormat = { template: { ...INSTRUCT_TEMPLATES.ChatML, story_string_prefix: "故事序言" }, names: { char: "向导", user: "旅人" } };
assert.equal(measureContext(textMessages, modern, textFormat).total, modern.count(renderInstruct(textMessages, textFormat.template, textFormat.names).prompt));
const long: Message[] = [textMessages[0], user("早期事件记录。".repeat(500)), user("最近问题")];
const measured = (items: Parameters<typeof measureContext>[0]) => measureContext(items, modern).total;
const compacted = compressHistory(long, { enabled: true, keepFullTurns: 1 }, 700, measured);
assert.ok(compacted.stats.triggered); assert.equal(compacted.stats.squashedTurns, 1);
assert.equal(compacted.messages.at(-1), long.at(-1)); assert.ok(measured(compacted.messages) < measured(long));
assert.equal(compressHistory(long, { enabled: false, keepFullTurns: 1 }, 700, measured).stats.triggered, false);
console.log("✓ 编码器选择/回退、中文与模板、系统/工具去重、输出预留及按 token 压缩");

const entries = normalizeWorldFile({ entries: {
  included: { constant: true, content: "hello world", position: 0, order: 0 },
  budget: { constant: true, content: "this will exceed the budget", order: 1 },
  probability: { constant: true, content: "no", probability: 0 },
  disabled: { constant: true, content: "disabled", disable: true },
  unmatched: { key: ["missing"], content: "未命中" },
} }, "fixture");
const scanOptions = { scanDepth: 2, recursionSteps: 0, caseSensitive: false, matchWholeWords: false, budgetTokens: 3, countTokens: modern.count };
const scanned = scanWorldInfo(entries, ["问题"], scanOptions);
const decisions = Object.fromEntries(scanned.decisions.map((decision) => [decision.uid, decision]));
assert.equal(decisions.included.status, "included"); assert.equal(decisions.included.tokens, 2);
assert.equal(decisions.budget.reason, "超出世界书预算");
assert.equal(decisions.probability.reason, "概率未通过"); assert.equal(decisions.disabled.reason, "已禁用");
assert.equal(decisions.unmatched.status, "skipped");
const assembled = assembleBridgeContext({ preset: { prompts: [], prompt_order: [] },
  card: normalizeCard("chara_card_v2", { name: "向导" }, ""), persona: { name: "旅人", description: "" },
  chatLines: [], worldEntries: entries, regexScripts: [], options: scanOptions });
assert.equal(assembled.worldInfo[0].status, "skipped", "扫描激活但缺少预设 marker，不能标成已注入");
console.log("✓ 世界书实际计数、预算过滤、概率/禁用/未命中与缺失插入位置诊断");

const config = defaultConfig();
config.providers = [{ id: "fixture", name: "fixture", baseUrl: "http://127.0.0.1:1/v1", models: [{ id: "gpt-4o", name: "fixture", contextWindow: 150, maxTokens: 50 }] }];
config.defaultProvider = "fixture"; config.defaultModel = "gpt-4o";
const models = buildModels(config);
let diagnostics: ContextDiagnosticsDto | undefined;
let networkCalls = 0;
const neverCall = { streamSimple: () => { networkCalls++; throw new Error("不应访问模型"); } } as unknown as Models;
const agent = createTavernAgent({ models: neverCall, model: resolveModel(models, config), chatId: "budget-test", thinkingLevel: "off",
  systemPrompt: "很长的固定设定。".repeat(200), compression: { enabled: false, keepFullTurns: 1 }, onContext: (value) => { diagnostics = value; } });
await agent.prompt("问题");
assert.equal(networkCalls, 0); assert.equal(diagnostics!.overBudget, true);
assert.equal(diagnostics!.counting, "tokenizer"); assert.equal(diagnostics!.outputReserved, 50);
assert.ok(agent.state.errorMessage?.includes("预算"));
console.log("✓ 超预算请求在发送前终止，诊断保留实际系统占用和输出预留");

const store = new ActivityStore(runDir);
const chatId = "chats/fixture/demo.jsonl";
let last: GenerationRecordDto | undefined;
for (let i = 0; i < 26; i++) {
  const record: GenerationRecordDto = {
    id: store.createId(chatId), version: 0, userMessageId: "same-user", kind: i ? "regenerate" : "send", provider: "fixture", model: "fixture",
    startedAt: new Date().toISOString(), status: i === 25 ? "running" : "succeeded",
    usage: { ...emptyUsage(), input: 8, output: 2, totalTokens: 10, responses: 1, responsesWithUsage: 1 },
    tools: [{ key: `generation-${i}`, toolCallId: "reused-provider-id", toolName: "lookup", args: { query: "资料" }, status: i === 25 ? "running" : "done" }],
  };
  store.save(chatId, record); store.save(chatId, record); // Replacing a record never adds its usage twice.
  last = record;
}
const before = store.snapshot(chatId, 1);
assert.equal(before.totalGenerations, 26); assert.equal(before.turns, 1);
assert.equal(before.usage.totalTokens, 260); assert.equal(before.toolCounts.lookup, 26);
assert.equal(before.records[0].id, last!.id); assert.equal(before.records.length, 5);
const middle = store.page(chatId, before.before!);
const tail = store.page(chatId, middle.before!);
assert.equal(new Set([...before.records, ...middle.records, ...tail.records].map((record) => record.id)).size, 26);
assert.equal(tail.before, null);
const restarted = new ActivityStore(runDir).snapshot(chatId, 1);
assert.equal(restarted.usage.totalTokens, 260); assert.equal(restarted.records[0].status, "interrupted");
assert.equal(restarted.records[0].tools[0].status, "error");
assert.ok(restarted.revision > before.revision);
console.log("✓ 26 次生成分页、相同工具 ID 隔离、替换不重复累计及服务中断恢复");
console.log("活动与上下文验证通过；合成数据保留：" + runDir);
