/** 合成夹具 + 本地模拟接口。每次请求保留在独立目录，不调用真实模型。 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { ServerEvent } from "@pitavern/shared";
import { INSTRUCT_TEMPLATES } from "@pitavern/shared";

const root = path.resolve(import.meta.dirname, "../../..");
fs.mkdirSync(path.join(root, "data/test-runs"), { recursive: true });
const runDir = fs.mkdtempSync(path.join(root, "data/test-runs/compatibility-"));
process.env.PITAVERN_CONFIG = path.join(runDir, "config.json");
const { defaultConfig, loadConfig, saveConfig, seedDataDirs } = await import("../src/config.ts");
const { substituteMacros } = await import("../src/context/macros.ts");
const { scanWorldInfo, normalizeWorldFile, normalizeCardBook, worldEntryKey, emptyTimedState } = await import("../src/context/worldinfo.ts");
const { retrieveVectorEntries } = await import("../src/context/vectors.ts");
const { normalizeInstruct, renderInstruct } = await import("../src/context/instruct.ts");
const { buildModels, resolveModel } = await import("../src/providers/models.ts");
const { CharacterStore } = await import("../src/stdata/characters.ts");
const { ChatStore } = await import("../src/stdata/chats.ts");
const { SessionManager } = await import("../src/session/manager.ts");
const { createHttpApp } = await import("../src/api/http.ts");
const config = defaultConfig();
fs.writeFileSync(process.env.PITAVERN_CONFIG, JSON.stringify({ worldInfo: { scanDepth: 4 }, providers: [] }));
assert.equal(loadConfig().worldInfo.scanDepth, 4);
assert.equal(loadConfig().worldInfo.minActivations, 0);
assert.equal(loadConfig().vectors.enabled, false);
config.stDataDir = path.join(runDir, "st");
seedDataDirs(config.stDataDir);

const requests: Array<{ url: string; body: any; authenticated: boolean }> = [];
let mode = "normal";
const mock = http.createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  const record = { url: req.url ?? "", body, authenticated: Boolean(req.headers.authorization) };
  requests.push(record);
  fs.writeFileSync(path.join(runDir, `request-${String(requests.length).padStart(4, "0")}.json`), JSON.stringify(record, null, 2));
  if (req.url === "/v1/embeddings") {
    if (mode === "slow-embedding") { res.writeHead(200, { "Content-Type": "application/json" }); res.flushHeaders(); return; }
    const data = body.input.map((text: string, index: number) => ({ index,
      embedding: /旅馆|住宿|休息|连通/.test(text) ? [1, 0, 0] : [0, 1, 0],
    }));
    if (body.model === "vectors-v2") for (const item of data) item.embedding.push(0);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: data.reverse() }));
    return;
  }
  assert.equal(req.url, "/v1/completions");
  if (mode === "error") { res.writeHead(503); res.end("temporarily unavailable"); return; }
  if (mode === "json") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ text: "完整正文", finish_reason: "length" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  if (mode === "hang") { res.flushHeaders(); return; }
  const frames = [
    { choices: [{ index: 0, text: "你好", finish_reason: null }] },
    { choices: [{ index: 0, text: "，旅人。", finish_reason: null }] },
  ];
  const stream = frames.map((value) => `data: ${JSON.stringify(value)}\r\n\r\n`).join("") + (mode === "truncate" ? "" :
    `data: ${JSON.stringify({ choices: [{ index: 0, text: "", finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } })}\r\n\r\ndata: [DONE]\r\n\r\n`);
  const bytes = Buffer.from(stream);
  for (let i = 0; i < bytes.length; i += 7) {
    if (res.destroyed) return;
    res.write(bytes.subarray(i, i + 7));
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  res.end();
});
mock.listen(0, "127.0.0.1");
await once(mock, "listening");
const baseUrl = `http://127.0.0.1:${(mock.address() as AddressInfo).port}/v1`;
config.providers = [{ id: "local", name: "本地合成测试", baseUrl, apiType: "text", instruct: INSTRUCT_TEMPLATES.ChatML,
  models: [{ id: "fiction-model", name: "测试模型", contextWindow: 8000, maxTokens: 500 }] }];
config.defaultProvider = "local";
config.defaultModel = "fiction-model";
let appServer: http.Server | undefined;
const until = async (test: () => boolean) => {
  const limit = Date.now() + 5000;
  while (!test()) { assert.ok(Date.now() < limit, "等待条件超时"); await new Promise((resolve) => setTimeout(resolve, 10)); }
};

try {
  const variables: Record<string, unknown> = {};
  const env = { char: "向导", user: "旅人", variables };
  assert.equal(substituteMacros("{{setvar::金币::100}}{{getvar::金币}}", env), "100");
  assert.equal(substituteMacros("{{setvar::备注::  a::b  }}{{getvar::备注}}", env), "  a::b  ");
  assert.equal(substituteMacros("{{setvar::称呼::{{char}}的{{user}}}}{{getvar::称呼}}", env), "向导的旅人");
  assert.equal(substituteMacros("{{setvar::金币::}}{{getvardefault::金币::缺省}}", env), "");
  substituteMacros("{{setvar::金币::200}}", { ...env, readOnly: true });
  assert.equal(variables.金币, "");
  assert.equal(substituteMacros("{{unknown::value}}", env), "{{unknown::value}}");
  console.log("✓ setvar 顺序、嵌套、空值、原始空白和只读预览");

  const entries = normalizeWorldFile({ entries: {
    inn: { key: ["旅馆"], content: "旅馆提供住宿。", order: 1 },
    library: { key: ["图书馆"], content: "图书馆收藏地图。", order: 2 },
  } }, "世界");
  const opts = { scanDepth: 1, recursionSteps: 0, caseSensitive: false, matchWholeWords: false };
  const history = ["图书馆", "旅馆", "继续"];
  assert.equal(scanWorldInfo(entries, history, opts).activated.length, 0);
  assert.equal(scanWorldInfo(entries, history, { ...opts, minActivations: 2 }).activated.length, 2);
  assert.equal(scanWorldInfo(entries, history, { ...opts, minActivations: 2, minActivationsDepthMax: 2 }).activated.length, 1);
  assert.equal(scanWorldInfo(entries, history, { ...opts, minActivations: 2, budgetTokens: 1 }).activated.length, 0);
  assert.equal(scanWorldInfo([{ ...entries[0], scanDepth: 1 }], history, { ...opts, minActivations: 2 }).activated.length, 0);
  let rolls = 0;
  const random = Math.random;
  try {
    Math.random = () => { rolls++; return 0.99; };
    scanWorldInfo([{ ...entries[0], probability: 50 }], ["旅馆", "旅馆", "旅馆"], { ...opts, minActivations: 2 });
    assert.equal(rolls, 1, "扩大扫描范围不能反复抽取同一条目的激活概率");
  } finally { Math.random = random; }
  console.log("✓ 最少激活数、最大深度、估算预算、条目独立深度和概率");

  const vectorEntries = entries.map((entry) => ({ ...entry, key: [], vectorized: true }));
  assert.equal(normalizeCardBook({ entries: [{ content: "旅馆", keys: [], extensions: { vectorized: true } }] }, "卡片")[0].vectorized, true);
  assert.equal((await retrieveVectorEntries(config, vectorEntries, ["需要休息"], config.stDataDir)).size, 0);
  assert.equal(requests.length, 0);
  config.vectors = { enabled: true, providerId: "local", model: "vectors-v1", queryMessages: 1, maxEntries: 1, scoreThreshold: 0.8 };
  const matches = await retrieveVectorEntries(config, vectorEntries, ["需要休息"], config.stDataDir);
  assert.deepEqual([...matches], [worldEntryKey(entries[0])]);
  assert.equal(requests.length, 2);
  const scan = scanWorldInfo(vectorEntries, ["需要休息"], { ...opts, vectorMatches: matches });
  assert.equal(scan.activated[0].uid, "inn");
  const timed = emptyTimedState();
  timed.cooldown[`${vectorEntries[0].world}/${vectorEntries[0].uid}`] = { start: 0, end: 10 };
  assert.equal(scanWorldInfo(vectorEntries, ["需要休息"], { ...opts, vectorMatches: matches, timed }).activated.length, 0);
  assert.equal(scanWorldInfo([{ ...vectorEntries[0], delay: 3 }], ["需要休息"], { ...opts, vectorMatches: matches }).activated.length, 0);
  await retrieveVectorEntries(config, vectorEntries, ["需要休息"], config.stDataDir);
  assert.equal(requests.length, 3, "缓存命中时只重新计算查询向量");
  await retrieveVectorEntries(config, [{ ...vectorEntries[0], content: "旅馆有新房间。" }, vectorEntries[1]], ["需要休息"], config.stDataDir);
  assert.equal(requests.length, 5);
  config.vectors.model = "vectors-v2";
  await retrieveVectorEntries(config, vectorEntries, ["需要休息"], config.stDataDir);
  assert.equal(requests.length, 7, "更换模型/维度应重建条目向量");
  console.log("✓ 无关键词语义召回、计时限制、禁用开关、缓存复用及内容/模型更新");

  const template = normalizeInstruct({ ...INSTRUCT_TEMPLATES.ChatML, name: "导入模板" });
  const rendered = renderInstruct([
    { role: "system", content: "你是向导。", timestamp: 0 },
    { role: "user", content: "你好", timestamp: 0 },
  ], template);
  assert.equal(rendered.prompt, "<|im_start|>system\n你是向导。<|im_end|>\n<|im_start|>user\n你好<|im_end|>\n<|im_start|>assistant\n");
  assert.ok(rendered.stop.includes("<|im_end|>"));
  const story = renderInstruct([
    { role: "system", content: "场景", timestamp: 0 }, { role: "system", content: "人物", timestamp: 0 },
    { role: "user", content: "你好", timestamp: 0 },
  ], { ...template, story_string_prefix: "<story>", story_string_suffix: "</story>" });
  assert.ok(story.prompt.startsWith("<story>场景\n人物</story>"));
  const named = renderInstruct([{ role: "user", content: "你好", timestamp: 0 }], {
    ...INSTRUCT_TEMPLATES.Alpaca, names_behavior: "always", input_sequence: "{{user}} 输入", last_output_sequence: "{{char}} 输出",
  }, { char: "向导", user: "旅人" });
  assert.match(named.prompt, /旅人 输入\n旅人: 你好/);
  assert.ok(named.prompt.endsWith("向导 输出\n向导:"));
  assert.throws(() => normalizeInstruct({ name: "不是 instruct" }), /input_sequence/);
  console.log("✓ instruct 导入校验、消息拼装及停止序列");

  const models = buildModels(config);
  const model = resolveModel(models, config);
  const context = { messages: [{ role: "user" as const, content: "你好", timestamp: 0 }] };
  const events = models.streamSimple(model, context, { maxTokens: 20 });
  const deltas: string[] = [];
  for await (const event of events) if (event.type === "text_delta") deltas.push(event.delta);
  const result = await events.result();
  assert.equal(deltas.join(""), "你好，旅人。");
  assert.equal(result.stopReason, "stop");
  assert.equal(result.usage.totalTokens, 25);
  assert.equal(requests.at(-1)!.authenticated, false, "允许无需 API key 的本地文本补全服务");
  assert.equal(requests.at(-1)!.body.max_tokens, 20);
  assert.equal(requests.at(-1)!.body.tools, undefined);
  mode = "json";
  assert.equal((await models.completeSimple(model, context)).stopReason, "length");
  mode = "truncate";
  assert.equal((await models.completeSimple(model, context)).stopReason, "error");
  mode = "error";
  assert.match((await models.completeSimple(model, context)).errorMessage!, /503/);
  mode = "hang";
  const abort = new AbortController();
  const beforeAbort = requests.length;
  const pending = models.completeSimple(model, context, { signal: abort.signal });
  await until(() => requests.length > beforeAbort);
  abort.abort();
  assert.equal((await pending).stopReason, "aborted");
  mode = "normal";
  console.log("✓ 文本补全 SSE 跨块/中文、JSON 响应、用量、网络中断、错误及停止");

  fs.writeFileSync(path.join(config.stDataDir, "characters/guide.json"), JSON.stringify({ name: "向导", description: "负责带路{{setvar::人物变量::卡片}}" }));
  fs.writeFileSync(path.join(config.stDataDir, "OpenAI Settings/test.json"), JSON.stringify({
    prompts: [
      { identifier: "charDescription", role: "system", content: "", marker: true },
      { identifier: "state", role: "system", content: "{{setvar::金币::100}}金币：{{getvar::金币}}" },
      { identifier: "worldInfoBefore", role: "system", content: "", marker: true },
      { identifier: "chatHistory", role: "system", content: "", marker: true },
    ], prompt_order: [{ character_id: 100001, order: ["charDescription", "state", "worldInfoBefore", "chatHistory"].map((identifier) => ({ identifier, enabled: true })) }],
  }));
  fs.writeFileSync(path.join(config.stDataDir, "worlds/semantic.json"), JSON.stringify({ entries: { inn: { vectorized: true, content: "旅馆提供住宿。", key: [] } } }));
  config.contextMode = "bridge";
  config.activePreset = "test";
  config.activeWorlds = ["semantic"];
  const characters = new CharacterStore(path.join(config.stDataDir, "characters"));
  const chats = new ChatStore(config.stDataDir);
  const modelsRef = { current: buildModels(config) };
  const sessions = new SessionManager(config, () => modelsRef.current, characters, chats, config.stDataDir);
  const chat = chats.createChat("向导", null, "旅人");
  const sessionEvents: ServerEvent[] = [];
  sessions.onEvent((event) => sessionEvents.push(event));
  await sessions.send(chat.id, "我想休息。{{setvar::次数::{{getvar::次数}}x}}");
  assert.deepEqual(sessionEvents.filter((e) => e.type === "chat.error"), []);
  assert.equal(sessionEvents.at(-1)?.type, "chat.finished");
  assert.equal(((new ChatStore(config.stDataDir)).readDocument(chat.id)!.metadata.variables as any).金币, "100");
  assert.equal((chats.readDocument(chat.id)!.metadata.variables as any).人物变量, "卡片");
  assert.equal((chats.readDocument(chat.id)!.metadata.variables as any).次数, "x", "扫描预览不能重复执行写变量");
  const request = requests.filter((r) => r.url.endsWith("/completions")).at(-1)!;
  assert.match(request.body.prompt, /金币：100/);
  assert.match(request.body.prompt, /旅馆提供住宿/);
  assert.doesNotMatch(request.body.prompt, /\{\{setvar/);
  const isolatedChat = chats.createChat("向导", null, "另一位旅人");
  assert.equal(chats.readDocument(isolatedChat.id)?.metadata.variables, undefined);
  mode = "slow-embedding";
  const beforeEmbedding = requests.length;
  const sending = sessions.send(chat.id, "继续休息");
  await until(() => requests.length > beforeEmbedding);
  assert.equal(sessions.abort(chat.id), true);
  await sending;
  assert.equal(sessions.isStreaming(chat.id), false);
  mode = "normal";
  console.log("✓ 桥接端到端：语义注入、变量落库/聊天隔离、扫描不重复写入、向量阶段停止");

  config.contextMode = "simple";
  await sessions.send(isolatedChat.id, "{{setvar::简单变量::1}}现在的值：{{getvar::简单变量}}");
  assert.equal((chats.readDocument(isolatedChat.id)!.metadata.variables as any).简单变量, "1");
  assert.match(requests.at(-1)!.body.prompt, /现在的值：1/);
  assert.match(requests.at(-1)!.body.prompt, /负责带路/);
  assert.equal(chats.readDocument(isolatedChat.id)!.lines.length, 2);
  config.contextMode = "bridge";
  console.log("✓ 简洁模式宏展开、系统设定与历史消息保留");

  appServer = http.createServer(createHttpApp({ config, modelsRef, characters, chats, sessions, webDistDir: null, stDataDir: config.stDataDir }));
  appServer.listen(0, "127.0.0.1"); await once(appServer, "listening");
  const appUrl = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}`;
  const put = (body: unknown) => fetch(`${appUrl}/api/connection`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const saved = await put({ worldInfo: { minActivations: 2, minActivationsDepthMax: 8, budgetTokens: 100 }, vectors: { ...config.vectors, enabled: true } });
  assert.equal(saved.status, 200);
  assert.equal(loadConfig().worldInfo.minActivations, 2);
  const beforeInvalid = JSON.stringify(config);
  assert.equal((await put({ persona: { name: "不应保存" }, contextMode: "takeover" })).status, 400);
  assert.equal(JSON.stringify(config), beforeInvalid, "不兼容组合不能部分覆盖配置");
  assert.equal((await put({ vectors: { scoreThreshold: 5 } })).status, 400);
  const dto = await (await fetch(`${appUrl}/api/connection`)).json() as any;
  assert.equal(dto.providers[0].apiType, "text");
  assert.equal(dto.providers[0].instruct.name, "ChatML");
  assert.equal(dto.providers[0].apiKey, undefined);
  assert.equal((await fetch(`${appUrl}/api/connection/test`, { method: "POST" })).status, 200);
  assert.equal((await fetch(`${appUrl}/api/vectors/test`, { method: "POST" })).status, 200);
  saveConfig(config);
  assert.equal(loadConfig().vectors.model, "vectors-v2");
  console.log("✓ 设置往返、旧配置默认值、接口连通、能力限制与失败时配置保持原样");
  console.log(`\n兼容性验证通过；合成数据与请求记录保留：${runDir}`);
} finally {
  appServer?.closeAllConnections(); appServer?.close();
  mock.closeAllConnections(); mock.close();
}
