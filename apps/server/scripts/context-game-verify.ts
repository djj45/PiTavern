/** M5: actual generation and world transactions, deterministic local SSE only. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { StChatLine } from "../src/stdata/types.ts";
import { ChatStore } from "../src/stdata/chats.ts";
import { CharacterStore } from "../src/stdata/characters.ts";
import { ChatImportService } from "../src/stdata/chat-import.ts";
import { longContextFixture } from "./context-fixtures.ts";
const root = path.resolve(import.meta.dirname, "../../../data/test-runs"); fs.mkdirSync(root, { recursive: true });
const run = fs.mkdtempSync(path.join(root, "context-game-")); process.env.PITAVERN_CONFIG = path.join(run, "config.json");
const { defaultConfig, seedDataDirs } = await import("../src/config.ts");
const { buildModels } = await import("../src/providers/models.ts");
const { SessionManager } = await import("../src/session/manager.ts");
const data = path.join(run, "st"); seedDataDirs(data);
fs.writeFileSync(path.join(data, "characters/guide.json"), JSON.stringify({ name: "长局向导", description: "本地合成长局游戏角色" }));
fs.writeFileSync(path.join(data, "OpenAI Settings/context.json"), JSON.stringify({ prompts: [{ identifier: "chatHistory", marker: true }], prompt_order: [{ character_id: 100001, order: [{ identifier: "chatHistory", enabled: true }] }] }));
interface WireMessage { role: string; content?: string; tool_call_id?: string; tool_calls?: Array<{ id: string }> }
let phase: "buy" | "recall" = "buy";
let route = "金色鸦羽";
let expectedRoute: string | undefined;
let expectedPrice = 17;
let initialMoney = 100;
let currentFacts: string[] = [];
let requests = 0;
const problems: string[] = [];
const mock = http.createServer(async (req, res) => {
  try {
    let raw = ""; for await (const part of req) raw += part;
    const body = JSON.parse(raw) as { messages: WireMessage[] };
    requests++;
    fs.appendFileSync(path.join(run, "requests.ndjson"), JSON.stringify(body) + "\n");
    const text = JSON.stringify(body.messages);
    for (const fact of currentFacts) assert.ok(text.includes(fact), "模型工作集必须含末尾事实：" + fact);
    assert.ok(text.includes("当前权威世界快照"));
    if (expectedRoute) {
      assert.ok(text.includes(`路线口令：${expectedRoute}`));
      assert.ok(!text.includes(`路线口令：${expectedRoute === "金色鸦羽" ? "银色鹿角" : "金色鸦羽"}`), "未选路线不得混入");
    }
    const results = body.messages.filter((m) => m.role === "tool");
    if (results.length) {
      const calls = new Set(body.messages.flatMap((m) => m.tool_calls?.map((c) => c.id) ?? []));
      for (const result of results) assert.ok(calls.has(result.tool_call_id!), "工具结果必须有对应调用");
      assert.ok(text.includes('\\"player\\":' + (initialMoney - expectedPrice)), "工具执行后必须重新投影当前暂存金额");
      assert.ok(text.includes('\\"locationId\\":\\"square\\"'), "工具执行后当前位置进入权威快照");
    }
    const frame = (delta: object, finish: string | null) => "data: " + JSON.stringify({ id: "local-context", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: finish }] }) + "\n\n";
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (phase === "buy" && !results.length) {
      const commands = [
        { commandId: "home", type: "move_to", actorId: "player", locationId: "tavern" },
        { commandId: "buy", type: "purchase_item", buyerId: "player", sellerId: "merchant", itemId: "sword", quantity: 1 },
        { commandId: "move", type: "move_to", actorId: "player", locationId: "square" },
      ];
      res.end(frame({ role: "assistant", tool_calls: commands.map((command, index) => ({ index, id: "call-" + index, type: "function", function: { name: "world_command", arguments: JSON.stringify(command) } })) }, null) + frame({}, "tool_calls") + "data: [DONE]\n\n");
    } else res.end(frame({ role: "assistant", content: phase === "buy" ? `购买和移动完成。莉雅承诺继续调查。发现反转：路线口令：${route}。` : `记住所选路线口令：${expectedRoute}，历史线索仍有效。` }, null) + frame({}, "stop") + "data: [DONE]\n\n");
  } catch (error) { problems.push(String(error)); res.writeHead(500); res.end(JSON.stringify({ error: { message: String(error) } })); }
});
mock.listen(0, "127.0.0.1"); await once(mock, "listening");
let checks = 0; const reports: unknown[] = [];
try {
  const config = defaultConfig(); config.stDataDir = data;
  config.providers = [{ id: "fixture", name: "本地合成", apiKey: "synthetic-only", baseUrl: `http://127.0.0.1:${(mock.address() as AddressInfo).port}/v1`, models: [{ id: "fixture", name: "fixture", contextWindow: 12000, maxTokens: 500 }] }];
  config.defaultProvider = "fixture"; config.defaultModel = "fixture"; config.outputProtocol = "native"; config.toolsEnabled = true; config.compression = { enabled: true, keepFullTurns: 3 }; config.takeover.recentTurns = 3; config.branches.autoGenerate = 0; config.activePreset = "context";
  const chats = new ChatStore(data), cards = new CharacterStore(path.join(data, "characters"));
  const sessions = new SessionManager(config, () => buildModels(config), cards, chats, data);
  const library = sessions.worldTemplateLibrary;
  const blank = library.copyBuiltIn("tavern-sword", "长局购买", "合成游戏");
  const template = structuredClone(blank.draft); template.items.find((i) => i.id === "sword")!.price = 17;
  const saved = library.saveDraft(blank.id, blank.draftRevision, { name: "长局购买", template }); const v1 = library.publish(blank.id, saved.draftRevision);
  const nextTemplate = structuredClone(v1.draft); nextTemplate.items.find((i) => i.id === "sword")!.price = 23;
  const savedNext = library.saveDraft(blank.id, v1.draftRevision, { name: "长局新价格", template: nextTemplate }); const v2 = library.publish(blank.id, savedNext.draftRevision);
  for (const [mode, turns] of [["simple", 100], ["bridge", 500], ["takeover", 1000]] as const) {
    config.contextMode = mode;
    const fixture = longContextFixture(turns); currentFacts = fixture.facts;
    const chat = chats.createChat("长局向导", null); sessions.initializeChatWorldByHash(chat.id, v1.publishedHash!, chats.revisionId(chat.id), false);
    const header = JSON.parse(fs.readFileSync(chat.file, "utf8").split("\n")[0]);
    const history: StChatLine[] = fixture.messages.filter((m) => m.role !== "system").slice(0, -1).map((m, i) => ({ name: m.role === "user" ? "旅人" : "长局向导", is_user: m.role === "user", is_system: false, send_date: "2026-11-01T00:00:00.000Z", mes: typeof m.content === "string" ? m.content : m.content.filter((b) => b.type === "text").map((b) => b.type === "text" ? b.text : "").join(""), extra: { messageId: `${mode}-${i}` } }));
    fs.writeFileSync(chat.file, [JSON.stringify(header), ...history.map((line) => JSON.stringify(line))].join("\n") + "\n");
    phase = "buy"; expectedRoute = undefined; route = "金色鸦羽"; expectedPrice = 17; initialMoney = 100;
    await sessions.send(chat.id, "买一把长剑并前往集市，回忆旧井地图、莉雅归还钥匙的承诺和北塔暗号。");
    assert.deepEqual(problems, []);
    assert.equal(chats.readWorld(chat.id)!.snapshot.money.player, 83);
    assert.equal(chats.readWorld(chat.id)!.snapshot.scene.locationId, "square");
    const reply = chats.readChat(chat.id)!.at(-1)!;
    route = "银色鹿角";
    await sessions.regenerate(chat.id, String(reply.extra!.messageId), reply.mes);
    assert.deepEqual(problems, []); assert.equal(chats.readWorld(chat.id)!.snapshot.money.player, 83, "重生成从回合前状态结算，不重复扣钱");
    const user = chats.readChat(chat.id)!.findLast((line) => line.is_user)!;
    chats.selectReply(chat.id, String(user.extra!.messageId), 0, chats.revisionId(chat.id));
    phase = "recall"; expectedRoute = "金色鸦羽";
    await sessions.send(chat.id, "回忆选中路线口令以及旧井地图、莉雅承诺与北塔暗号，不执行交易。");
    assert.deepEqual(problems, []); assert.equal(chats.readWorld(chat.id)!.snapshot.money.player, 83);
    console.log(`✓ ${mode} ${turns} 回合：本地合成生成保留线索/承诺、购买/移动正确、候选反转隔离`); checks++;
    const before = fs.readFileSync(chat.file, "utf8");
    const preview = sessions.previewChatWorldMigration(chat.id, v2.publishedHash!); assert.equal(preview.applyable, true);
    assert.equal(fs.readFileSync(chat.file, "utf8"), before);
    const applied = sessions.applyChatWorldMigration(chat.id, v2.publishedHash!, preview.revision, preview.previewHash);
    assert.equal(chats.readWorld(chat.id)!.snapshot.money.player, 83);
    chats.restoreBackup(chat.id, applied.backupId!, chats.revisionId(chat.id)); assert.equal(fs.readFileSync(chat.file, "utf8"), before);
    const again = sessions.previewChatWorldMigration(chat.id, v2.publishedHash!); sessions.applyChatWorldMigration(chat.id, v2.publishedHash!, again.revision, again.previewHash);
    phase = "buy"; expectedRoute = "金色鸦羽"; expectedPrice = 23; initialMoney = 83; route = "金色鸦羽";
    await sessions.send(chat.id, "再买一把长剑并回到集市；仍记得旧井地图、莉雅承诺与北塔暗号。");
    assert.deepEqual(problems, []); assert.equal(chats.readWorld(chat.id)!.snapshot.money.player, 60);
    assert.equal(chats.readWorld(chat.id)!.snapshot.inventory.find((i) => i.ownerId === "player" && i.itemId === "sword")?.quantity, 2);
    const imported = new ChatImportService(data, chats, cards).import(fs.readFileSync(chat.file), { fileName: `${mode}-long-game.jsonl`, character: "长局向导" });
    const restarted = new ChatStore(data);
    assert.deepEqual(restarted.readWorld(imported.id)!.snapshot, chats.readWorld(chat.id)!.snapshot);
    const fresh = new SessionManager(config, () => buildModels(config), cards, restarted, data);
    phase = "recall"; expectedRoute = "金色鸦羽";
    await fresh.send(imported.id, "重启并导入后，回忆旧井地图、莉雅承诺与北塔暗号，保持当前账本。");
    assert.deepEqual(problems, []); assert.equal(restarted.readWorld(imported.id)!.snapshot.money.player, 60);
    reports.push({ mode, turns, tailFacts: 3, balances: [100, 83, 83, 60], inventory: 2, location: "square", byteExactRestore: true, remigration: true, restartAndJSONLImport: true });
    console.log(`✓ ${mode}：字节一致备份恢复、再次迁移后新价格23、JSONL导入与重启后生成一致`); checks++;
  }
} finally { mock.closeAllConnections(); await new Promise<void>((resolve) => mock.close(() => resolve())); }
fs.writeFileSync(path.join(run, "report.json"), JSON.stringify({ checks, reports, mockRequests: requests, realProvider: "not_requested" }, null, 2));
console.log(`${checks} 项合成长局游戏验证通过；数据保留：${run}`);
