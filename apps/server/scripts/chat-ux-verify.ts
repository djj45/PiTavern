/** Isolated fixtures and local mock endpoints; retain each run for inspection. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createHash } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import type { ServerEvent } from "@pitavern/shared";
import { INSTRUCT_TEMPLATES } from "@pitavern/shared";
import { normalizeCard } from "../src/stdata/types.ts";
import { assembleBridgeContext } from "../src/context/bridge.ts";
import { normalizeWorldFile, normalizeCardBook, scanWorldInfo, emptyTimedState } from "../src/context/worldinfo.ts";
import { chatReducer } from "../../web/src/chatState.ts";
import { createTokenCounter } from "../src/context/tokens.ts";

const root = path.resolve(import.meta.dirname, "../../..");
fs.mkdirSync(path.join(root, "data/test-runs"), { recursive: true });
const runDir = fs.mkdtempSync(path.join(root, "data/test-runs/chat-ux-"));
process.env.PITAVERN_CONFIG = path.join(runDir, "config.json");
const { defaultConfig, seedDataDirs } = await import("../src/config.ts");
const { ChatStore } = await import("../src/stdata/chats.ts");
const { CharacterStore } = await import("../src/stdata/characters.ts");
const { buildModels } = await import("../src/providers/models.ts");
const { SessionManager } = await import("../src/session/manager.ts");
const { createHttpApp } = await import("../src/api/http.ts");
const { attachWebSocket } = await import("../src/api/ws.ts");
const opts = { scanDepth: 2, recursionSteps: 0, caseSensitive: false, matchWholeWords: false };
const entry = (patch: Record<string, unknown> = {}) => normalizeWorldFile({ entries: { a: { key: ["钥匙"], content: "资料", ...patch } } }, "fixture")[0];
assert.equal(scanWorldInfo([entry()], ["钥匙"], { ...opts, scanDepth: 0 }).activated.length, 0);
assert.equal(scanWorldInfo([entry()], ["钥匙"], { ...opts, scanDepth: 0, minActivations: 1 }).activated.length, 1);
assert.equal(scanWorldInfo([entry({ scanDepth: 0 })], ["钥匙"], { ...opts, minActivations: 1 }).activated.length, 0);
assert.equal(scanWorldInfo([entry({ constant: true, probability: 0 })], [], opts).activated.length, 0);
assert.equal(scanWorldInfo([entry({ constant: true, probability: 0, useProbability: false })], [], opts).activated.length, 1);
const sticky = entry({ constant: true, probability: 100, sticky: 3 });
const timed = emptyTimedState();
scanWorldInfo([sticky], [], { ...opts, timed, messageCount: 2 });
assert.equal(scanWorldInfo([{ ...sticky, probability: 0 }], [], { ...opts, timed, messageCount: 3 }).activated.length, 1);
assert.equal(scanWorldInfo([entry({ key: ["KEY"], caseSensitive: null })], ["key"], { ...opts, caseSensitive: true }).activated.length, 0);
assert.equal(scanWorldInfo([entry({ keysecondary: ["missing"], selective: false })], ["钥匙"], opts).activated.length, 1);
const embedded = normalizeCardBook({ entries: [{ keys: ["KEY"], content: "资料", enabled: true, extensions: {
  scan_depth: 0, case_sensitive: true, match_whole_words: false, role: 2, probability: 0, useProbability: false, exclude_recursion: true,
} }] }, "embedded")[0];
assert.equal(embedded.scanDepth, 0); assert.equal(embedded.caseSensitive, true); assert.equal(embedded.role, "assistant");
assert.equal(embedded.probability, 100); assert.equal(embedded.excludeRecursion, true);
const markers = ["worldInfoBefore", "charDescription", "worldInfoAfter", "dialogueExamples", "chatHistory"];
const bridgeInput = {
  card: normalizeCard("chara_card_v2", { name: "向导", description: "角色说明", mes_example: "示例中间" }, ""),
  persona: { name: "旅人", description: "" },
  preset: { prompts: markers.map((identifier) => ({ identifier, role: "system" as const, content: "", marker: true })),
    prompt_order: [{ character_id: 100001, order: markers.map((identifier) => ({ identifier, enabled: true })) }] },
  chatLines: [
    { name: "旅人", is_user: true, is_system: false, send_date: "", mes: "旧问题" },
    { name: "向导", is_user: false, is_system: false, send_date: "", mes: "旧回答" },
    { name: "旅人", is_user: true, is_system: false, send_date: "", mes: "新问题" },
  ],
  worldEntries: [
    entry({ constant: true, position: 1, content: "角色之后" }),
    entry({ constant: true, position: 2, content: "注释之前" }),
    entry({ constant: true, position: 3, content: "注释之后" }),
    entry({ constant: true, position: 5, content: "示例之前" }),
    entry({ constant: true, position: 6, content: "示例之后" }),
    entry({ constant: true, position: 4, role: 1, depth: 0, content: "尾部一" }),
    entry({ constant: true, position: 4, role: 2, depth: 0, content: "尾部二" }),
    entry({ constant: true, position: 4, role: 1, depth: 2, content: "深度二" }),
  ],
  regexScripts: [], options: opts, metadata: { note_prompt: "注释中间", note_depth: 1, note_role: 1, note_interval: 1 },
};
const assembled = assembleBridgeContext(bridgeInput);
const texts = assembled.messages.map((m) => typeof m.content === "string" ? m.content : m.content.filter((c) => c.type === "text").map((c) => c.text).join(""));
assert.ok(texts.includes("示例之前\n示例中间\n示例之后"));
assert.ok(texts.includes("注释之前\n注释中间\n注释之后"));
assert.ok(texts.indexOf("旧问题") < texts.indexOf("深度二") && texts.indexOf("深度二") < texts.indexOf("旧回答"));
assert.ok(texts.indexOf("旧回答") < texts.indexOf("注释之前\n注释中间\n注释之后"));
assert.ok(texts.indexOf("尾部一") < texts.indexOf("尾部二"));
assert.equal(assembled.messages[texts.indexOf("尾部一")].role, "user");
assert.equal(assembled.messages[texts.indexOf("尾部二")].role, "assistant");
assert.ok(!JSON.stringify(assembleBridgeContext({ ...bridgeInput, metadata: { note_interval: 0 } }).messages).includes("注释之前"));
console.log("✓ 世界书零深度、最少激活、常驻概率、sticky、字段继承及 AN/EM/深度注入");

let mode = "normal";
let serial = 0;
let release: (() => void) | undefined;
const requests: any[] = [];
const mock = http.createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  requests.push(body);
  fs.writeFileSync(path.join(runDir, "request-" + requests.length + ".json"), JSON.stringify(body, null, 2));
  if (mode.startsWith("state") && !body.messages?.some((message: any) => message.role === "tool")) {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunk = (delta: object, finish_reason: string | null) => "data: " + JSON.stringify({
      id: "state-call", object: "chat.completion.chunk", model: "fixture", created: 1,
      choices: [{ index: 0, delta, finish_reason }],
      ...(finish_reason ? { usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 } } : {}),
    }) + "\n\n";
    res.end(chunk({ role: "assistant", tool_calls: [{ index: 0, id: "state-1", type: "function", function: {
      name: "tavern_set_state", arguments: JSON.stringify({ state: "新状态投影" }),
    } }] }, null) + chunk({}, "tool_calls") + "data: [DONE]\n\n");
    return;
  }
  if (mode === "error" || mode === "state-error") { res.writeHead(400); res.end("test failure"); return; }
  const text = mode === "empty" ? "" : "**新回复 " + (++serial) + "**";
  const isText = req.url === "/v1/completions";
  const frame = (end: boolean) => {
    const choice = isText ? { index: 0, text: end ? "" : text, finish_reason: end ? "stop" : null }
      : { index: 0, delta: end ? {} : { role: "assistant", content: text }, finish_reason: end ? "stop" : null };
    return "data: " + JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [choice],
      ...(end ? { usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } } : {}) }) + "\n\n";
  };
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.write(frame(false));
  const finish = () => { if (!res.destroyed) res.end(frame(true) + "data: [DONE]\n\n"); };
  if (mode === "usage-hold") {
    res.write("data: " + JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [],
      usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 } }) + "\n\n");
    release = finish; return;
  }
  if (mode === "hold") { release = finish; return; }
  finish();
});
mock.listen(0, "127.0.0.1"); await once(mock, "listening");
const config = defaultConfig();
config.stDataDir = path.join(runDir, "st"); seedDataDirs(config.stDataDir);
config.providers = [{ id: "fixture", name: "fixture", baseUrl: "http://127.0.0.1:" + (mock.address() as AddressInfo).port + "/v1",
  apiType: "text", instruct: INSTRUCT_TEMPLATES.ChatML, apiKey: "synthetic", models: [{ id: "fixture", name: "fixture", contextWindow: 8000, maxTokens: 500 }] }];
config.defaultProvider = "fixture"; config.defaultModel = "fixture"; config.toolsEnabled = false;
fs.writeFileSync(path.join(config.stDataDir, "characters/fixture.json"), JSON.stringify({ name: "向导", first_mes: "开场白" }));
const store = new ChatStore(config.stDataDir);
const characters = new CharacterStore(path.join(config.stDataDir, "characters"));
const modelsRef = { current: buildModels(config) };
const manager = new SessionManager(config, () => modelsRef.current, characters, store, config.stDataDir);
const events: ServerEvent[] = []; manager.onEvent((event) => events.push(event));
const server = http.createServer(createHttpApp({ config, modelsRef, characters, chats: store, sessions: manager, webDistDir: null, stDataDir: config.stDataDir }));
attachWebSocket(server, manager); server.listen(0, "127.0.0.1"); await once(server, "listening");
const base = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
const until = async (predicate: () => boolean) => {
  const end = Date.now() + 5000;
  while (!predicate()) { assert.ok(Date.now() < end, "等待超时"); await new Promise((r) => setTimeout(r, 10)); }
};
const sockets: WebSocket[] = [];
try {
  for (const apiType of ["text", "chat"] as const) {
    config.providers[0].apiType = apiType; modelsRef.current = buildModels(config);
    const chat = store.createChat("向导", { name: "向导", is_user: false, is_system: false, mes: "开场白" });
    store.writeMetadata(chat.id, { variables: { value: "A" }, projection: "初始状态", custom: { preserved: true } });
    mode = "normal";
    await manager.send(chat.id, "{{setvar::value::{{getvar::value}}x}}问题");
    let snapshot = manager.snapshot(chat.id)!;
    assert.equal(snapshot.messages.length, 3);
    const firstAnswer = snapshot.messages.at(-1)!;
    assert.equal(snapshot.activity!.turns, 1);
    assert.equal(snapshot.activity!.totalGenerations, 1);
    assert.equal(snapshot.activity!.usage.totalTokens, 16);
    assert.equal(snapshot.activity!.records[0].context!.counting, "estimate");
    assert.equal(snapshot.activity!.records[0].context!.outputReserved, 500);
    if (apiType === "text") assert.equal(snapshot.activity!.records[0].context!.afterTokens,
      createTokenCounter("fixture").count(requests.at(-1).prompt), "文本补全预算必须覆盖实际 instruct 包装");
    const originalUser = snapshot.messages[1];
    assert.equal((store.readMetadata(chat.id).variables as any).value, "Ax");
    await manager.regenerate(chat.id, firstAnswer.id, firstAnswer.text);
    snapshot = manager.snapshot(chat.id)!;
    assert.equal(snapshot.messages.length, 3);
    assert.equal(snapshot.messages[1].id, originalUser.id);
    assert.notEqual(snapshot.messages.at(-1)!.text, firstAnswer.text);
    assert.ok(!JSON.stringify(requests.at(-1)).includes(firstAnswer.text));
    assert.equal((store.readMetadata(chat.id).variables as any).value, "Ax", "重生成须恢复本轮变量检查点");
    assert.deepEqual(store.readMetadata(chat.id).custom, { preserved: true });
    assert.equal(snapshot.replyChoices?.count, 2);
    assert.equal(snapshot.activity!.turns, 1);
    assert.equal(snapshot.activity!.totalGenerations, 2);
    assert.equal(snapshot.activity!.usage.totalTokens, 32);
    const secondAnswer = snapshot.messages.at(-1)!;
    assert.deepEqual(store.readChat(chat.id)!.at(-1)!.swipes, [firstAnswer.text, secondAnswer.text]);
    assert.equal(store.readChat(chat.id)!.at(-1)!.swipe_id, 1);
    const oldRevision = snapshot.page!.revision;
    manager.selectReply(chat.id, originalUser.id, 0, oldRevision);
    assert.equal(manager.snapshot(chat.id)!.messages.at(-1)!.text, firstAnswer.text);
    assert.throws(() => manager.selectReply(chat.id, originalUser.id, 1, oldRevision), /变化/);
    manager.selectReply(chat.id, originalUser.id, 1, manager.snapshot(chat.id)!.page!.revision);
    snapshot = manager.snapshot(chat.id)!;
    assert.equal(snapshot.messages.at(-1)!.text, secondAnswer.text);
    assert.equal(snapshot.activity!.usage.totalTokens, 32, "候选切换不回滚用量");
    const latest = snapshot.messages.at(-1)!;
    const original = fs.readFileSync(chat.file, "utf8");
    for (const failure of ["error", "empty"]) {
      mode = failure; await manager.regenerate(chat.id, latest.id, latest.text);
      assert.equal(fs.readFileSync(chat.file, "utf8"), original, failure + "必须保留原存档");
    }
    mode = "hold"; release = undefined;
    const pending = manager.regenerate(chat.id, latest.id, latest.text);
    await until(() => Boolean(release) && !!manager.snapshot(chat.id)?.streamingText);
    assert.equal(fs.readFileSync(chat.file, "utf8"), original, "流式期间不改原存档");
    assert.throws(() => manager.editMessage(chat.id, latest.id, "不允许", latest.text), /先停止/);
    assert.throws(() => manager.selectReply(chat.id, originalUser.id, 0, store.revisionId(chat.id)), /先停止/);
    assert.throws(() => manager.restoreBackup(chat.id, store.backups(chat.id).backups[0].id, store.revisionId(chat.id)), /先停止/);
    await manager.regenerate(chat.id, latest.id, latest.text);
    assert.equal(manager.isStreaming(chat.id), true, "重复请求不能解锁正在运行的回合");
    manager.abort(chat.id); await pending;
    assert.equal(fs.readFileSync(chat.file, "utf8"), original, "停止后保留原文和元数据");
    release = undefined;
    const externalPending = manager.regenerate(chat.id, latest.id, latest.text);
    await until(() => Boolean(release));
    fs.appendFileSync(chat.file, "\n"); const external = fs.readFileSync(chat.file, "utf8");
    release!(); await externalPending;
    assert.equal(fs.readFileSync(chat.file, "utf8"), external, "不能覆盖生成期间的外部修改");
    assert.ok(events.some((event) => event.type === "chat.error" && event.message.includes("修改")));
    console.log("✓ " + apiType + " 重生成：不重复用户消息、变量恢复、空响应/失败/停止回退、并发和外部冲突");

    for (const failure of ["error", "empty", "hold"]) {
      const failed = store.createChat("向导", null);
      const metadata = { variables: { value: "before" }, projection: "原投影", timedWorldInfo: {}, foreign: "保留" };
      store.writeMetadata(failed.id, metadata);
      mode = failure; release = undefined;
      const send = manager.send(failed.id, "{{setvar::value::{{getvar::value}}x}}失败后重试");
      if (failure === "hold") {
        await until(() => Boolean(release));
        assert.deepEqual(store.readMetadata(failed.id), metadata, "生成过程中状态不得提前落库");
        manager.abort(failed.id);
      }
      await send;
      assert.deepEqual(store.readMetadata(failed.id), metadata, failure + "不得推进状态");
      const failedSnapshot = manager.snapshot(failed.id)!;
      assert.equal(failedSnapshot.messages.length, 1, "失败保留用户输入，不保存助手半成品");
      assert.equal(failedSnapshot.replyChoices?.count, 0);
      mode = "normal";
      await manager.regenerate(failed.id, failedSnapshot.messages[0].id, failedSnapshot.messages[0].text);
      assert.equal(manager.snapshot(failed.id)!.messages.length, 2);
      assert.equal((store.readMetadata(failed.id).variables as any).value, "beforex");
    }
    console.log("✓ " + apiType + " 普通生成空响应/失败/停止：状态不变、保留输入、重试只执行一次宏");
    const cancelled = store.createChat("向导", null);
    mode = "usage-hold"; release = undefined;
    const cancelSend = manager.send(cancelled.id, "取消但保留回传用量");
    await until(() => Boolean(release) && !!manager.snapshot(cancelled.id)?.streamingText);
    // Let the local stream parser consume the usage-only frame before cancellation.
    await new Promise((resolve) => setTimeout(resolve, 30));
    manager.abort(cancelled.id); await cancelSend;
    assert.equal(manager.snapshot(cancelled.id)!.activity!.records[0].status, "aborted");
    assert.equal(manager.snapshot(cancelled.id)!.activity!.usage.totalTokens, 11, "停止后保留已回传用量");
    console.log("✓ " + apiType + " 生成次数/对话轮数独立、instruct 预算和停止前回传用量持久化");
  }

  config.contextMode = "takeover";
  const stateChat = store.createChat("向导", null);
  store.writeMetadata(stateChat.id, { projection: "回合开始前" });
  mode = "normal"; await manager.send(stateChat.id, "更新状态");
  const stateTarget = manager.snapshot(stateChat.id)!.messages.at(-1)!;
  const stateOriginal = fs.readFileSync(stateChat.file, "utf8");
  mode = "state-error"; await manager.regenerate(stateChat.id, stateTarget.id, stateTarget.text);
  assert.equal(fs.readFileSync(stateChat.file, "utf8"), stateOriginal, "状态工具成功但后续模型失败也必须整体回退");
  assert.equal(manager.snapshot(stateChat.id)!.projection, "回合开始前");
  assert.equal(manager.snapshot(stateChat.id)!.activity!.records[0].usage.totalTokens, 14, "后续失败不回滚先前模型调用的用量");
  assert.equal(manager.snapshot(stateChat.id)!.activity!.records[0].tools[0].status, "done");
  mode = "state-success"; await manager.regenerate(stateChat.id, stateTarget.id, stateTarget.text);
  assert.equal(manager.snapshot(stateChat.id)!.projection, "新状态投影");
  const activitySnapshot = manager.snapshot(stateChat.id)!;
  assert.equal(activitySnapshot.activity!.usage.totalTokens, 60);
  assert.equal(activitySnapshot.activity!.toolCounts.tavern_set_state, 2);
  assert.equal(activitySnapshot.activity!.records[0].context!.request, 2);
  const reloaded = new SessionManager(config, () => modelsRef.current, characters, new ChatStore(config.stDataDir), config.stDataDir);
  assert.deepEqual(reloaded.snapshot(stateChat.id)!.activity, activitySnapshot.activity, "重启恢复工具、用量和诊断");
  let activityState = chatReducer({}, { type: "chat.snapshot", chatId: stateChat.id, snapshot: activitySnapshot });
  for (const event of events.filter((event) => "chatId" in event && event.chatId === stateChat.id && event.type === "chat.activity")) {
    activityState = chatReducer(activityState, event);
    activityState = chatReducer(activityState, event);
  }
  assert.equal(activityState[stateChat.id].usage.totalTokens, 60, "迟到/重复活动事件不重复累计");
  activityState = chatReducer(activityState, { type: "chat.usage", chatId: stateChat.id, input: 100, output: 100, totalTokens: 200, costTotal: 0 });
  assert.equal(activityState[stateChat.id].usage.totalTokens, 60, "持久化快照和旧增量事件不能重复计数");
  const activityPage = await (await fetch(base + "/api/chat/activity?" + new URLSearchParams({ chatId: stateChat.id }))).json() as any;
  assert.equal(activityPage.records.length, 3);
  assert.equal(manager.snapshot(stateChat.id)!.messages.length, 2);
  const stateChoices = manager.snapshot(stateChat.id)!;
  manager.selectReply(stateChat.id, stateChoices.replyChoices!.userMessageId, 0, stateChoices.page!.revision);
  assert.equal(manager.snapshot(stateChat.id)!.projection, "回合开始前", "切换候选须同时还原状态");
  manager.selectReply(stateChat.id, stateChoices.replyChoices!.userMessageId, 1, manager.snapshot(stateChat.id)!.page!.revision);
  assert.equal(manager.snapshot(stateChat.id)!.projection, "新状态投影");
  const backupBeforeActivityRestore = store.backups(stateChat.id).backups.at(-1)!;
  manager.restoreBackup(stateChat.id, backupBeforeActivityRestore.id, store.revisionId(stateChat.id));
  assert.equal(manager.snapshot(stateChat.id)!.activity!.usage.totalTokens, 60, "备份恢复不回滚已经发生的用量");
  console.log("✓ 重生成工具记录、失败消耗、重启/刷新恢复、重复事件、记录 HTTP 与备份恢复后的累计用量");
  const failedState = store.createChat("向导", null);
  store.writeMetadata(failedState.id, { projection: "原状态", variables: { count: "0" } });
  mode = "state-error"; await manager.send(failedState.id, "普通回合工具失败");
  assert.deepEqual(store.readMetadata(failedState.id), { projection: "原状态", variables: { count: "0" } });
  assert.equal(manager.snapshot(failedState.id)!.messages.length, 1);
  config.contextMode = "simple";
  console.log("✓ 接管模式工具结算：回复成功才提交状态，后续失败不污染投影");

  const imported = store.createChat("向导", null);
  const header = { user_name: "旅人", character_name: "向导", unknown_header: 7, chat_metadata: { variables: { keep: 5 }, projection: "旧投影", timedWorldInfo: {}, foreign: true } };
  const user = { name: "旅人", is_user: true, mes: "旧问题", foreign_message: { x: 1 } };
  const assistant = { name: "向导", is_user: false, mes: "旧回答", swipe_id: 1, swipes: ["候选一", "旧回答"],
    swipe_info: [{ extra: {} }, { extra: { summary: "过期", retained: 9 } }], extra: { summary: "过期", custom: 4 } };
  fs.writeFileSync(imported.file, [JSON.stringify(header), JSON.stringify(user), "broken-line-retained", JSON.stringify(assistant)].join("\n"));
  let snapshot = manager.snapshot(imported.id)!; const target = snapshot.messages.at(-1)!;
  const beforeEdit = fs.readFileSync(imported.file, "utf8");
  const edit = (text: string, expectedText = target.text) => fetch(base + "/api/chat/message", { method: "PATCH",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId: imported.id, messageId: target.id, text, expectedText }) });
  assert.equal((await edit("修改后的 **回答**")).status, 200);
  const raw = fs.readFileSync(imported.file, "utf8"); const saved = JSON.parse(raw.split("\n")[3]);
  assert.ok(raw.includes("broken-line-retained"));
  assert.deepEqual(saved.swipes, ["候选一", "修改后的 **回答**"]);
  assert.equal(saved.swipe_info[1].extra.retained, 9); assert.equal(saved.swipe_info[1].extra.summary, undefined);
  assert.equal(saved.extra.summary, undefined); assert.equal(saved.extra.custom, 4);
  assert.equal(JSON.parse(raw.split("\n")[0]).unknown_header, 7);
  assert.equal(store.readMetadata(imported.id).projection, undefined);
  assert.equal(store.readMetadata(imported.id).timedWorldInfo, undefined);
  assert.deepEqual(store.readMetadata(imported.id).variables, { keep: 5 });
  assert.equal((await edit("冲突编辑")).status, 409);
  assert.equal((await edit("   ")).status, 400);
  const backupRoot = path.join(config.stDataDir, ".pitavern/backups");
  const backups = fs.readdirSync(backupRoot, { recursive: true }).filter((f) => String(f).endsWith(".jsonl"));
  assert.ok(backups.some((f) => fs.readFileSync(path.join(backupRoot, String(f)), "utf8") === beforeEdit));
  snapshot = manager.snapshot(imported.id)!;
  const current = snapshot.messages.at(-1)!;
  const rename = fs.renameSync;
  fs.renameSync = () => { throw new Error("模拟磁盘失败"); };
  try { assert.throws(() => manager.editMessage(imported.id, current.id, "不能写入", current.text), /磁盘失败/); }
  finally { fs.renameSync = rename; }
  assert.equal(fs.readFileSync(imported.file, "utf8"), raw);
  store.appendMessage(imported.id, { name: "旅人", is_user: true, is_system: false, mes: "无尾换行后追加" });
  assert.equal(store.readChat(imported.id)!.length, 3);
  assert.equal(new ChatStore(config.stDataDir).readChat(imported.id)!.length, 3);
  console.log("✓ 消息编辑 HTTP、冲突拒绝、ST 未知字段/swipes、损坏行保留、备份及原子写入失败保护");

  const preserved = store.createChat("向导", null);
  store.appendMessage(preserved.id, { name: "旅人", is_user: true, is_system: false, mes: "保留注释" });
  fs.appendFileSync(preserved.file, 'broken-after-user\n' + JSON.stringify({ name: "注释", is_system: true, mes: "不要删除的备注" }) + "\n");
  store.appendMessage(preserved.id, { name: "向导", is_user: false, is_system: false, mes: "待替换回复" });
  const preservedTarget = manager.snapshot(preserved.id)!.messages.at(-1)!;
  mode = "normal"; await manager.regenerate(preserved.id, preservedTarget.id, preservedTarget.text);
  const preservedRaw = fs.readFileSync(preserved.file, "utf8");
  assert.ok(preservedRaw.includes("broken-after-user") && preservedRaw.includes("不要删除的备注"));
  assert.ok(!manager.snapshot(preserved.id)!.messages.some((message) => message.text === "待替换回复"));
  assert.ok(preservedRaw.includes("待替换回复"), "旧回复保留在候选版本中");
  console.log("✓ 重生成保留原版系统注释及本轮损坏/未知行");

  const multi = store.createChat("向导", null);
  const multiUser = store.appendMessage(multi.id, { name: "旅人", is_user: true, is_system: false, mes: "多段回复" });
  store.appendMessage(multi.id, { name: "向导", is_user: false, is_system: false, mes: "旧第一段" });
  const multiLast = store.appendMessage(multi.id, { name: "向导", is_user: false, is_system: false, mes: "旧第二段" });
  store.writeMetadata(multi.id, { variables: { value: "旧值" }, custom: "保留" });
  store.prepareRegeneration(multi.id, String(multiLast.extra!.messageId), multiLast.mes).commit([
    { ...multiLast, mes: "新第一段", extra: { messageId: "new-part-1" } },
    { ...multiLast, mes: "新第二段", extra: { messageId: "new-part-2" } },
  ], { variables: { value: "新值" }, custom: "保留" });
  manager.selectReply(multi.id, String(multiUser.extra!.messageId), 0, store.revisionId(multi.id));
  assert.deepEqual(manager.snapshot(multi.id)!.messages.slice(1).map((m) => m.text), ["旧第一段", "旧第二段"]);
  assert.equal((store.readMetadata(multi.id).variables as any).value, "旧值");
  manager.selectReply(multi.id, String(multiUser.extra!.messageId), 1, store.revisionId(multi.id));
  manager.editMessage(multi.id, "new-part-2", "编辑后的候选", "新第二段");
  manager.selectReply(multi.id, String(multiUser.extra!.messageId), 0, store.revisionId(multi.id));
  manager.selectReply(multi.id, String(multiUser.extra!.messageId), 1, store.revisionId(multi.id));
  assert.equal(manager.snapshot(multi.id)!.messages.at(-1)!.text, "编辑后的候选");
  const restoredStore = new ChatStore(config.stDataDir);
  const restoredManager = new SessionManager(config, () => modelsRef.current, characters, restoredStore, config.stDataDir);
  assert.equal(restoredManager.snapshot(multi.id)!.replyChoices?.count, 2, "重启保留多段候选");
  console.log("✓ 多段候选、对应变量、候选编辑和重启恢复");

  const native = store.createChat("向导", null);
  const nativeUser = store.appendMessage(native.id, { name: "旅人", is_user: true, is_system: false, mes: "原版候选" });
  store.appendMessage(native.id, { name: "向导", is_user: false, is_system: false, mes: "原版二", swipes: ["原版一", "原版二"], swipe_id: 1,
    swipe_info: [{ extra: { thinking: "候选一的思考" } }, { extra: { thinking: "候选二的思考" } }], extra: { thinking: "候选二的思考" } });
  const nativeResponse = await fetch(base + "/api/chat/reply", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chatId: native.id, userMessageId: nativeUser.extra!.messageId, selected: 0, revision: store.revisionId(native.id) }) });
  assert.equal(nativeResponse.status, 200);
  assert.equal(manager.snapshot(native.id)!.messages.at(-1)!.text, "原版一");
  assert.equal(manager.snapshot(native.id)!.messages.at(-1)!.thinking, "候选一的思考");
  assert.equal(store.readChat(native.id)!.at(-1)!.swipe_id, 0);
  console.log("✓ 原版 swipes 导入、候选思考隔离、切换 HTTP 和单段候选原版字段导出");

  const recover = store.createChat("向导", null);
  const recoverUser = store.appendMessage(recover.id, { name: "旅人", is_user: true, is_system: false, mes: "恢复前原文" });
  fs.appendFileSync(recover.file, "retained-malformed-line\n");
  const recoverOriginal = fs.readFileSync(recover.file, "utf8");
  manager.editMessage(recover.id, String(recoverUser.extra!.messageId), "修改后的文本", "恢复前原文");
  const recoveryList = await (await fetch(base + "/api/chat/backups?" + new URLSearchParams({ chatId: recover.id }))).json() as any;
  assert.equal(recoveryList.backups.length, 1);
  const backupId = recoveryList.backups[0].id;
  const preview = await (await fetch(base + "/api/chat/backup?" + new URLSearchParams({ chatId: recover.id, backupId }))).json() as any;
  assert.equal(preview.messages[0].text, "恢复前原文");
  const beforeRestore = fs.readFileSync(recover.file, "utf8");
  const restoreResponse = await fetch(base + "/api/chat/backup/restore", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chatId: recover.id, backupId, revision: preview.revision }) });
  assert.equal(restoreResponse.status, 200);
  assert.equal(fs.readFileSync(recover.file, "utf8"), recoverOriginal, "恢复保留原始损坏行和格式");
  assert.equal(store.backups(recover.id).backups.length, 2);
  assert.ok(store.backups(recover.id).backups.some((b) => fs.readFileSync(path.join(config.stDataDir, ".pitavern/backups", createHash("sha256").update(recover.id).digest("hex"), b.id), "utf8") === beforeRestore));
  assert.throws(() => manager.restoreBackup(recover.id, backupId, preview.revision), /变化/);
  console.log("✓ 备份列表、预览、恢复、恢复前再次备份及过期预览拒绝");

  const longChat = store.createChat("向导", null);
  const longHeader = fs.readFileSync(longChat.file, "utf8").trim();
  const longLines = Array.from({ length: 1200 }, (_, index) => ({ name: index % 2 ? "向导" : "旅人", is_user: index % 2 === 0,
    is_system: false, send_date: "", mes: "历史消息 " + index, extra: { messageId: "history-" + index } }));
  fs.writeFileSync(longChat.file, longHeader + "\n" + longLines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  const tail = manager.snapshot(longChat.id)!;
  assert.equal(tail.messages.length, 80); assert.equal(tail.page!.total, 1200); assert.equal(tail.page!.before, 1120);
  let longState = chatReducer({}, { type: "chat.snapshot", chatId: longChat.id, snapshot: tail });
  const historyPage = await (await fetch(base + "/api/chat/history?" + new URLSearchParams({ chatId: longChat.id, before: "1120", revision: tail.page!.revision }))).json() as any;
  assert.equal(historyPage.messages[0].id, "history-1040");
  longState = chatReducer(longState, { type: "history.page", chatId: longChat.id, before: 1120, page: historyPage });
  assert.equal(longState[longChat.id].items.length, 160);
  assert.equal(chatReducer(longState, { type: "history.page", chatId: longChat.id, before: 1120, page: historyPage }), longState, "重复页不得再次插入");
  const exportText = await (await fetch(base + "/api/chats/" + longChat.id.split("/").map(encodeURIComponent).join("/") + "/export?format=md")).text();
  assert.ok(exportText.includes("历史消息 0\n") && exportText.includes("历史消息 1199"), "导出保持全量");
  store.appendMessage(longChat.id, { name: "旅人", is_user: true, is_system: false, mes: "新消息" });
  assert.throws(() => store.page(longChat.id, 1120, tail.page!.revision), /变化/);
  const refreshed = manager.snapshot(longChat.id)!;
  const resetState = chatReducer(longState, { type: "chat.snapshot", chatId: longChat.id, snapshot: refreshed });
  assert.equal(chatReducer(resetState, { type: "history.page", chatId: longChat.id, before: 1040, page: { ...historyPage, before: 960 } }), resetState, "迟到旧页不得污染新快照");
  const appended = chatReducer(longState, { type: "chat.snapshot", chatId: longChat.id, snapshot: refreshed, append: true });
  assert.equal(appended[longChat.id].items.length, 161); assert.equal(appended[longChat.id].page!.before, 1040);
  console.log("✓ 1200 条聊天分页、旧页/重复页处理、增量保留已加载历史、完整导出");

  const wsEvents: ServerEvent[][] = [[], []];
  for (let i = 0; i < 2; i++) {
    const ws = new WebSocket(base.replace("http:", "ws:") + "/ws"); sockets.push(ws);
    ws.on("message", (data) => wsEvents[i].push(JSON.parse(String(data)))); await once(ws, "open");
  }
  const last = manager.snapshot(imported.id)!.messages.at(-1)!;
  mode = "normal";
  sockets[0].send(JSON.stringify({ type: "chat.regenerate", chatId: imported.id, messageId: last.id, expectedText: last.text }));
  await until(() => wsEvents.every((list) => list.some((event) => event.type === "chat.finished")));
  assert.ok(wsEvents.every((list) => list.some((event) => event.type === "chat.regenerating")));
  assert.equal(manager.snapshot(imported.id)!.messages.filter((m) => m.role === "user").length, 2);
  assert.ok(wsEvents.every((list) => list.some((event) => event.type === "chat.snapshot" && !event.snapshot.running)));
  sockets[0].send("null"); sockets[0].send(JSON.stringify({ type: "ping" }));
  await until(() => wsEvents[0].some((event) => event.type === "pong"));
  const state = chatReducer({}, { type: "chat.snapshot", chatId: imported.id, snapshot: manager.snapshot(imported.id)! });
  const running = chatReducer(state, { type: "chat.regenerating", chatId: imported.id });
  assert.equal(running[imported.id].items.length, state[imported.id].items.length);
  assert.equal(running[imported.id].streamingText, "");
  const connectionResponse = await fetch(base + "/api/connection", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ worldInfo: { scanDepth: 0 } }) });
  assert.equal(connectionResponse.status, 200); assert.equal(config.worldInfo.scanDepth, 0);
  console.log("✓ 双窗口 WS 同步、失败回复重试、前端不重复插入用户消息及零深度设置往返");

  const failingActivity = store.createChat("向导", null);
  const renameActivity = fs.renameSync;
  const requestsBeforeDiskFailure = requests.length;
  fs.renameSync = (source, destination) => {
    if (String(destination).includes(path.join(".pitavern", "activity"))) throw new Error("模拟记录写入失败");
    return renameActivity(source, destination);
  };
  try {
    await manager.send(failingActivity.id, "记录存储暂不可写");
    assert.equal(manager.isStreaming(failingActivity.id), false);
    assert.equal(requests.length, requestsBeforeDiskFailure, "无法开始记录时不发出模型请求");
    assert.ok(manager.snapshot(failingActivity.id)!.activityError?.includes("保存失败"));
    assert.equal(events.at(-1)?.type, "chat.finished", "记录写入失败仍须结束回合");
  } finally { fs.renameSync = renameActivity; }

  const connection = await (await fetch(base + "/api/connection")).json() as any;
  connection.providers[0].models[0].tokenizer = "cl100k_base";
  connection.providers[0].models[0].contextWindow = 30;
  connection.providers[0].models[0].maxTokens = 20;
  assert.equal((await fetch(base + "/api/connection", { method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ providers: connection.providers }) })).status, 200);
  const savedConnection = await (await fetch(base + "/api/connection")).json() as any;
  assert.equal(savedConnection.providers[0].models[0].tokenizer, "cl100k_base");
  const overBudgetChat = store.createChat("向导", null);
  const requestsBeforeBudget = requests.length;
  await manager.send(overBudgetChat.id, "预算检查");
  assert.equal(requests.length, requestsBeforeBudget);
  const budgetRun = manager.snapshot(overBudgetChat.id)!.activity!.records[0];
  assert.equal(budgetRun.status, "failed"); assert.equal(budgetRun.context!.overBudget, true);
  assert.equal(budgetRun.context!.tokenizer, "cl100k_base"); assert.equal(budgetRun.context!.outputReserved, 20);
  console.log("✓ 记录写入故障仍能结束回合、模型计数设置往返、超预算诊断持久化且不访问模型");
} finally {
  for (const socket of sockets) socket.terminate();
  for (const chat of store.listChats()) manager.abort(chat.id);
  server.closeAllConnections(); server.close(); mock.closeAllConnections(); mock.close();
}
console.log("聊天体验验证通过；记录保留：" + runDir);
