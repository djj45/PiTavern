/** Synthetic opening pages, portable ST swipes and local model request verification. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { chatReducer } from "../../web/src/chatState.ts";
import { normalizeCard } from "../src/stdata/types.ts";
import { greetingCatalog } from "../src/stdata/greetings.ts";

const root = path.resolve(import.meta.dirname, "../../..");
fs.mkdirSync(path.join(root, "data/test-runs"), { recursive: true });
const runDir = fs.mkdtempSync(path.join(root, "data/test-runs/greetings-"));
process.env.PITAVERN_CONFIG = path.join(runDir, "config.json");
const { defaultConfig, seedDataDirs } = await import("../src/config.ts");
const { buildModels } = await import("../src/providers/models.ts");
const { CharacterStore } = await import("../src/stdata/characters.ts");
const { ChatStore } = await import("../src/stdata/chats.ts");
const { SessionManager } = await import("../src/session/manager.ts");
const { createHttpApp } = await import("../src/api/http.ts");
const config = defaultConfig();
config.stDataDir = path.join(runDir, "st"); seedDataDirs(config.stDataDir);
config.toolsEnabled = false;
const cardData = { name: "开局向导", description: "合成向导", first_mes: "自选开局\n" + Array.from({ length: 8 }, (_, i) => `${i + 1}.合成场景${i + 1}`).join("\n"),
  alternate_greetings: Array.from({ length: 8 }, (_, i) => `开场正文${i + 1}：{{user}}抵达地点${i + 1}。`) };
const cardFile = path.join(config.stDataDir, "characters/guide.json");
fs.writeFileSync(cardFile, JSON.stringify(cardData));
const cardBefore = fs.readFileSync(cardFile, "utf8");
fs.writeFileSync(path.join(config.stDataDir, "OpenAI Settings/openings.json"), JSON.stringify({ prompts: [{ identifier: "chatHistory", marker: true }],
  prompt_order: [{ character_id: 100001, order: [{ identifier: "chatHistory", enabled: true }] }] }));
const requests: any[] = [];
let waitForModel = false;
const mock = http.createServer(async (req, res) => {
  let raw = ""; for await (const part of req) raw += part;
  requests.push(JSON.parse(raw)); fs.writeFileSync(path.join(runDir, `request-${requests.length}.json`), raw);
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  if (waitForModel) { res.flushHeaders(); return; }
  const frame = (delta: object, finish_reason: string | null) => "data: " + JSON.stringify({ id: "fixture", model: "fixture", choices: [{ index: 0, delta, finish_reason }] }) + "\n\n";
  res.end(frame({ role: "assistant", content: "合成回复" }, null) + frame({}, "stop") + "data: [DONE]\n\n");
});
mock.listen(0, "127.0.0.1"); await once(mock, "listening");
config.providers = [{ id: "fixture", name: "合成模型", baseUrl: `http://127.0.0.1:${(mock.address() as AddressInfo).port}/v1`, apiKey: "synthetic-only",
  models: [{ id: "fixture", name: "合成模型", contextWindow: 16000, maxTokens: 500 }] }];
config.defaultProvider = "fixture"; config.defaultModel = "fixture";
const characters = new CharacterStore(path.join(config.stDataDir, "characters")), chats = new ChatStore(config.stDataDir);
const modelsRef = { current: buildModels(config) };
const sessions = new SessionManager(config, () => modelsRef.current, characters, chats, config.stDataDir);
const events: import("@pitavern/shared").ServerEvent[] = [];
sessions.onEvent((event) => events.push(structuredClone(event)));
const server = http.createServer(createHttpApp({ config, modelsRef, characters, chats, sessions, stDataDir: config.stDataDir, webDistDir: null }));
server.listen(0, "127.0.0.1"); await once(server, "listening");
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const post = (endpoint: string, body: unknown) => fetch(origin + endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const create = async () => (await (await post("/api/chats", { character: cardData.name })).json() as { id: string }).id;
const select = (chatId: string, selected: number, revision = chats.revisionId(chatId)) => post("/api/chat/greeting", { chatId, selected, revision });
const checks: string[] = [];
const passed = (message: string) => { checks.push(message); console.log("✓ " + message); };
try {
  const id = await create();
  let snapshot = sessions.snapshot(id)!;
  assert.equal(snapshot.greetingChoices?.selected, 0);
  assert.equal(snapshot.greetingChoices?.labels.length, 9);
  assert.equal(snapshot.greetingChoices?.labels[3], "开局 3 · 合成场景3");
  const initial = chats.revisionId(id);
  assert.equal((await select(id, 3)).status, 200);
  snapshot = sessions.snapshot(id)!;
  assert.equal(snapshot.messages[0].text, cardData.alternate_greetings[2]);
  assert.equal(snapshot.greetingChoices?.selected, 3);
  assert.equal(requests.length, 0);
  const line = chats.readChat(id)![0];
  assert.equal(line.swipes?.length, 9); assert.equal(line.swipe_id, 3); assert.equal(line.mes, line.swipes![3]);
  assert.ok(chats.backups(id).backups.length);
  const beforeConflict = fs.readFileSync(chats.resolveChatFile(id)!, "utf8");
  assert.equal((await select(id, 1, initial)).status, 409);
  for (const index of [-1, 9, 1.5]) assert.notEqual((await select(id, index)).status, 200);
  assert.equal(fs.readFileSync(chats.resolveChatFile(id)!, "utf8"), beforeConflict);
  const restarted = new SessionManager(config, () => modelsRef.current, characters, new ChatStore(config.stDataDir), config.stDataDir);
  assert.equal(restarted.snapshot(id)!.greetingChoices?.selected, 3);
  const exported = await (await fetch(origin + "/api/chats/" + id + "/export?format=jsonl")).text();
  assert.equal(JSON.parse(exported.trim().split("\n")[1]).swipe_id, 3);
  passed("默认页和八个备用开局、标题、选择落库、原版 swipes 导出、备份、重启与版本冲突");

  const card = characters.getCharacter(cardData.name)!;
  const imported = chats.createChat(card.name, { name: card.name, is_user: false, is_system: false, mes: "旧开场甲", swipes: ["旧开场甲", "旧开场乙"], swipe_id: 0,
    extra: { thinking: "甲的注释", unknown: "keep" }, swipe_info: [{ extra: { thinking: "甲的注释" } }, { extra: { thinking: "乙的注释" } }] }, "旅人", { variables: { keep: 1 }, projection: "过期状态" });
  const file = chats.resolveChatFile(imported.id)!;
  fs.appendFileSync(file, "unparsed original line\n" + JSON.stringify({ name: "system", is_user: false, is_system: true, mes: "系统记录", send_date: "", unknown: 42 }) + "\n");
  assert.equal((await select(imported.id, 1)).status, 200);
  assert.equal(chats.readChat(imported.id)![0].extra?.thinking, "乙的注释");
  assert.equal(chats.readChat(imported.id)![0].extra?.unknown, "keep");
  assert.deepEqual(chats.readMetadata(imported.id).variables, { keep: 1 });
  assert.equal(chats.readMetadata(imported.id).projection, undefined);
  assert.equal((await select(imported.id, 0)).status, 200);
  assert.equal(chats.readChat(imported.id)![0].extra?.thinking, "甲的注释");
  assert.match(fs.readFileSync(file, "utf8"), /unparsed original line/);
  assert.match(fs.readFileSync(file, "utf8"), /"unknown":42/);
  const custom = chats.createChat(card.name, { name: card.name, is_user: false, is_system: false, mes: "手动编写的开场" });
  assert.equal(sessions.snapshot(custom.id)!.greetingChoices?.selected, 0);
  assert.equal(chats.readChat(custom.id)![0].mes, "手动编写的开场");
  const noDefault = normalizeCard("chara_card_v2", { name: "空默认", alternate_greetings: ["备用甲", "备用乙"] }, "");
  assert.equal(greetingCatalog([{ name: "空默认", mes: "备用甲", is_user: false, is_system: false, send_date: "" }], noDefault)?.choices.labels.length, 2);
  passed("旧聊天、原版开场 swipes 与各页字段、自定义开场、空默认页、未知与损坏行保持原样");

  for (const mode of ["simple", "bridge", "takeover"] as const) {
    config.contextMode = mode; config.activePreset = "openings";
    const next = await create();
    assert.equal((await select(next, 6)).status, 200);
    const beforeSend: number = requests.length;
    await sessions.send(next, "继续这个开局");
    assert.equal(requests.length, beforeSend + 1);
    const sent = JSON.stringify(requests.at(-1));
    assert.ok(sent.includes(`开场正文6：${config.persona.name}抵达地点6。`), mode);
    assert.ok(!sent.includes("开场正文1"), mode + " 不发送其他开局");
    assert.ok(!sent.includes("自选开局"), mode + " 不发送默认说明页");
    assert.equal(sessions.snapshot(next)!.greetingChoices, undefined);
    const beforeRefused = fs.readFileSync(chats.resolveChatFile(next)!, "utf8");
    assert.equal((await select(next, 2)).status, 409);
    assert.equal(fs.readFileSync(chats.resolveChatFile(next)!, "utf8"), beforeRefused);
  }
  passed("简洁、桥接与接管均仅发送选中的开场正文，宏正常展开；开始对话后禁止切换");

  config.contextMode = "simple";
  const running = await create();
  waitForModel = true; const beforeWait = requests.length;
  const pending = sessions.send(running, "测试生成中的状态");
  const deadline = Date.now() + 5000;
  while (requests.length === beforeWait) { assert.ok(Date.now() < deadline); await new Promise((resolve) => setTimeout(resolve, 10)); }
  assert.equal((await select(running, 1)).status, 409);
  sessions.abort(running); await pending; waitForModel = false;
  const group = chats.createChat(card.name, { name: card.name, is_user: false, is_system: false, mes: card.firstMes }, "旅人", { _pitavernGroup: { name: "合成群聊", members: [card.name, "其他角色"] } });
  assert.equal(sessions.snapshot(group.id)!.greetingChoices, undefined);
  assert.equal((await select(group.id, 1)).status, 409);
  const event = events.findLast((event) => event.type === "chat.snapshot" && event.chatId === id)!;
  assert.equal(event.type, "chat.snapshot");
  let state = chatReducer({}, event);
  assert.equal(state[id].greetingChoices?.selected, 3);
  state = chatReducer(state, { type: "chat.started", chatId: id, startedAt: new Date().toISOString(), message: { id: "user", role: "user", name: "旅人", text: "开始", sendDate: "" } });
  assert.equal(state[id].greetingChoices, undefined);
  assert.equal(fs.readFileSync(cardFile, "utf8"), cardBefore);
  passed("生成与群聊限制、窗口快照同步与开始对话时隐藏选择器；原角色卡不变");
  fs.writeFileSync(path.join(runDir, "report.json"), JSON.stringify({ ok: true, checks, requests: requests.length }, null, 2));
  console.log("开场白验证通过；合成产物保留：" + runDir);
} catch (error) {
  fs.writeFileSync(path.join(runDir, "report.json"), JSON.stringify({ ok: false, checks, error: String(error) }, null, 2));
  throw error;
} finally { server.closeAllConnections(); server.close(); mock.closeAllConnections(); mock.close(); }
