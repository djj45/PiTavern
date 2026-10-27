import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import type { ChatMessageDto, ChatSnapshotDto, ServerEvent } from "@pitavern/shared";
import { ChatStore } from "../src/stdata/chats.ts";
import { compressHistory, inputBudgetChars } from "../src/context/compression.ts";
import { assembleBridgeContext } from "../src/context/bridge.ts";
import { normalizeCard } from "../src/stdata/types.ts";
import { SessionManager } from "../src/session/manager.ts";
import { CharacterStore } from "../src/stdata/characters.ts";
import { defaultConfig } from "../src/config.ts";
import { buildModels } from "../src/providers/models.ts";
import { chatReducer, type ChatsState } from "../../web/src/chatState.ts";
import { isToolItem } from "../../web/src/chatItems.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pitavern-regression-"));
try {
  const store = new ChatStore(root);
  const empty = store.createChat("无开场白角色", null);
  assert.equal(empty.character, "无开场白角色");
  assert.equal(empty.messageCount, 0);
  assert.equal(store.listChats().length, 1);
  const user = store.appendMessage(empty.id, { name: "用户", is_user: true, is_system: false, mes: "第一句" });
  assert.equal(store.readDocument(empty.id)?.character, "无开场白角色", "身份不能来自第一条用户消息");
  assert.ok(user.extra?.messageId);
  store.writeMetadata(empty.id, { variables: { score: 12 } });
  assert.deepEqual(store.readMetadata(empty.id), { variables: { score: 12 } });

  const reader = new ChatStore(root);
  const readFile = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
    if (String(args[0]) === empty.file) reads++;
    return readFile(...args);
  }) as typeof fs.readFileSync;
  try {
    reader.listChats();
    reader.listChats();
    reader.readChat(empty.id);
    reader.readMetadata(empty.id);
    assert.equal(reads, 1, "未变化的正文、元数据和列表应共用一次读取");
    fs.appendFileSync(empty.file, JSON.stringify({ name: "无开场白角色", is_user: false, mes: "外部追加" }) + "\n");
    assert.equal(reader.listChats()[0].messageCount, 2);
    assert.equal(reader.readChat(empty.id)?.at(-1)?.mes, "外部追加");
    assert.equal(reads, 2, "外部修改后应重新读取");
  } finally { fs.readFileSync = readFile; }
  console.log("✓ 空聊天、头部角色身份、稳定消息 ID、读取缓存及外部修改失效");

  fs.mkdirSync(path.join(root, "characters"));
  fs.writeFileSync(path.join(root, "characters", "test.json"), JSON.stringify({ name: "无开场白角色" }));
  const config = defaultConfig();
  const manager = new SessionManager(config, () => buildModels(config), new CharacterStore(path.join(root, "characters")), store, root);
  const events: ServerEvent[] = [];
  manager.onEvent((event) => events.push(event));
  await manager.send(empty.id, "未配置模型时的普通发送");
  assert.equal(events.filter((e) => e.type === "chat.error").length, 1);
  assert.equal(events.at(-1)?.type, "chat.finished");
  assert.equal(manager.isStreaming(empty.id), false);
  assert.equal(store.readChat(empty.id)?.length, 2, "模型检查失败不应追加未发送的用户消息");
  console.log("✓ 未配置模型时错误可见、回合正常结束、没有多余落库");

  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const assistant = (text: string): Message => ({ role: "assistant", content: [{ type: "text", text }], api: "openai-completions", provider: "test", model: "test", usage: zero, stopReason: "stop", timestamp: 0 });
  const userMessage = (text: string): Message => ({ role: "user", content: text, timestamp: 0 });
  const call: Message = { ...assistant(""), role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "worldbook_search", arguments: { query: "图书馆" } }] } as Message;
  const result: Message = { role: "toolResult", toolCallId: "call-1", toolName: "worldbook_search", content: [{ type: "text", text: "图书馆资料" }], isError: false, timestamp: 0 };
  const system: Message = { role: "system", content: "保持消息顺序", timestamp: 0 };
  const recent = [userMessage("当前轮"), call, result];
  const messages = [system, userMessage("旧消息".repeat(1000)), assistant("旧正文".repeat(1000) + "<summary>旧剧情摘要</summary>"), ...recent];
  const compressed = compressHistory(messages, { enabled: true, keepFullTurns: 1 }, 2000);
  assert.equal(compressed.stats.triggered, true);
  assert.deepEqual(compressed.messages.slice(-3), recent, "当前用户、工具调用和结果必须原序保留");
  assert.equal(compressed.messages[0], system);
  assert.match(JSON.stringify(compressed.messages), /旧剧情摘要/);
  const interleaved = [system, userMessage("旧消息".repeat(1000)), call, { ...system, content: "中途系统消息" }, result, ...recent];
  assert.deepEqual(compressHistory(interleaved, { enabled: true, keepFullTurns: 1 }, 100).messages, interleaved, "跨系统消息的工具组不能拆开压缩");
  const oldToolRound = [system, userMessage("旧消息".repeat(1000)), call, result, assistant("旧正文".repeat(1000)), userMessage("新一轮")];
  const oldCompressed = compressHistory(oldToolRound, { enabled: true, keepFullTurns: 1 }, 2000);
  assert.equal(oldCompressed.messages.some((m) => m.role === "toolResult"), false, "压缩完整旧工具轮时不能遗留结果");
  assert.ok(compressHistory([system, ...recent], { enabled: true, keepFullTurns: 1 }, 20).stats.overBudget);
  assert.ok(inputBudgetChars(8000, 4000) < inputBudgetChars(8000, 1000));
  const hugeSystem = { ...system, content: "设定".repeat(2000) };
  assert.ok(compressHistory([hugeSystem, userMessage("短消息")], { enabled: true, keepFullTurns: 1 }, 2000).stats.overBudget, "系统提示必须计入预算");
  console.log("✓ 完整工具组压缩、当前轮顺序、系统消息位置、统一预算及输出预留");

  const assembled = assembleBridgeContext({
    preset: { prompts: [{ identifier: "chatHistory", role: "system", content: "", marker: true }], prompt_order: [{ character_id: 100001, order: [{ identifier: "chatHistory", enabled: true }] }] },
    card: normalizeCard("chara_card_v2", { name: "测试角色" }, ""), persona: { name: "用户", description: "" },
    chatLines: [{ name: "测试角色", is_user: false, is_system: false, send_date: "", mes: "历史正文".repeat(100) + "<summary>需要保留的旧摘要</summary>" }, { name: "用户", is_user: true, is_system: false, send_date: "", mes: "继续" }],
    worldEntries: [], regexScripts: [], options: { scanDepth: 2, recursionSteps: 0, caseSensitive: false, matchWholeWords: true, maxHistoryChars: 5 },
  });
  assert.match(JSON.stringify(assembled.messages), /需要保留的旧摘要/, "组装阶段不能先丢弃压缩所需的旧历史");
  console.log("✓ 桥接层保留旧摘要供统一压缩");

  const dto: ChatMessageDto = { id: "user-1", role: "user", name: "用户", text: "你好", sendDate: "" };
  const snapshot = (id: string, running = false, text = ""): ChatSnapshotDto => ({ id, character: id, messages: [], running, streamingText: text });
  let state: ChatsState = {};
  for (const id of ["a", "b"]) state = chatReducer(state, { type: "chat.snapshot", chatId: id, snapshot: snapshot(id) });
  state = chatReducer(state, { type: "pending", chatId: "a" });
  state = chatReducer(state, { type: "chat.started", chatId: "a", message: dto });
  state = chatReducer(state, { type: "chat.delta", chatId: "a", delta: "A 的正文" });
  assert.equal(state.b.streamingText, null);
  state = chatReducer(state, { type: "chat.started", chatId: "b", message: dto });
  state = chatReducer(state, { type: "chat.done", chatId: "a", message: { ...dto, id: "assistant-1", role: "assistant" } });
  assert.equal(state.a.streamingText, "", "中间助手消息不能提前结束整个工具回合");
  state = chatReducer(state, { type: "chat.finished", chatId: "a" });
  assert.equal(state.b.streamingText, "", "后台聊天结束不能清掉另一聊天的状态");
  state = chatReducer(state, { type: "disconnected" });
  state = chatReducer(state, { type: "chat.snapshot", chatId: "b", snapshot: snapshot("b", true, "重连恢复正文") });
  state = chatReducer(state, { type: "chat.delta", chatId: "b", delta: "及后续增量" });
  assert.equal(state.b.streamingText, "重连恢复正文及后续增量");
  state = chatReducer(state, { type: "chat.finished", chatId: "b" });
  assert.equal(state.b.streamingText, null);
  state = chatReducer(state, { type: "pending", chatId: "a" });
  state = chatReducer(state, { type: "chat.error", chatId: "a", message: "配置错误" });
  assert.equal(state.a.pending, false);
  console.log("✓ 前端会话隔离、回合结束、失败解除等待、重连快照及增量衔接");

  state = chatReducer(state, { type: "chat.tool_start", chatId: "a", toolCallId: "state-1", toolName: "tavern_set_state", args: { state: "人在大堂" } });
  state = chatReducer(state, { type: "chat.projection", chatId: "a", projection: "人在大堂" });
  state = chatReducer(state, { type: "chat.tool_end", chatId: "a", toolCallId: "state-1", toolName: "tavern_set_state", isError: false, details: { summary: "更新投影" } });
  const itemsBeforeFinish = state.a.items;
  const usageBeforeFinish = state.a.usage;
  state = chatReducer(state, { type: "chat.finished", chatId: "a" });
  assert.equal(state.a.projection, "人在大堂");
  assert.deepEqual(state.a.items, itemsBeforeFinish, "投影更新和回合结束不能覆盖聊天正文及已完成的工具卡");
  assert.equal(state.a.items.filter(isToolItem).length, 1);
  assert.equal(state.a.usage, usageBeforeFinish);
  assert.equal(state.b.projection, undefined, "投影应按聊天隔离");
  state = chatReducer(state, { type: "chat.snapshot", chatId: "a", snapshot: { ...snapshot("a"), projection: "人在大堂" } });
  assert.equal(state.a.projection, "人在大堂", "重新连接仍可从快照恢复投影");
  console.log("✓ 投影增量更新、回合结束保留工具卡、后台隔离及重连恢复");
} finally {
  // 本脚本只产生本地合成夹具，不包含网络请求记录。
  fs.rmSync(root, { recursive: true, force: true });
}
console.log("\n=== 可靠性回归验证全部通过 ===");
