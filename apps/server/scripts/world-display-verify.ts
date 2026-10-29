/** Synthetic fixtures only; keep the run directory for inspecting persistence and requests. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { AuthorNoteDto, AuthorNoteSnapshotDto, ChatSnapshotDto, ServerEvent } from "@pitavern/shared";
import { normalizeWorldFile, normalizeCardBook, scanWorldInfo, emptyTimedState } from "../src/context/worldinfo.ts";
import { assembleBridgeContext, type BridgeInput } from "../src/context/bridge.ts";
import { normalizeCard } from "../src/stdata/types.ts";
import { applyRegex, type RegexScript } from "../src/context/regex.ts";
import { displayMessage } from "../../web/src/messageDisplay.ts";
import { chatReducer } from "../../web/src/chatState.ts";

const options = { scanDepth: 2, recursionSteps: 0, caseSensitive: false, matchWholeWords: false };
const entries = (raw: Record<string, Record<string, unknown>>) => normalizeWorldFile({ entries: Object.fromEntries(Object.entries(raw)
  .map(([id, entry]) => [id, { key: ["旅馆"], content: id, group: "scene", ...entry }])) }, "synthetic");
const scan = (raw: Record<string, Record<string, unknown>>, extra = {}) => scanWorldInfo(entries(raw), ["旅馆 森林"], { ...options, ...extra });
const ids = (result: ReturnType<typeof scan>) => result.activated.map((entry) => entry.uid).sort();
const originalRandom = Math.random;
try {
  Math.random = () => 0.5;
  assert.deepEqual(ids(scan({ zero: { groupWeight: 0 }, chosen: { groupWeight: 100 } })), ["chosen"]);
  assert.deepEqual(ids(scan({ a: { groupWeight: 1 }, b: { groupWeight: 3 } })), ["b"]);
  assert.deepEqual(ids(scan({ a: { groupOverride: true, order: 20 }, b: { groupOverride: true, order: 80 }, c: { order: 1000 } })), ["b"]);
  const scored = scan({ a: { useGroupScoring: true, groupOverride: true }, b: { key: ["旅馆", "森林"], useGroupScoring: true } });
  assert.deepEqual(ids(scored), ["b"]); assert.match(scored.decisions[0].reason, /得分/);
  assert.deepEqual(ids(scan({ a: { useGroupScoring: false, groupOverride: true }, b: { key: ["旅馆", "森林"] } }, { useGroupScoring: true })), ["a"]);
  assert.deepEqual(ids(scan({ a: { groupOverride: true }, b: { keysecondary: ["森林"], selectiveLogic: 0 } }, { useGroupScoring: true })), ["b"]);
  assert.deepEqual(ids(scan({ a: { groupOverride: true }, b: { keysecondary: ["森林", "missing"], selectiveLogic: 1 } }, { useGroupScoring: true })), ["a"]);
  assert.deepEqual(ids(scan({ both: { group: "A, B", groupOverride: true }, a: { group: "A" }, b: { group: "B" } })), ["both"]);
  assert.deepEqual(ids(scan({ a: { group: "A", groupOverride: true }, both: { group: "A, B" }, b: { group: "B" } })), ["a", "b"]);
  const recursive = scan({ winner: { content: "解锁" }, loser: { key: ["解锁"] }, other: { key: ["解锁"], group: "" } }, { recursionSteps: 2 });
  assert.deepEqual(ids(recursive), ["other", "winner"]); assert.match(recursive.decisions[1].reason, /已有/);
  const probability = scan({ a: { groupOverride: true, probability: 0 }, b: {} });
  assert.deepEqual(ids(probability), []); assert.match(probability.decisions[0].reason, /概率/);
  assert.deepEqual(ids(scan({ a: { groupOverride: true, content: "超出预算的内容" }, b: {} }, { budgetTokens: 1 })), []);
  const stickyEntries = entries({ sticky: { key: ["missing"], probability: 0 }, other: { groupOverride: true } });
  const timed = emptyTimedState(); timed.sticky["synthetic/sticky"] = { start: 0, end: 10 };
  assert.deepEqual(ids(scanWorldInfo(stickyEntries, ["旅馆"], { ...options, timed, messageCount: 2 })), ["sticky"]);
  const expanded = scanWorldInfo(entries({ a: {}, b: { key: ["old"] } }), ["old", "旅馆"], { ...options, scanDepth: 1, minActivations: 2 });
  assert.equal(expanded.activated.length, 1);
} finally { Math.random = originalRandom; }
const embedded = normalizeCardBook({ entries: [{ keys: ["旅馆"], content: "卡内资料", extensions: {
  position: 7, outlet_name: "notes", group: "a,b", group_override: true, group_weight: 42, use_group_scoring: true,
} }] }, "embedded")[0];
assert.equal(embedded.position, 7); assert.equal(embedded.outletName, "notes"); assert.equal(embedded.group, "a,b");
assert.equal(embedded.groupOverride, true); assert.equal(embedded.groupWeight, 42); assert.equal(embedded.useGroupScoring, true);
console.log("✓ 分组权重、覆盖顺序、评分继承、多组、sticky、递归占用、概率与预算、卡内字段");

const markers = ["worldInfoBefore", "chatHistory"];
const bridge: BridgeInput = {
  card: normalizeCard("chara_card_v2", { name: "向导" }, ""), persona: { name: "旅人", description: "" },
  preset: { prompts: [...markers.map((identifier) => ({ identifier, role: "system" as const, content: "", marker: true })),
    { identifier: "outlets", role: "system", content: "地图：{{outlet:: map }}。未知：{{outlet::missing}}。再次：{{outlet::map}}" }],
  prompt_order: [{ character_id: 100001, order: [...markers, "outlets"].map((identifier) => ({ identifier, enabled: true })) }] },
  chatLines: [{ name: "旅人", is_user: true, is_system: false, send_date: "", mes: "旅馆" }],
  worldEntries: entries({
    a: { group: "", constant: true, position: 7, outletName: "map", order: 10, content: "{{setvar::visits::{{getvar::visits}}x}}东门" },
    b: { group: "", constant: true, position: 7, outletName: "map", order: 20, content: "西门" },
    c: { group: "", constant: true, position: 7, outletName: "unused", content: "未引用出口" },
    d: { group: "", constant: true, position: 7, content: "无名出口" },
  }), regexScripts: [], options,
  variables: { visits: "" }, metadata: { note_prompt: "注释：{{outlet::map}}", note_role: 1, note_depth: 0 },
};
const assembled = assembleBridgeContext(bridge);
const text = JSON.stringify(assembled.messages);
assert.ok(text.includes("西门\\n东门")); assert.ok(!text.includes("未引用出口") && !text.includes("无名出口"));
assert.ok(!text.includes("{{outlet")); assert.equal(bridge.variables!.visits, "x", "预览和多次引用不重复写变量");
assert.match(assembled.worldInfo[0].reason, /已引用/); assert.match(assembled.worldInfo[2].reason, /未被/);
assert.match(assembled.worldInfo[3].reason, /名称为空/);
assert.ok(assembled.messages.some((message) => message.role === "user" && typeof message.content === "string" && message.content.startsWith("注释：")));
console.log("✓ Outlet 命名、排序、重复引用、缺失名称、作者注释引用和无重复变量写入");

const script = (patch: Partial<RegexScript> = {}): RegexScript => ({ findRegex: "/<label>(.*?)<\\/label>/gs", replaceString: "**$1**", placement: [2], markdownOnly: true, ...patch });
const display = { char: "A.B", user: "旅人", variables: { flag: "原值" }, scripts: [script()] };
assert.equal(displayMessage("<label>正文</label>", 2, 0, display), "**正文**");
assert.equal(applyRegex("<label>正文</label>", display.scripts, { placement: 2, depth: 0 }), "<label>正文</label>");
assert.equal(displayMessage("<label>正文</label>", 1, 0, display), "<label>正文</label>");
assert.equal(displayMessage("<label>流式片段", 2, 0, display), "<label>流式片段");
assert.equal(displayMessage("<label>正文</label>", 2, 0, { ...display, scripts: [script({ markdownOnly: false, promptOnly: true })] }), "<label>正文</label>");
assert.equal(displayMessage("<label>正文</label>", 2, 0, { ...display, scripts: [script({ promptOnly: true })] }), "**正文**");
assert.equal(displayMessage("<label>正文</label>", 2, 1, { ...display, scripts: [script({ maxDepth: 0 })] }), "<label>正文</label>");
assert.equal(displayMessage("<label>正文</label>", 2, 9, { ...display, scripts: [script({ maxDepth: -1 })] }), "**正文**");
assert.equal(displayMessage("x", 2, 0, { ...display, scripts: [script({ findRegex: "x", replaceString: "{{setvar::flag::修改}} {{getvar::flag}}" })] }), " 原值");
assert.equal(display.variables.flag, "原值");
assert.equal(displayMessage("A.B A0B", 2, 0, { ...display, scripts: [script({ findRegex: "/{{char}}/g", replaceString: "{{user}}", substituteRegex: 2 })] }), "旅人 A0B");
assert.equal(displayMessage("<label>trim hello</label>", 2, 0, { ...display, scripts: [script({ replaceString: "$0 / {{match}} / $1", trimStrings: ["trim "] })] }), "<label>hello</label> / <label>hello</label> / hello");
assert.equal(displayMessage("word", 2, 0, { ...display, scripts: [script({ findRegex: "/(?<word>word)/", replaceString: "$<word>!" })] }), "word!");
assert.equal(displayMessage("正文", 2, 0, { ...display, scripts: [script({ findRegex: "[" })] }), "正文");
console.log("✓ 显示/提示词隔离、角色与深度门控、流式片段、只读宏、捕获替换和坏正则容错");

const root = path.resolve(import.meta.dirname, "../../..");
fs.mkdirSync(path.join(root, "data/test-runs"), { recursive: true });
const runDir = fs.mkdtempSync(path.join(root, "data/test-runs/world-display-"));
process.env.PITAVERN_CONFIG = path.join(runDir, "config.json");
const { defaultConfig, seedDataDirs } = await import("../src/config.ts");
const { ChatStore } = await import("../src/stdata/chats.ts");
const { CharacterStore } = await import("../src/stdata/characters.ts");
const { buildModels } = await import("../src/providers/models.ts");
const { SessionManager } = await import("../src/session/manager.ts");
const { createHttpApp } = await import("../src/api/http.ts");
const { attachWebSocket } = await import("../src/api/ws.ts");
const requests: any[] = [];
let held = false;
let release: (() => void) | undefined;
const mock = http.createServer(async (req, res) => {
  let raw = ""; for await (const chunk of req) raw += chunk;
  requests.push(JSON.parse(raw)); fs.writeFileSync(path.join(runDir, `request-${requests.length}.json`), raw);
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const frame = (delta: object, finish_reason: string | null) => "data: " + JSON.stringify({ id: "synthetic", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason }] }) + "\n\n";
  res.write(frame({ role: "assistant", content: "<label>本地回复</label>" }, null));
  const finish = () => res.end(frame({}, "stop") + "data: [DONE]\n\n");
  if (held) release = finish; else finish();
});
mock.listen(0, "127.0.0.1"); await once(mock, "listening");
const config = defaultConfig(); config.stDataDir = path.join(runDir, "st"); seedDataDirs(config.stDataDir);
config.contextMode = "bridge"; config.activePreset = "fixture"; config.toolsEnabled = false;
config.providers = [{ id: "fixture", name: "本地验证", baseUrl: `http://127.0.0.1:${(mock.address() as AddressInfo).port}/v1`, apiKey: "synthetic",
  models: [{ id: "fixture", name: "本地模型", contextWindow: 8000, maxTokens: 500 }] }];
config.defaultProvider = "fixture"; config.defaultModel = "fixture";
fs.writeFileSync(path.join(config.stDataDir, "characters/fixture.json"), JSON.stringify({ name: "向导", extensions: { regex_scripts: [script({ placement: [1], findRegex: "旅馆", replaceString: "**旅馆**" })] } }));
fs.writeFileSync(path.join(config.stDataDir, "OpenAI Settings/fixture.json"), JSON.stringify({ ...bridge.preset, extensions: { regex_scripts: [null, script(), { findRegex: false }] } }));
const store = new ChatStore(config.stDataDir), characters = new CharacterStore(path.join(config.stDataDir, "characters"));
const modelsRef = { current: buildModels(config) };
const manager = new SessionManager(config, () => modelsRef.current, characters, store, config.stDataDir);
const events: ServerEvent[] = []; manager.onEvent((event) => events.push(event));
const server = http.createServer(createHttpApp({ config, modelsRef, characters, chats: store, sessions: manager, stDataDir: config.stDataDir,
  webDistDir: process.argv.includes("--preview") ? path.join(root, "apps/web/dist") : null }));
attachWebSocket(server, manager); server.listen(0, "127.0.0.1"); await once(server, "listening");
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
try {
  const chat = store.createChat("向导", { name: "向导", is_user: false, is_system: false, mes: "<label>欢迎来到旅馆</label>" });
  store.writeMetadata(chat.id, { unknown: { retained: true }, variables: { flag: "原值" } });
  fs.appendFileSync(chat.file, 'unparsed-import-line\n');
  const getNote = () => fetch(base + "/api/chat/author-note?" + new URLSearchParams({ chatId: chat.id })).then((response) => response.json() as Promise<AuthorNoteSnapshotDto>);
  const putNote = (note: AuthorNoteDto, revision: string) => fetch(base + "/api/chat/author-note", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId: chat.id, note, revision }) });
  const initial = await getNote();
  assert.equal(initial.note.interval, 1); assert.equal(initial.note.depth, 4);
  const note: AuthorNoteDto = { text: "保持简洁，{{char}}。", interval: 1, depth: 0, position: 1, role: "user" };
  assert.equal((await putNote({ ...note, interval: -1 }, initial.revision)).status, 400);
  assert.equal((await putNote(note, initial.revision)).status, 200);
  assert.deepEqual((await getNote()).note, note);
  assert.equal(store.readMetadata(chat.id).note_role, 1);
  assert.deepEqual(store.readMetadata(chat.id).unknown, { retained: true });
  assert.ok(fs.readFileSync(chat.file, "utf8").includes("unparsed-import-line"));
  assert.equal(store.backups(chat.id).backups.length, 1);
  assert.equal((await putNote({ ...note, text: "旧窗口" }, initial.revision)).status, 409);
  assert.ok(events.some((event) => event.type === "chat.snapshot" && event.chatId === chat.id));
  const reloaded = new SessionManager(config, () => modelsRef.current, characters, new ChatStore(config.stDataDir), config.stDataDir);
  assert.deepEqual(reloaded.authorNote(chat.id).note, note);
  const snapshot = manager.snapshot(chat.id)!;
  assert.equal(snapshot.display!.scripts.length, 2, "预设与角色卡正则来源一致且跳过坏条目");
  assert.equal(snapshot.messages[0].text, "<label>欢迎来到旅馆</label>");
  assert.equal(displayMessage(snapshot.messages[0].text, 2, 0, snapshot.display), "**欢迎来到旅馆**");
  const state = chatReducer({}, { type: "chat.snapshot", chatId: chat.id, snapshot });
  assert.deepEqual(state[chat.id].display, snapshot.display);
  const streaming = chatReducer(state, { type: "chat.started", chatId: chat.id, startedAt: new Date().toISOString(),
    message: { id: "synthetic-new", role: "user", name: "旅人", text: "新问题", sendDate: "" } });
  assert.equal(streaming[chat.id].display!.lastUserMessage, "新问题", "流式显示宏应看到本轮问题");
  await manager.send(chat.id, "旅馆");
  assert.ok(JSON.stringify(requests[0]).includes("保持简洁，向导。"));
  assert.ok(JSON.stringify(requests[0]).includes("<label>欢迎来到旅馆</label>"), "显示替换不污染模型上下文");
  const exports = await (await fetch(base + "/api/chats/" + chat.id.split("/").map(encodeURIComponent).join("/") + "/export?format=md")).text();
  assert.ok(exports.includes("<label>本地回复</label>"), "导出使用原文");
  const saved = await getNote();
  assert.equal((await putNote({ ...note, interval: 0 }, saved.revision)).status, 200);
  await manager.send(chat.id, "下一轮");
  assert.ok(!JSON.stringify(requests[1]).includes("保持简洁，向导。"));
  held = true;
  const generating = manager.send(chat.id, "生成中");
  while (!release) await new Promise((resolve) => setTimeout(resolve, 10));
  const running = await getNote();
  assert.equal((await putNote(note, running.revision)).status, 409);
  release(); await generating; held = false;
  const setting = await fetch(base + "/api/connection", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ worldInfo: { useGroupScoring: true } }) });
  assert.equal(setting.status, 200); assert.equal(config.worldInfo.useGroupScoring, true);
  const final = manager.snapshot(chat.id)!;
  fs.writeFileSync(path.join(runDir, "snapshot.json"), JSON.stringify(final, null, 2));
  console.log("✓ 作者注释 API、参数校验、冲突与生成锁、自动备份、重启、显示同步、原文导出与实际请求");
  console.log("测试产物：" + runDir);
  if (process.argv.includes("--preview")) {
    const preview = { url: base, chatId: chat.id, pid: process.pid, runDir };
    fs.writeFileSync(path.join(runDir, "preview.json"), JSON.stringify(preview));
    console.log(JSON.stringify(preview));
    await new Promise<void>((resolve) => process.on("SIGTERM", () => resolve()));
  }
} finally {
  server.closeAllConnections(); server.close(); mock.closeAllConnections(); mock.close();
}
