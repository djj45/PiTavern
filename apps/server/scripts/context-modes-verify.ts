import assert from "node:assert/strict";
import type { Models, Message } from "@earendil-works/pi-ai";
import type { ContextDiagnosticsDto } from "@pitavern/shared";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { assembleBridgeContext } from "../src/context/bridge.ts";
import { assembleTakeoverContext } from "../src/context/takeover.ts";
import { buildWorkingContext } from "../src/context/working-set.ts";
import { ContextFactCache } from "../src/context/memory-cache.ts";
import { createTavernAgent } from "../src/agent/engine.ts";
import { createInitialWorldSnapshot, createWorldTemplateRecord } from "../src/world/index.ts";
import { getWorldTemplate } from "../src/world/catalog.ts";
import { normalizeCard, type StChatLine } from "../src/stdata/types.ts";
import { defaultConfig } from "../src/config.ts";
import { buildModels, resolveModel } from "../src/providers/models.ts";
import { longContextFixture } from "./context-fixtures.ts";
import { INSTRUCT_TEMPLATES } from "@pitavern/shared";
const fixture = longContextFixture(100);
const lines: StChatLine[] = fixture.messages.filter((m) => m.role !== "system").map((m) => ({ name: m.role === "user" ? "旅人" : "向导", is_user: m.role === "user", is_system: false, send_date: "", mes: typeof m.content === "string" ? m.content : m.content.filter((b) => b.type === "text").map((b) => b.type === "text" ? b.text : "").join("") }));
const card = normalizeCard("chara_card_v2", { name: "向导", description: "古城探险" }, "");
const persona = { name: "旅人", description: "" };
const config = defaultConfig(); config.providers = [{ id: "fixture", name: "fixture", baseUrl: "http://127.0.0.1:1", models: [{ id: "local", name: "fixture", contextWindow: 8000, maxTokens: 1000 }] }]; config.defaultProvider = "fixture"; config.defaultModel = "local";
const models = buildModels(config); const model = resolveModel(models, config);
const world = createInitialWorldSnapshot(createWorldTemplateRecord(getWorldTemplate("tavern-sword")));
world.money.player = 77;
let checks = 0;
for (const mode of ["simple", "bridge", "takeover"] as const) {
  let messages: Message[] = fixture.messages; let archived: Message[] | undefined;
  if (mode === "bridge") messages = assembleBridgeContext({ card, persona, chatLines: lines, worldEntries: [], regexScripts: [], preset: { prompts: [], prompt_order: [] }, options: { scanDepth: 2, recursionSteps: 0, caseSensitive: false, matchWholeWords: false } }).messages;
  if (mode === "takeover") {
    const assembled = assembleTakeoverContext({ card, persona, chatLines: lines, worldEntries: [], metadata: {}, options: { recentTurns: 3, stateProjection: true, useProtocol: false } });
    messages = assembled.messages; archived = assembled.archived; assert.ok(archived.length > 0);
  }
  let sent = ""; let diagnostics: ContextDiagnosticsDto | undefined;
  const capture = { streamSimple: (_model: unknown, context: Parameters<typeof normalizeContext>[0]) => { sent = JSON.stringify(normalizeContext(context).messages); throw new Error("captured working set"); } } as unknown as Models;
  const agent = createTavernAgent({ models: capture, model, chatId: mode, thinkingLevel: "off", messages, archivedHistory: archived, worldSnapshot: () => world,
    contextFactCache: new ContextFactCache(), contextSourceRevision: "fixed", compression: { enabled: true, keepFullTurns: 3 }, onContext: (d) => { diagnostics = d; } });
  await agent.continue();
  assert.ok(sent); assert.ok(agent.state.errorMessage?.includes("captured working set"));
  assert.ok(fixture.facts.every((f) => sent.includes(f)), mode + " 保留旧线索");
  assert.ok(sent.includes("当前权威世界快照") && sent.includes('\\"player\\":77'));
  assert.ok(diagnostics!.workingSet!.compressed.length > 0);
  assert.ok(diagnostics!.afterTokens <= diagnostics!.inputBudget);
  assert.equal(diagnostics!.counting, "estimate");
  console.log("✓ " + mode + " 实际 Agent 发送工作集、权威状态、来源与估算预算"); checks++;
}
const injected = assembleBridgeContext({ card, persona, chatLines: lines, worldEntries: [], regexScripts: [], preset: { prompts: [
  { identifier: "pinned-user", role: "user", content: "预设假事实：发现紫色徽章。" },
], prompt_order: [{ character_id: 100001, order: [{ identifier: "pinned-user", enabled: true }] }] }, options: { scanDepth: 2, recursionSteps: 0, caseSensitive: false, matchWholeWords: false } });
const pinned = buildWorkingContext({ messages: injected.messages, config: { enabled: true, keepFullTurns: 3 }, budget: 16000 });
assert.ok(pinned.messages.some((m) => typeof m.content === "string" && m.content === "预设假事实：发现紫色徽章。"));
assert.ok(!pinned.facts.some((f) => f.text.includes("紫色徽章")));
console.log("✓ bridge 的 user/assistant 预设注入保持固定，不能变成历史事实"); checks++;
const vars = { promise: "当前值" };
assembleTakeoverContext({ card, persona, chatLines: [
  { ...lines[0], mes: "{{setvar::promise::旧值}}发现线索：铜门在后院。" }, ...lines.slice(1),
], worldEntries: [], metadata: { variables: vars }, options: { recentTurns: 3, stateProjection: false, useProtocol: false } });
assert.equal(vars.promise, "当前值");
console.log("✓ takeover 窗口外宏在独立变量副本中装配，不覆盖当前状态"); checks++;
let calls = 0; let diagnostics: ContextDiagnosticsDto | undefined;
const noNetwork = { streamSimple: () => { calls++; throw new Error("never"); } } as unknown as Models;
const agent = createTavernAgent({ models: noNetwork, model: { ...model, api: "openai-text-completions" }, chatId: "text", thinkingLevel: "off",
  messages: fixture.messages, instruct: { ...INSTRUCT_TEMPLATES.ChatML, story_string_prefix: "序言".repeat(20000) }, compression: { enabled: true, keepFullTurns: 3 }, onContext: (d) => { diagnostics = d; } });
await agent.continue(); assert.equal(calls, 0); assert.equal(diagnostics!.overBudget, true); assert.ok(agent.state.errorMessage?.includes("预算"));
console.log("✓ text-completion 计入完整 instruct 封装，超预算前阻止请求"); checks++;
console.log(`${checks} 项模式集成验证通过；未调用模型供应商。`);
