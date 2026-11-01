/** 0.4.0 单聊天 JSONL 导入的服务端专项验收。
 * 只使用 data/test-runs/chat-import-* 下的合成数据，不读取/写入真实资料库，不访问真实供应商。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { WORLD_STATE_KEY, WORLD_TEMPLATES_KEY, type WorldTemplate } from "@pitavern/shared/world";
import {
  CHAT_IMPORT_MAX_BYTES, CHAT_IMPORT_MAX_ISSUES, CHAT_IMPORT_MAX_LINES,
  ChatImportError, ChatImportService, parseChatImportFile,
} from "../src/stdata/chat-import.ts";
import { ChatStore } from "../src/stdata/chats.ts";
import { CharacterStore } from "../src/stdata/characters.ts";
import { createInitialWorldSnapshot, createWorldTemplateRecord, WorldTransaction } from "../src/world/index.ts";
import { stateFields } from "../src/stdata/replies.ts";
import type { StChatLine } from "../src/stdata/types.ts";

const ROOT = path.resolve(import.meta.dirname, "../../..");
fs.mkdirSync(path.join(ROOT, "data/test-runs"), { recursive: true });
const RUN = fs.mkdtempSync(path.join(ROOT, "data/test-runs/chat-import-"));
process.env.PITAVERN_CONFIG = path.join(RUN, "config.json");
const { defaultConfig, seedDataDirs } = await import("../src/config.ts");
const { buildModels } = await import("../src/providers/models.ts");
const { SessionManager } = await import("../src/session/manager.ts");
const { createHttpApp } = await import("../src/api/http.ts");
const { LibraryBackupStore } = await import("../src/stdata/library-backup.ts");

let checks = 0;
function check(name: string): void { checks += 1; console.log("✓ " + name); }
function heading(name: string): void { console.log("\n## " + name); }
function jsonl(...values: unknown[]): string { return values.map((value) => JSON.stringify(value)).join("\n") + "\n"; }
function sha256(buffer: Buffer): string { return createHash("sha256").update(buffer).digest("hex"); }
function parseText(text: string, fileName = "聊天 导出.jsonl", known: string[] = []) {
  return parseChatImportFile(Buffer.from(text, "utf8"), fileName, { knownCharacters: known });
}
function issueText(preview: { errors: Array<{ code: string; line?: number; path?: string; message: string }> }): string {
  return preview.errors.map((issue) => issue.code + (issue.line ? "@" + issue.line : "") + ": " + issue.message).join(" | ");
}
function expectInvalid(source: string, code: string, matcher: (issue: any) => boolean = () => true, fileName?: string) {
  const parsed = parseText(source, fileName);
  assert.equal(parsed.preview.valid, false, "应拒绝该文件：" + source.slice(0, 120));
  assert.ok(parsed.preview.errors.some((issue) => issue.code === code && matcher(issue)),
    "缺少 " + code + " 错误，实际：" + issueText(parsed.preview));
  assert.ok(parsed.preview.errors.length <= CHAT_IMPORT_MAX_ISSUES);
  return parsed;
}
function allFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) walk(file);
      else out.push(path.relative(dir, file).split(path.sep).join("/"));
    }
  };
  walk(dir);
  return out;
}
function writeCard(root: string, name: string): void {
  seedDataDirs(root);
  fs.writeFileSync(path.join(root, "characters", name + ".json"), JSON.stringify({ name, description: "导入验收合成角色" }));
}
function createLibrary(label: string, names: string[]): { root: string; characters: CharacterStore; store: ChatStore; service: ChatImportService } {
  const root = path.join(RUN, label);
  for (const name of names) writeCard(root, name);
  const characters = new CharacterStore(path.join(root, "characters"));
  const store = new ChatStore(root);
  return { root, characters, store, service: new ChatImportService(root, store, characters) };
}
function expectImportError(fn: () => unknown, code: string, messagePart?: string): void {
  assert.throws(fn, (error: any) => {
    assert.ok(error instanceof ChatImportError, "不是 ChatImportError：" + error);
    assert.equal(error.code, code);
    if (messagePart) assert.ok(error.message.includes(messagePart), error.message);
    return true;
  });
}

/* ------------------------------------------------------------------ */
/* 合成世界模板与消息                                                  */
/* ------------------------------------------------------------------ */
const template: WorldTemplate = {
  schemaVersion: 1, templateId: "chat-import-tavern", templateVersion: 1, rulesVersion: 1,
  locations: [{ id: "tavern", name: "酒馆" }, { id: "square", name: "集市" }],
  actors: [{ id: "player", name: "旅人" }, { id: "merchant", name: "掌柜" }],
  items: [{ id: "sword", name: "长剑", price: 10 }],
  initial: { actorId: "player", locationId: "tavern", money: 20, inventory: [{ ownerId: "merchant", itemId: "sword", quantity: 2 }] },
};
const templateRecord = createWorldTemplateRecord(template);
const initialWorld = createInitialWorldSnapshot(templateRecord);
function worldMetadata(snapshot: unknown = initialWorld, record: unknown = templateRecord): Record<string, unknown> {
  return { [WORLD_TEMPLATES_KEY]: { [(record as any).contentHash]: record }, [WORLD_STATE_KEY]: snapshot };
}
function chatHeader(metadata: Record<string, unknown> = {}): any {
  return {
    user_name: "旅人",
    character_name: "世界向导",
    chat_metadata: {
      _pitavernTitle: "酒馆 旧档",
      customMetadata: { keep: true },
      variables: { gold: 0 },
      ...worldMetadata(),
      ...metadata,
    },
    unknownHeader: "保留",
  };
}
const validMessages = [
  { name: "旅人", is_user: true, is_system: false, mes: "你好", send_date: "2026-01-01T00:00:00.000Z", extra: { messageId: "u1", unknownUser: "保留" }, unknownTop: "保留" },
  { name: "世界向导", is_user: false, is_system: false, mes: "回答 A", swipes: ["回答 A", "回答 B"], swipe_id: 1,
    swipe_info: [{ extra: { thinking: "甲" } }, { extra: { thinking: "乙" } }], extra: { messageId: "a1", unknownAssistant: "保留" } },
  { name: "旁白", is_user: false, is_system: true, mes: "系统注" },
];
const validSource = jsonl(chatHeader(), ...validMessages);

/* ------------------------------------------------------------------ */
/* 本地 mock SSE：只在本机 127.0.0.1，合成工具调用与正文，不访问真实供应商 */
/* ------------------------------------------------------------------ */
let mockMode: "text" | "world" = "text";
let mockSerial = 0;
const mockRequests: any[] = [];
const mock = http.createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const part of req) chunks.push(Buffer.from(part));
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  mockRequests.push(body);
  fs.writeFileSync(path.join(RUN, "mock-request-" + mockRequests.length + ".json"), JSON.stringify(body, null, 2));
  const frame = (delta: object, finish: string | null) => "data: " + JSON.stringify({
    id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture",
    choices: [{ index: 0, delta, finish_reason: finish }],
  }) + "\n\n";
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  if (mockMode === "world" && !body.messages?.some((message: any) => message.role === "tool")) {
    const call = {
      index: 0, id: "world-call-" + (++mockSerial), type: "function",
      function: { name: "world_command", arguments: JSON.stringify({ commandId: "import-world-1", type: "advance_time", minutes: 30 }) },
    };
    res.end(frame({ role: "assistant", tool_calls: [call] }, null) + frame({}, "tool_calls") + "data: [DONE]\n\n");
    return;
  }
  const text = mockMode === "world" ? "导入后重生成正文" : "本地合成回复 " + (++mockSerial);
  res.end(frame({ role: "assistant", content: text }, null) + frame({}, "stop") + "data: [DONE]\n\n");
});
mock.listen(0, "127.0.0.1");
await once(mock, "listening");
const MOCK_BASE = "http://127.0.0.1:" + (mock.address() as AddressInfo).port + "/v1";
function makeConfig(stDataDir: string) {
  const config = defaultConfig();
  config.stDataDir = stDataDir;
  config.providers = [{
    id: "fixture", name: "合成连接", baseUrl: MOCK_BASE, apiKey: "synthetic-only",
    models: [{ id: "fixture", name: "合成模型", contextWindow: 16000, maxTokens: 500 }],
  }];
  config.defaultProvider = "fixture";
  config.defaultModel = "fixture";
  config.toolsEnabled = true;
  config.contextMode = "simple";
  config.outputProtocol = "native";
  config.branches.autoGenerate = 0;
  return config;
}

let httpServer: http.Server | undefined;
try {
  /* ---------------------------------------------------------------- */
  heading("A. 纯解析器");
  const parsed = parseChatImportFile(Buffer.from(validSource, "utf8"), "C:\\导出 目录\\我的 聊天 2026.jsonl", { knownCharacters: ["世界向导"] });
  const pv = parsed.preview;
  assert.equal(pv.valid, true, issueText(pv));
  assert.equal(pv.hasHeader, true);
  assert.equal(pv.fileName, "我的 聊天 2026.jsonl");
  assert.equal(pv.suggestedTitle, "酒馆 旧档");
  assert.equal(pv.detectedCharacter, "世界向导");
  assert.equal(pv.suggestedCharacter, "世界向导");
  assert.equal(pv.characterKnown, true);
  assert.equal(pv.messages, 3);
  assert.equal(pv.userMessages, 1);
  assert.equal(pv.assistantMessages, 1);
  assert.equal(pv.systemMessages, 1);
  assert.ok(pv.userNames.includes("旅人"));
  assert.ok(pv.assistantNames.includes("世界向导"));
  assert.equal(pv.firstPreview, "你好");
  assert.equal(pv.lastPreview, "回答 A");
  assert.deepEqual(parsed.records.map((record) => record.line.mes), ["你好", "回答 A", "系统注"]);
  assert.deepEqual(JSON.parse(parsed.raw[2]).swipes, ["回答 A", "回答 B"]);
  assert.equal(JSON.parse(parsed.raw[2]).extra.unknownAssistant, "保留");
  assert.equal(JSON.parse(parsed.raw[0]).unknownHeader, "保留");
  assert.equal((parsed.metadata.customMetadata as any).keep, true);
  assert.ok(pv.world);
  assert.equal(pv.world.capability, "enabled");
  assert.equal(pv.world.snapshots, 1);
  assert.equal(pv.world.templates, 1);
  assert.equal(pv.world.templateIds[0], template.templateId);
  assert.equal(pv.sha256, sha256(Buffer.from(validSource)));
  assert.equal(pv.bytes, Buffer.byteLength(validSource));
  assert.equal(pv.lines, 4);
  check("合法 PiTavern/ST JSONL：头/未知字段/swipes/模板表/统计/建议标题");

  const headerless = jsonl({ name: "旅人", is_user: true, mes: "无头提问" }, { name: "世界向导", mes: "无头回答" });
  const noHeader = parseText(headerless, "无头 聊天.jsonl", ["世界向导"]);
  assert.equal(noHeader.preview.valid, true, issueText(noHeader.preview));
  assert.equal(noHeader.preview.hasHeader, false);
  assert.equal(noHeader.preview.detectedCharacter, "世界向导");
  assert.equal(noHeader.preview.suggestedTitle, "无头 聊天");
  assert.ok(noHeader.preview.warnings.some((warning) => warning.includes("补建")));
  assert.equal(noHeader.preview.messages, 2);
  check("无头 JSONL：首行按消息识别、补头警告、文件名建议标题");

  const empty = parseChatImportFile(Buffer.alloc(0), "空 文件.jsonl");
  assert.equal(empty.preview.valid, false);
  assert.equal(empty.preview.errors[0].code, "size");
  assert.equal(empty.preview.errors[0].line, undefined);
  check("空文件：文件级 size 错误");

  const badJson = parseText([JSON.stringify(chatHeader()), JSON.stringify(validMessages[0]), JSON.stringify(validMessages[1]), "{半截", JSON.stringify(validMessages[2])].join("\n") + "\n");
  assert.equal(badJson.preview.valid, false);
  assert.ok(badJson.preview.errors.some((issue) => issue.code === "json" && issue.line === 4), issueText(badJson.preview));
  check("坏 JSON / 半截行：定位到物理行号 4");

  for (const source of [jsonl([1, 2, 3]), jsonl("不是对象"), jsonl(validMessages[0], { user_name: "迟到的头" })]) {
    const parsedBad = parseText(source);
    assert.equal(parsedBad.preview.valid, false);
    assert.ok(parsedBad.preview.errors.some((issue) => issue.code === "structure"));
  }
  const groupLike = parseText(JSON.stringify({ name: "群聊", members: ["甲", "乙"], chat_metadata: {}, messages: [{ name: "甲", mes: "x" }] }) + "\n", "群组.json");
  assert.equal(groupLike.preview.valid, false);
  assert.ok(groupLike.preview.errors.some((issue) => issue.message.includes("JSONL")), issueText(groupLike.preview));
  check("首行非对象、头出现在消息之后或原版群组 JSON 对象：structure 拒绝");

  const malformedFirst = parseText('{"mes":42}\n', "坏首条.jsonl");
  assert.equal(malformedFirst.preview.valid, false);
  assert.equal(malformedFirst.preview.hasHeader, false);
  assert.equal(malformedFirst.preview.messages, 1);
  assert.ok(malformedFirst.preview.errors.some((issue) => issue.line === 1 && issue.path?.endsWith(".mes")), issueText(malformedFirst.preview));
  check("首行带 mes 字段但类型非法：进入消息校验而非聊天头");

  const headerOnly = parseText(jsonl({ user_name: "旅人", character_name: "世界向导", chat_metadata: {} }), "只有头.jsonl");
  assert.equal(headerOnly.preview.valid, true);
  assert.equal(headerOnly.preview.hasHeader, true);
  assert.equal(headerOnly.preview.messages, 0);
  check("仅有头的 JSONL：首行无 mes 时按头处理");

  const fieldSource = jsonl(
    chatHeader(),
    { name: "", mes: 5, is_user: "yes", is_system: 1, send_date: 5, extra: null },
    { name: "世界向导", mes: "ok", extra: { messageId: 3, thinking: 4, summary: [], _pitavernBeforeTurn: "bad" } },
    { name: "世界向导", mes: "ok", swipes: ["ok", 3], swipe_id: 5, swipe_info: [1, {}] },
  );
  const fields = parseText(fieldSource);
  assert.equal(fields.preview.valid, false);
  for (const part of ["name", "mes", "is_user", "is_system", "send_date", "extra 必须是对象", "messageId", "thinking", "summary", "_pitavernBeforeTurn", "swipes", "swipe_id", "swipe_info"]) {
    assert.ok(fields.preview.errors.some((issue) => issue.message.includes(part)), "缺少字段错误：" + part + "；" + issueText(fields.preview));
  }
  check("消息字段逐项校验：name/mes/布尔/send_date/extra/swipes/swipe_id/swipe_info/BeforeTurn");

  const nativeSwipeExtra = parseText(jsonl(
    chatHeader(),
    { name: "旅人", is_user: true, mes: "问题", extra: { messageId: "u-native" } },
    { name: "世界向导", mes: "甲", swipes: ["甲", "乙", "丙", "丁"], swipe_id: 0, swipe_info: [
      {},
      { extra: { thinking: 42 } },
      { extra: { _pitavernReplies: { selected: 0, versions: [] } } },
      { extra: { _pitavernBeforeTurn: { metadata: { [WORLD_STATE_KEY]: { broken: true } } } } },
    ] },
  ));
  assert.equal(nativeSwipeExtra.preview.valid, false);
  assert.ok(nativeSwipeExtra.preview.errors.some((issue) => issue.path?.endsWith("swipe_info[1].extra.thinking")), issueText(nativeSwipeExtra.preview));
  assert.ok(nativeSwipeExtra.preview.errors.some((issue) => issue.path?.includes("swipe_info[2].extra._pitavernReplies")), issueText(nativeSwipeExtra.preview));
  assert.ok(nativeSwipeExtra.preview.errors.some((issue) => issue.code === "world" && issue.path?.includes("swipe_info[3].extra._pitavernBeforeTurn.metadata._pitavernWorld")), issueText(nativeSwipeExtra.preview));
  check("原生 swipes 的 swipe_info[].extra 复用消息扩展字段与候选目录校验");

  const branchMessages = [
    { name: "世界向导", is_user: false, is_system: false, mes: "候选甲", extra: { unknownBranch: "甲" } },
    { name: "世界向导", is_user: false, is_system: false, mes: "候选乙", extra: { unknownBranch: "乙" } },
  ];
  const branchCatalog = {
    selected: 1,
    versions: [
      { branchId: "b1", messages: [branchMessages[0]], state: { variables: { x: 1 }, [WORLD_STATE_KEY]: initialWorld }, enforcement: { turn: 1, usedThisTurn: 0, cooldownUntilTurn: 0 } },
      { branchId: "b2", messages: [branchMessages[1]], state: { variables: { x: 2 }, [WORLD_STATE_KEY]: initialWorld },
        continuation: [JSON.stringify({ name: "旅人", is_user: true, mes: "隐藏后续问题", extra: { messageId: "hidden-u" } }), JSON.stringify({ name: "世界向导", is_user: false, mes: "隐藏后续回答" })] },
    ],
  };
  const branchSource = jsonl(chatHeader(), { name: "旅人", is_user: true, mes: "分叉问题", extra: { messageId: "u-branch", _pitavernReplies: branchCatalog } });
  const branchParsed = parseText(branchSource, "分支 导出.jsonl", ["世界向导"]);
  assert.equal(branchParsed.preview.valid, true, issueText(branchParsed.preview));
  assert.equal(branchParsed.preview.branchPoints, 1);
  assert.ok(branchParsed.preview.candidates >= 2);
  // 候选正文 2 条 + continuation 内嵌消息 2 条都计入隐藏消息。
  assert.equal(branchParsed.preview.hiddenMessages, 4);
  assert.equal(branchParsed.preview.hiddenContinuations, 1);
  assert.equal(branchParsed.preview.world?.snapshots, 3);
  assert.equal(branchParsed.preview.world?.templates, 1);
  assert.equal(branchParsed.preview.errors.length, 0);
  check("合法候选目录：selected/state/enforcement/continuation 与隐藏消息计数");

  const badCatalogSource = jsonl(
    chatHeader(),
    { name: "旅人", is_user: true, mes: "u1", extra: { _pitavernReplies: 5 } },
    { name: "旅人", is_user: true, mes: "u2", extra: { _pitavernReplies: { selected: 0, versions: [] } } },
    { name: "旅人", is_user: true, mes: "u3", extra: { _pitavernReplies: { selected: 5, versions: [{ messages: [{ name: "世界向导", mes: "x" }] }] } } },
    { name: "旅人", is_user: true, mes: "u4", extra: { _pitavernReplies: { selected: 0, versions: [{ messages: [] }] } } },
    { name: "旅人", is_user: true, mes: "u5", extra: { _pitavernReplies: { selected: 0, versions: [{ messages: [{ name: "旅人", mes: "x", is_user: true }] }] } } },
    { name: "旅人", is_user: true, mes: "u6", extra: { _pitavernReplies: { selected: 0, versions: [{ branchId: 5, statePruned: "yes", enforcement: { turn: -1, usedThisTurn: 0, cooldownUntilTurn: 0 }, state: 5, messages: [{ name: "世界向导", mes: "x" }] }] } } },
    { name: "旅人", is_user: true, mes: "u7", extra: { _pitavernReplies: { selected: 0, versions: [{ messages: [{ name: "世界向导", mes: "x" }], continuation: "不是数组" }] } } },
    { name: "旅人", is_user: true, mes: "u8", extra: { _pitavernReplies: { selected: 0, versions: [{ messages: [{ name: "世界向导", mes: "x" }], continuation: ["", "不是 JSON", JSON.stringify(5), JSON.stringify({ name: 5, mes: "x" })] }] } } },
  );
  const badCatalog = parseText(badCatalogSource);
  assert.equal(badCatalog.preview.valid, false);
  for (const line of [2, 3, 4, 5, 6, 7, 8]) {
    assert.ok(badCatalog.preview.errors.some((issue) => issue.line === line), "缺少第 " + line + " 行错误；" + issueText(badCatalog.preview));
  }
  assert.ok(badCatalog.preview.errors.some((issue) => issue.code === "json" && issue.line === 9), issueText(badCatalog.preview));
  assert.ok(badCatalog.preview.errors.some((issue) => issue.line === 7 && issue.path?.includes(".enforcement")));
  check("坏候选目录：非对象/空 versions/selected 越界/空 messages/user 候选/坏 state/坏 enforcement/坏 continuation");

  const beforeTurnBad = parseText(jsonl(chatHeader(),
    { name: "旅人", is_user: true, mes: "a", extra: { _pitavernBeforeTurn: { metadata: null } } },
    { name: "旅人", is_user: true, mes: "b", extra: { _pitavernBeforeTurn: "bad" } }));
  assert.equal(beforeTurnBad.preview.valid, false);
  assert.ok(beforeTurnBad.preview.errors.some((issue) => issue.code === "structure" && issue.line === 2 && issue.path?.includes(".metadata")));
  assert.ok(beforeTurnBad.preview.errors.some((issue) => issue.code === "structure" && issue.line === 3));
  check("坏 _pitavernBeforeTurn：对象/metadata 类型校验");

  const brokenWorldHeader = { ...chatHeader(), chat_metadata: { ...chatHeader().chat_metadata, [WORLD_STATE_KEY]: { schemaVersion: 1 } } };
  const brokenWorld = parseText(jsonl(brokenWorldHeader, { name: "世界向导", mes: "x" }));
  assert.equal(brokenWorld.preview.valid, false);
  const worldIssue = brokenWorld.preview.errors.find((issue) => issue.code === "world");
  assert.ok(worldIssue);
  assert.equal(worldIssue!.line, 1);
  assert.equal(worldIssue!.path, "chat_metadata._pitavernWorld");
  check("头世界快照损坏：world 错误定位到行 1 与字段路径");

  const candidateWorldBad = parseText(jsonl(chatHeader(), {
    name: "旅人", is_user: true, mes: "x",
    extra: { _pitavernReplies: { selected: 0, versions: [{ messages: [{ name: "世界向导", mes: "ok" }], state: { [WORLD_STATE_KEY]: { broken: true } } }] } },
  }));
  assert.equal(candidateWorldBad.preview.valid, false);
  const candidateWorldIssue = candidateWorldBad.preview.errors.find((issue) => issue.code === "world");
  assert.ok(candidateWorldIssue);
  assert.equal(candidateWorldIssue!.line, 2);
  assert.ok(candidateWorldIssue!.path?.includes("versions[0].state._pitavernWorld"));
  check("候选取世界快照损坏：定位到候选字段");

  const readOnlyHeader = { user_name: "旅人", character_name: "世界向导", chat_metadata: { _pitavernTitle: "只读档", [WORLD_STATE_KEY]: initialWorld } };
  const readOnly = parseText(jsonl(readOnlyHeader, { name: "世界向导", mes: "x" }));
  assert.equal(readOnly.preview.valid, true, issueText(readOnly.preview));
  assert.equal(readOnly.preview.world?.capability, "read-only");
  assert.match(readOnly.preview.world?.reason ?? "", /缺失/);
  assert.ok(readOnly.preview.warnings.some((warning) => warning.includes("只读")));
  check("世界快照存在但模板表缺失：可导入但世界只读并警告");

  const unknownTemplate = { ...template, rulesVersion: 2 };
  const unknownRecord = createWorldTemplateRecord(unknownTemplate);
  const unknownSnapshot = { ...initialWorld, templateHash: unknownRecord.contentHash, rulesVersion: 2 };
  const unknownHeader = { user_name: "旅人", character_name: "世界向导", chat_metadata: { _pitavernTitle: "未知规则", [WORLD_STATE_KEY]: unknownSnapshot, [WORLD_TEMPLATES_KEY]: { [unknownRecord.contentHash]: unknownRecord } } };
  const unknownRules = parseText(jsonl(unknownHeader, { name: "世界向导", mes: "x" }));
  assert.equal(unknownRules.preview.valid, true, issueText(unknownRules.preview));
  assert.equal(unknownRules.preview.world?.capability, "read-only");
  assert.match(unknownRules.preview.world?.reason ?? "", /规则版本/);
  const mismatchHeader = { user_name: "旅人", character_name: "世界向导", chat_metadata: { _pitavernTitle: "哈希不匹配", [WORLD_STATE_KEY]: initialWorld, [WORLD_TEMPLATES_KEY]: { [templateRecord.contentHash]: { ...templateRecord, contentHash: "0".repeat(64) } } } };
  const mismatched = parseText(jsonl(mismatchHeader, { name: "世界向导", mes: "x" }));
  assert.equal(mismatched.preview.valid, true, issueText(mismatched.preview));
  assert.equal(mismatched.preview.world?.capability, "read-only");
  assert.match(mismatched.preview.world?.reason ?? "", /哈希/);
  check("模板表未知规则版本 / 内容哈希不匹配：只读警告、不拒绝导入");

  const groupBad = parseText(jsonl({ user_name: "旅人", character_name: "甲", chat_metadata: { _pitavernTitle: "坏群", _pitavernGroup: { name: "小队", members: ["甲"] } } }, { name: "甲", mes: "x" }));
  assert.equal(groupBad.preview.valid, false);
  assert.ok(groupBad.preview.errors.some((issue) => issue.code === "metadata" && issue.path === "chat_metadata._pitavernGroup"));
  const groupWarn = parseText(jsonl({
    user_name: "旅人", character_name: "不在库里的头角色",
    chat_metadata: { _pitavernTitle: "群聊档", _pitavernGroup: { name: "小队", members: ["甲", "乙", "丙"] } },
  }, { name: "甲", is_user: false, mes: "群消息" }), "群聊 导出.jsonl", ["甲"]);
  assert.equal(groupWarn.preview.valid, true, issueText(groupWarn.preview));
  assert.deepEqual(groupWarn.preview.group?.missingMembers, ["乙", "丙"]);
  assert.equal(groupWarn.preview.suggestedCharacter, "甲");
  assert.ok(groupWarn.preview.warnings.some((warning) => warning.includes("缺少角色卡")));
  check("群聊配置损坏拒绝；成员缺失只警告并建议已有成员");

  const noTitleHeader = chatHeader({ _pitavernTitle: undefined });
  const fileNamePreview = parseText(jsonl(noTitleHeader, { name: "世界向导", mes: "x" }), "目录/中文 空格.jsonl");
  assert.equal(fileNamePreview.preview.fileName, "中文 空格.jsonl");
  assert.equal(fileNamePreview.preview.suggestedTitle, "中文 空格");
  const extensionPreview = parseText(validSource, "聊天.不是jsonl");
  assert.equal(extensionPreview.preview.valid, true, "扩展名不参与校验");
  check("中文+空格文件名、路径剥离、扩展名不参与校验");

  const crlfBuffer = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(validSource.replace(/\n/g, "\r\n"), "utf8")]);
  const crlfParsed = parseChatImportFile(crlfBuffer, "crlf 文件.jsonl", { knownCharacters: ["世界向导"] });
  assert.equal(crlfParsed.preview.valid, true, issueText(crlfParsed.preview));
  assert.equal(crlfParsed.preview.hasHeader, true);
  assert.equal(crlfParsed.preview.messages, 3);
  assert.ok(crlfParsed.raw.every((line) => !line.includes("\r")));
  check("BOM + CRLF：规范化后正常解析");

  for (const buffer of [Buffer.from([0xff, 0xfe, 0xfd]), Buffer.from("{\"name\":\"a\",\"mes\":\"x\"}\u0000", "utf8")]) {
    const badEncoding = parseChatImportFile(buffer, "编码.jsonl");
    assert.equal(badEncoding.preview.valid, false);
    assert.ok(badEncoding.preview.errors.some((issue) => issue.code === "encoding"));
  }
  check("非 UTF-8 / NUL 字符：encoding 文件级拒绝");

  const lineLimit = parseChatImportFile(Buffer.from("\n".repeat(CHAT_IMPORT_MAX_LINES + 1)), "超行.jsonl");
  assert.equal(lineLimit.preview.valid, false);
  assert.ok(lineLimit.preview.errors.some((issue) => issue.code === "limit" && issue.message.includes("行")));
  const sizeLimit = parseChatImportFile(Buffer.alloc(CHAT_IMPORT_MAX_BYTES + 1, 0x20), "超大.jsonl");
  assert.equal(sizeLimit.preview.valid, false);
  assert.ok(sizeLimit.preview.errors.some((issue) => issue.code === "size"));
  check("物理行数 200000 / 32 MiB 文件级上限");

  const issueCapSource = [JSON.stringify(chatHeader()), ...Array.from({ length: 60 }, (_, index) => "坏行" + index)].join("\n") + "\n";
  const capped = parseText(issueCapSource);
  assert.equal(capped.preview.valid, false);
  assert.equal(capped.preview.issueCount, 60);
  assert.equal(capped.preview.errors.length, CHAT_IMPORT_MAX_ISSUES);
  check("单次预览最多返回 50 条错误并保留 issueCount");

  function nestedArray(depth: number): unknown {
    let value: unknown = 0;
    for (let index = 0; index < depth; index++) value = [value];
    return value;
  }
  const deepAccept = parseText(jsonl({ name: "世界向导", mes: "x", extra: { deep: nestedArray(500) } }));
  assert.equal(deepAccept.preview.valid, true, issueText(deepAccept.preview));
  const deepReject = parseText(jsonl({ name: "世界向导", mes: "x", extra: { deep: nestedArray(513) } }));
  assert.equal(deepReject.preview.valid, false);
  assert.ok(deepReject.preview.errors.some((issue) => issue.code === "depth"));
  check("单行 JSON 512 层：500 层通过、513 层拒绝");

  const unsafe = parseText('{"name":"世界向导","mes":"x","extra":{"__proto__":{"polluted":true}}}\n');
  assert.equal(unsafe.preview.valid, false);
  assert.ok(unsafe.preview.errors.some((issue) => issue.code === "unsafe"));
  assert.equal(({} as any).polluted, undefined);
  check("__proto__ 字段：unsafe 拒绝且不污染对象");

  function nestedBranch(depth: number): any {
    let node: any = { name: "世界向导", is_user: false, is_system: false, mes: "嵌套候选" };
    for (let index = 0; index < depth; index++) {
      node = { name: "世界向导", is_user: false, is_system: false, mes: "层" + index, extra: { _pitavernReplies: { selected: 0, versions: [{ messages: [node] }] } } };
    }
    return node;
  }
  const tooDeepBranch = parseText(jsonl(chatHeader(), { name: "旅人", is_user: true, mes: "深分支", extra: { _pitavernReplies: { selected: 0, versions: [{ messages: [nestedBranch(70)] }] } } }));
  assert.equal(tooDeepBranch.preview.valid, false);
  assert.ok(tooDeepBranch.preview.errors.some((issue) => issue.code === "limit" && issue.message.includes("64")), issueText(tooDeepBranch.preview));
  check("分支嵌套超过 64 层：limit 拒绝");

  const tooManyNodes = parseText(jsonl(chatHeader(), {
    name: "旅人", is_user: true, mes: "节点过多",
    extra: { _pitavernReplies: { selected: 0, versions: Array.from({ length: 10001 }, () => ({ messages: [{ name: "世界向导", is_user: false, mes: "x" }] })) } },
  }));
  assert.equal(tooManyNodes.preview.valid, false);
  assert.ok(tooManyNodes.preview.errors.some((issue) => issue.code === "limit" && issue.message.includes("候选")), issueText(tooManyNodes.preview));
  check("候选节点超过 10000：limit 拒绝");

  const tooManySwipes = parseText(jsonl(chatHeader(), {
    name: "世界向导", mes: "开场", swipes: Array.from({ length: 10001 }, (_, index) => "候选" + index), swipe_id: 0,
  }));
  assert.equal(tooManySwipes.preview.valid, false);
  assert.ok(tooManySwipes.preview.errors.some((issue) => issue.code === "limit" && issue.path?.endsWith(".swipes")), issueText(tooManySwipes.preview));
  const splitSwipes = parseText(jsonl(
    chatHeader(),
    { name: "世界向导", mes: "甲", swipes: Array.from({ length: 6000 }, (_, index) => "甲" + index), swipe_id: 0 },
    { name: "世界向导", mes: "乙", swipes: Array.from({ length: 6001 }, (_, index) => "乙" + index), swipe_id: 0 },
  ));
  assert.equal(splitSwipes.preview.valid, false);
  assert.ok(splitSwipes.preview.errors.some((issue) => issue.code === "limit" && issue.message.includes("候选总数")), issueText(splitSwipes.preview));
  const greetingSwipes = parseText(jsonl(chatHeader(), {
    name: "世界向导", mes: "开场", swipes: ["甲", "乙", "丙"], swipe_id: 0,
  }));
  assert.equal(greetingSwipes.preview.valid, true, issueText(greetingSwipes.preview));
  assert.equal(greetingSwipes.preview.candidates, 3);
  check("原生 swipes 单条与跨消息总数超过 10000：limit 拒绝；未超限开场候选计入预览");

  const hiddenNativeContinuation: string[] = [];
  for (let index = 0; index < 101; index++) {
    hiddenNativeContinuation.push(JSON.stringify({ name: "旅人", is_user: true, mes: "隐藏问题" + index, extra: { messageId: "hu" + index } }));
    hiddenNativeContinuation.push(JSON.stringify({
      name: "世界向导", mes: "隐藏回答", swipes: Array.from({ length: 100 }, (_, swipe) => "隐藏" + swipe), swipe_id: 0,
    }));
  }
  const hiddenTooMany = parseText(jsonl(chatHeader(), {
    name: "旅人", is_user: true, mes: "入口", extra: { messageId: "root", _pitavernReplies: { selected: 0, versions: [
      { messages: [{ name: "世界向导", mes: "当前" }] },
      { messages: [{ name: "世界向导", mes: "隐藏" }], continuation: hiddenNativeContinuation },
    ] } },
  }, { name: "世界向导", mes: "当前" }));
  assert.equal(hiddenTooMany.preview.valid, false);
  assert.ok(hiddenTooMany.preview.errors.some((issue) => issue.code === "limit" && issue.path?.includes("continuation")), issueText(hiddenTooMany.preview));
  check("隐藏 continuation 原生 swipes 计入候选总数：超限拒绝");

  /* ---------------------------------------------------------------- */
  heading("B. 服务/存储");
  const libA = createLibrary("service", ["世界向导", "另一个角色"]);
  const bufferA = Buffer.from(validSource);
  const servicePreview = libA.service.preview(bufferA, "导出 酒馆.jsonl");
  assert.equal(servicePreview.valid, true, issueText(servicePreview));
  assert.equal(servicePreview.suggestedCharacter, "世界向导");
  const filesBeforeImport = allFiles(path.join(libA.root, "chats"));
  const imported = libA.service.import(bufferA, { fileName: "导出 酒馆.jsonl", character: "世界向导", expectedSha256: servicePreview.sha256 });
  const importedFile = libA.store.resolveChatFile(imported.id);
  assert.ok(importedFile && fs.existsSync(importedFile));
  assert.match(path.basename(importedFile!), /^\d{4}-\d{2}-\d{2}@\d{2}h\d{2}m\d{2}s\.jsonl$/);
  const importedRaw = fs.readFileSync(importedFile!, "utf8").split("\n");
  const importedHeader = JSON.parse(importedRaw[0]);
  assert.equal(importedHeader.character_name, "世界向导");
  assert.equal(importedHeader.chat_metadata._pitavernTitle, imported.title);
  assert.equal(importedHeader.chat_metadata._pitavernImport.sha256, servicePreview.sha256);
  assert.equal(importedHeader.chat_metadata._pitavernImport.fileName, "导出 酒馆.jsonl");
  assert.deepEqual(importedHeader.chat_metadata.customMetadata, { keep: true });
  assert.deepEqual(importedHeader.chat_metadata.variables, { gold: 0 });
  assert.deepEqual(importedHeader.chat_metadata[WORLD_STATE_KEY], initialWorld);
  assert.deepEqual(importedHeader.chat_metadata[WORLD_TEMPLATES_KEY], { [templateRecord.contentHash]: templateRecord });
  assert.equal(importedHeader.unknownHeader, "保留");
  assert.deepEqual(importedRaw.slice(1), Buffer.from(validSource).toString("utf8").split("\n").slice(1), "消息行与未知字段必须原样保留");
  assert.ok(importedRaw.at(-1) === "");
  assert.equal(libA.store.listChats().length, 1);
  assert.equal(libA.store.listChats().find((chat) => chat.id === imported.id)!.displayName, imported.title);
  assert.equal(libA.store.statChat(importedFile!)!.messageCount, 3);
  assert.equal(allFiles(path.join(libA.root, "chats")).length, filesBeforeImport.length + 1);
  check("预览→导入：文件落盘、时间戳文件名、头改写、未知字段与消息行原样保留");

  const filesAfterImport = allFiles(path.join(libA.root, "chats"));
  expectImportError(() => libA.service.import(bufferA, { fileName: "导出 酒馆.jsonl", character: "世界向导" }), "duplicate", "已经导入");
  assert.deepEqual(allFiles(path.join(libA.root, "chats")), filesAfterImport);
  const duplicatePreview = libA.service.preview(bufferA, "导出 酒馆.jsonl");
  assert.equal(duplicatePreview.duplicate?.chatId, imported.id);
  check("重复文件：409/duplicate，不新增任何聊天文件");

  const sourceB = jsonl(chatHeader({ user_name: "第二旅人" }), ...validMessages);
  expectImportError(() => libA.service.import(Buffer.from(sourceB), { fileName: "第二个.jsonl", character: "不存在的角色" }), "invalid", "关联角色不存在");
  assert.deepEqual(allFiles(path.join(libA.root, "chats")), filesAfterImport);
  const titlePreview = libA.service.preview(Buffer.from(sourceB), "第二个.jsonl");
  assert.equal(titlePreview.suggestedTitle, imported.title + " (2)");
  const importedB = libA.service.import(Buffer.from(sourceB), { fileName: "第二个.jsonl", character: "世界向导" });
  assert.equal(importedB.title, imported.title + " (2)");
  assert.equal(new Set(libA.store.listChats().map((chat) => chat.displayName)).size, 2);
  check("不存在角色拒绝且不落盘；同名标题自动追加 (2)");

  const filesBeforeRejectedImports = allFiles(path.join(libA.root, "chats"));
  expectImportError(() => libA.service.import(Buffer.from('{"mes":42}\n'), { fileName: "坏首条.jsonl", character: "世界向导" }), "invalid");
  const oversizedSwipesSource = jsonl(chatHeader(), {
    name: "世界向导", mes: "开场", swipes: Array.from({ length: 10001 }, (_, index) => "候选" + index), swipe_id: 0,
  });
  expectImportError(() => libA.service.import(Buffer.from(oversizedSwipesSource), { fileName: "超量 swipes.jsonl", character: "世界向导" }), "invalid");
  assert.deepEqual(allFiles(path.join(libA.root, "chats")), filesBeforeRejectedImports, "非法首条/超限候选不得留下聊天文件");
  check("非法首条与超限原生候选导入：拒绝且不落盘");

  const hiddenRoundtrip = createLibrary("hidden-roundtrip", ["世界向导"]);
  const smallHiddenContinuation: string[] = [];
  for (let index = 0; index < 20; index++) {
    smallHiddenContinuation.push(JSON.stringify({ name: "旅人", is_user: true, mes: "隐藏问题" + index, extra: { messageId: "hu" + index } }));
    smallHiddenContinuation.push(JSON.stringify({
      name: "世界向导", mes: "隐藏回答", swipes: Array.from({ length: 100 }, (_, swipe) => "隐藏" + swipe), swipe_id: 0,
    }));
  }
  const hiddenRoundtripSource = jsonl({ user_name: "旅人", character_name: "世界向导", chat_metadata: {} }, {
    name: "旅人", is_user: true, mes: "入口", extra: { messageId: "root", _pitavernReplies: { selected: 0, versions: [
      { messages: [{ name: "世界向导", mes: "当前" }] },
      { messages: [{ name: "世界向导", mes: "隐藏" }], continuation: smallHiddenContinuation },
    ] } },
  }, { name: "世界向导", mes: "当前" });
  const hiddenRoundtripPreview = hiddenRoundtrip.service.preview(Buffer.from(hiddenRoundtripSource), "隐藏 分支.jsonl");
  assert.equal(hiddenRoundtripPreview.valid, true, issueText(hiddenRoundtripPreview));
  assert.ok(hiddenRoundtripPreview.candidates >= 2002, "隐藏分支候选未计入：" + hiddenRoundtripPreview.candidates);
  const hiddenRoundtripImport = hiddenRoundtrip.service.import(Buffer.from(hiddenRoundtripSource), {
    fileName: "隐藏 分支.jsonl", character: "世界向导", expectedSha256: hiddenRoundtripPreview.sha256,
  });
  hiddenRoundtrip.store.selectReply(hiddenRoundtripImport.id, "root", 1, hiddenRoundtrip.store.revisionId(hiddenRoundtripImport.id));
  const hiddenExported = fs.readFileSync(hiddenRoundtrip.store.resolveChatFile(hiddenRoundtripImport.id)!, "utf8");
  const hiddenAfterSwitch = parseText(hiddenExported, "隐藏 分支 导出.jsonl", ["世界向导"]);
  assert.equal(hiddenAfterSwitch.preview.valid, true, issueText(hiddenAfterSwitch.preview));
  assert.ok(hiddenAfterSwitch.preview.candidates >= 2002, "切换后候选数不一致：" + hiddenAfterSwitch.preview.candidates);
  const hiddenRoundtripTarget = createLibrary("hidden-roundtrip-target", ["世界向导"]);
  const hiddenReimportPreview = hiddenRoundtripTarget.service.preview(Buffer.from(hiddenExported), "隐藏 分支 导出.jsonl");
  assert.equal(hiddenReimportPreview.valid, true, issueText(hiddenReimportPreview));
  const hiddenReimported = hiddenRoundtripTarget.service.import(Buffer.from(hiddenExported), {
    fileName: "隐藏 分支 导出.jsonl", character: "世界向导", expectedSha256: hiddenReimportPreview.sha256,
  });
  assert.ok(hiddenRoundtripTarget.store.readDocument(hiddenReimported.id));
  check("导入→切隐藏分支→导出→再导入：隐藏原生候选与状态保留");

  const libHeaderless = createLibrary("headerless", ["补头角色"]);
  const headerlessImport = libHeaderless.service.import(Buffer.from(headerless), { fileName: "无头 聊天.jsonl", character: "补头角色" });
  const headerlessRaw = fs.readFileSync(libHeaderless.store.resolveChatFile(headerlessImport.id)!, "utf8").split("\n");
  const addedHeader = JSON.parse(headerlessRaw[0]);
  assert.equal(addedHeader.character_name, "补头角色");
  assert.equal(addedHeader.user_name, "User");
  assert.equal(addedHeader.chat_metadata._pitavernTitle, headerlessImport.title);
  assert.deepEqual(headerlessRaw.slice(1), headerless.split("\n"));
  check("无头文件导入：补建 user_name/character_name 头且消息原样");

  const libAtomic = createLibrary("atomic", ["世界向导"]);
  fs.mkdirSync(path.join(libAtomic.root, ".pitavern"), { recursive: true });
  fs.writeFileSync(path.join(libAtomic.root, ".pitavern", "chat-imports"), "占位文件，模拟索引目录不可写");
  expectImportError(() => libAtomic.service.import(Buffer.from(validSource), { fileName: "原子 失败.jsonl", character: "世界向导" }), "invalid", "索引写入失败");
  assert.deepEqual(allFiles(path.join(libAtomic.root, "chats")), [], "索引失败不得留下聊天或临时文件");
  assert.ok(!allFiles(libAtomic.root).some((file) => file.endsWith(".tmp")), "不得留下 .tmp 半成品");
  fs.rmSync(path.join(libAtomic.root, ".pitavern", "chat-imports"));
  const atomicRetry = libAtomic.service.import(Buffer.from(validSource), { fileName: "原子 失败.jsonl", character: "世界向导" });
  assert.ok(fs.existsSync(libAtomic.store.resolveChatFile(atomicRetry.id)!));
  check("索引写入失败：撤销新聊天、清理临时文件；恢复后重试成功");

  const libIndex = createLibrary("index", ["世界向导"]);
  const indexFirst = libIndex.service.import(Buffer.from(validSource), { fileName: "索引 一.jsonl", character: "世界向导" });
  const indexSecondSource = jsonl(chatHeader({ _pitavernTitle: "第二档", user_name: "旅人二" }), { name: "世界向导", mes: "第二份内容" });
  const indexPath = path.join(libIndex.root, ".pitavern", "chat-imports", "index.json");
  fs.writeFileSync(indexPath, "{ 损坏的索引");
  const brokenPreview = libIndex.service.preview(Buffer.from(indexSecondSource), "索引 二.jsonl");
  assert.ok(brokenPreview.warnings.some((warning) => warning.includes("索引损坏")));
  const indexSecond = libIndex.service.import(Buffer.from(indexSecondSource), { fileName: "索引 二.jsonl", character: "世界向导" });
  assert.notEqual(indexSecond.id, indexFirst.id);
  const rebuilt = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  assert.equal(rebuilt.version, 1);
  assert.ok(rebuilt.imports[sha256(Buffer.from(indexSecondSource))]);
  assert.ok(fs.readdirSync(path.dirname(indexPath)).some((name) => name.startsWith("index.json.broken-")));
  assert.ok(fs.existsSync(libIndex.store.resolveChatFile(indexFirst.id)!), "索引重建不得删除已有聊天");
  expectImportError(() => libIndex.service.import(Buffer.from(indexSecondSource), { fileName: "索引 二.jsonl", character: "世界向导" }), "duplicate");
  check("索引损坏：保留副本并重建，导入继续且新重复记录生效");

  const restartedStore = new ChatStore(libA.root);
  assert.ok(restartedStore.readDocument(imported.id));
  assert.deepEqual(restartedStore.readMetadata(imported.id)[WORLD_STATE_KEY], initialWorld);
  assert.equal(restartedStore.listChats().find((chat) => chat.id === imported.id)!.displayName, imported.title);
  const restartedService = new ChatImportService(libA.root, restartedStore, new CharacterStore(path.join(libA.root, "characters")));
  expectImportError(() => restartedService.import(bufferA, { fileName: "导出 酒馆.jsonl", character: "世界向导" }), "duplicate");
  check("ChatStore 重启读取聊天/世界/标题；导入索引跨重启仍识别重复");

  const originalBytes = fs.readFileSync(importedFile!, "utf8");
  libA.store.editMessage(imported.id, "a1", "编辑后的回答", "回答 A");
  const backups = libA.store.backups(imported.id).backups;
  assert.ok(backups.length >= 1);
  libA.store.restoreBackup(imported.id, backups[0].id, libA.store.revisionId(imported.id));
  assert.equal(fs.readFileSync(importedFile!, "utf8"), originalBytes, "备份恢复后内容必须与导入时一致");
  assert.equal(libA.store.readChat(imported.id)!.find((line) => line.extra?.messageId === "a1")!.mes, "回答 A");
  expectImportError(() => libA.service.import(bufferA, { fileName: "导出 酒馆.jsonl", character: "世界向导" }), "duplicate");
  check("聊天备份恢复：内容/未知字段/世界不变，重复索引仍有效");

  const libConfig = makeConfig(libA.root);
  const backupStore = new LibraryBackupStore(libA.root);
  const archive = await backupStore.export();
  const backupPreview = await backupStore.preview(fs.createReadStream(archive));
  assert.ok(backupPreview.counts.chats >= 1);
  assert.ok(backupPreview.counts[".pitavern"] >= 1);
  const restoredLibrary = await backupStore.restore(backupPreview.id, libConfig);
  assert.equal(restoredLibrary.previousDataDir, libA.root);
  assert.notEqual(restoredLibrary.stDataDir, libA.root);
  assert.equal(libConfig.stDataDir, restoredLibrary.stDataDir);
  const restoredStore = new ChatStore(restoredLibrary.stDataDir);
  assert.ok(restoredStore.readDocument(imported.id));
  assert.deepEqual(restoredStore.readMetadata(imported.id)[WORLD_STATE_KEY], initialWorld);
  assert.equal(restoredStore.listChats().find((chat) => chat.id === imported.id)!.displayName, imported.title);
  const restoredService = new ChatImportService(restoredLibrary.stDataDir, restoredStore, new CharacterStore(path.join(restoredLibrary.stDataDir, "characters")));
  expectImportError(() => restoredService.import(bufferA, { fileName: "导出 酒馆.jsonl", character: "世界向导" }), "duplicate");
  assert.ok(fs.existsSync(path.join(restoredLibrary.stDataDir, ".pitavern", "chat-imports", "index.json")));
  check("整库备份恢复：聊天、世界、标题与导入索引原样可用");

  /* ---------------------------------------------------------------- */
  heading("C. 世界/分支闭环（导出→导入→切换→重生成→重启→备份恢复）");
  const worldSourceRoot = path.join(RUN, "world-source");
  writeCard(worldSourceRoot, "世界向导");
  const worldSource = new ChatStore(worldSourceRoot);
  const greeting: Omit<StChatLine, "send_date"> = { name: "世界向导", is_user: false, is_system: false, mes: "欢迎来到酒馆。", extra: { messageId: "greet-1", unknownGreeting: "保留" } };
  const worldChat = worldSource.createChat("世界向导", greeting, "旅人", { customMeta: { keep: true }, variables: { gold: 0 }, projection: "旧投影" });
  worldSource.initializeWorld(worldChat.id, template);
  assert.equal(worldSource.readWorld(worldChat.id)!.snapshot.money.player, 20);
  const before1: any = stateFields(worldSource.readMetadata(worldChat.id));
  before1.customCheckpoint = "保留";
  worldSource.appendMessage(worldChat.id, {
    name: "旅人", is_user: true, is_system: false, mes: "我买一把剑",
    extra: { messageId: "user-a", unknownTurn: "保留一", _pitavernBeforeTurn: { metadata: before1, enforcement: { turn: 0, usedThisTurn: 0, cooldownUntilTurn: 0 } } },
  });
  worldSource.appendMessage(worldChat.id, { name: "世界向导", is_user: false, is_system: false, mes: "回答甲", extra: { messageId: "assistant-a", unknownAssistant: "保留甲" } });
  const regeneration = worldSource.prepareRegeneration(worldChat.id, "assistant-a", "回答甲");
  const transaction = new WorldTransaction(worldSource.readWorld(worldChat.id)!, 1);
  const staged = transaction.execute({ commandId: "buy-1", type: "purchase_item", buyerId: "player", sellerId: "merchant", itemId: "sword", quantity: 1 });
  assert.equal(staged.status, "staged");
  const worldB = transaction.commit();
  assert.equal(worldB.money.player, 10);
  regeneration.commit([{ name: "世界向导", is_user: false, is_system: false, mes: "回答乙", send_date: new Date().toISOString(), extra: { messageId: "assistant-b", unknownAssistant: "保留乙" } }],
    { ...regeneration.metadata, [WORLD_STATE_KEY]: worldB, variables: { gold: 1 }, _pitavernEnforcement: { turn: 1, usedThisTurn: 0, cooldownUntilTurn: 0 } });
  assert.equal(worldSource.readWorld(worldChat.id)!.snapshot.money.player, 10);
  worldSource.appendMessage(worldChat.id, {
    name: "旅人", is_user: true, is_system: false, mes: "继续赶路",
    extra: { messageId: "user-b", unknownTurn: "保留二", _pitavernBeforeTurn: { metadata: stateFields(worldSource.readMetadata(worldChat.id)), enforcement: { turn: 1, usedThisTurn: 0, cooldownUntilTurn: 0 } } },
  });
  worldSource.appendMessage(worldChat.id, { name: "世界向导", is_user: false, is_system: false, mes: "回答丙", extra: { messageId: "assistant-c", unknownAssistant: "保留丙" } });
  worldSource.selectReply(worldChat.id, "user-a", 0, worldSource.revisionId(worldChat.id));
  assert.equal(worldSource.readWorld(worldChat.id)!.snapshot.money.player, 20);
  worldSource.appendMessage(worldChat.id, {
    name: "旅人", is_user: true, is_system: false, mes: "改去集市",
    extra: { messageId: "user-c", unknownTurn: "保留三", _pitavernBeforeTurn: { metadata: stateFields(worldSource.readMetadata(worldChat.id)), enforcement: { turn: 1, usedThisTurn: 0, cooldownUntilTurn: 0 } } },
  });
  worldSource.appendMessage(worldChat.id, { name: "世界向导", is_user: false, is_system: false, mes: "回答丁", extra: { messageId: "assistant-d", unknownAssistant: "保留丁" } });
  worldSource.selectReply(worldChat.id, "user-a", 1, worldSource.revisionId(worldChat.id));
  assert.equal(worldSource.readWorld(worldChat.id)!.snapshot.money.player, 10);
  assert.deepEqual(worldSource.readMetadata(worldChat.id).variables, { gold: 1 });
  const sourceCatalog = (worldSource.readChat(worldChat.id)!.find((line) => line.extra?.messageId === "user-a")!.extra!._pitavernReplies as any);
  assert.equal(sourceCatalog.versions.length, 2);
  assert.equal(sourceCatalog.selected, 1);
  assert.equal(sourceCatalog.versions[0].state[WORLD_STATE_KEY].money.player, 20);
  assert.equal(sourceCatalog.versions[1].state[WORLD_STATE_KEY].money.player, 10);
  assert.ok(sourceCatalog.versions[0].continuation?.some((raw: string) => raw.includes("user-c")));
  assert.equal(sourceCatalog.versions[1].continuation, undefined);
  check("源聊天构造：世界初始化、候选 A/B、隐藏 continuation、检查点与未知字段");

  const exported = fs.readFileSync(worldChat.file, "utf8");
  const exportedLines = exported.split("\n");
  const exportedHeader = JSON.parse(exportedLines[0]);
  assert.equal(exportedHeader.chat_metadata[WORLD_STATE_KEY].money.player, 10);
  const worldImportRoot = path.join(RUN, "world-import");
  writeCard(worldImportRoot, "导入向导");
  const worldImportStore = new ChatStore(worldImportRoot);
  const worldImportCharacters = new CharacterStore(path.join(worldImportRoot, "characters"));
  const worldImportService = new ChatImportService(worldImportRoot, worldImportStore, worldImportCharacters);
  const exportBuffer = Buffer.from(exported, "utf8");
  const worldPreview = worldImportService.preview(exportBuffer, "世界 分支 导出 2026.jsonl");
  assert.equal(worldPreview.valid, true, issueText(worldPreview));
  assert.equal(worldPreview.hasHeader, true);
  assert.equal(worldPreview.characterKnown, false);
  assert.equal(worldPreview.suggestedCharacter, null);
  assert.ok(worldPreview.warnings.some((warning) => warning.includes("不在资料库")));
  assert.equal(worldPreview.world?.capability, "enabled");
  assert.equal(worldPreview.hiddenContinuations, 1);
  assert.ok(worldPreview.branchPoints >= 1);
  assert.ok(worldPreview.candidates >= 2);
  const worldImported = worldImportService.import(exportBuffer, { fileName: "世界 分支 导出 2026.jsonl", character: "导入向导", expectedSha256: worldPreview.sha256 });
  const worldImportedFile = worldImportStore.resolveChatFile(worldImported.id)!;
  assert.match(path.basename(worldImportedFile), /^\d{4}-\d{2}-\d{2}@\d{2}h\d{2}m\d{2}s\.jsonl$/);
  const importedWorldLines = fs.readFileSync(worldImportedFile, "utf8").split("\n");
  const importedWorldHeader = JSON.parse(importedWorldLines[0]);
  assert.equal(importedWorldHeader.character_name, "导入向导");
  assert.equal(importedWorldHeader.chat_metadata._pitavernTitle, worldImported.title);
  assert.equal(importedWorldHeader.chat_metadata._pitavernImport.sha256, worldPreview.sha256);
  assert.deepEqual(importedWorldHeader.chat_metadata.customMeta, { keep: true });
  assert.deepEqual(importedWorldHeader.chat_metadata[WORLD_STATE_KEY], exportedHeader.chat_metadata[WORLD_STATE_KEY]);
  assert.deepEqual(importedWorldHeader.chat_metadata[WORLD_TEMPLATES_KEY], exportedHeader.chat_metadata[WORLD_TEMPLATES_KEY]);
  assert.deepEqual(importedWorldLines.slice(1), exportedLines.slice(1), "候选/隐藏 continuation/未知字段/检查点必须逐行保留");
  check("原始 JSONL 导出→新资料库导入：头改写、未知字段、世界模板、候选与 continuation 原样");

  assert.equal(worldImportStore.readWorld(worldImported.id)!.snapshot.money.player, 10);
  assert.deepEqual(worldImportStore.readMetadata(worldImported.id).variables, { gold: 1 });
  worldImportStore.selectReply(worldImported.id, "user-a", 0, worldImportStore.revisionId(worldImported.id));
  assert.equal(worldImportStore.readWorld(worldImported.id)!.snapshot.money.player, 20);
  assert.deepEqual(worldImportStore.readMetadata(worldImported.id).variables, { gold: 0 });
  const branchALines = worldImportStore.readChat(worldImported.id)!;
  assert.ok(branchALines.some((line) => line.extra?.messageId === "assistant-a"));
  assert.ok(branchALines.some((line) => line.extra?.messageId === "assistant-d"));
  assert.ok(branchALines.some((line) => line.extra?.messageId === "user-c"));
  assert.ok(!branchALines.some((line) => line.extra?.messageId === "assistant-c"));
  assert.equal(branchALines.find((line) => line.extra?.messageId === "assistant-a")!.extra!.unknownAssistant, "保留甲");
  assert.equal(branchALines.find((line) => line.extra?.messageId === "user-c")!.extra!.unknownTurn, "保留三");
  const catalogA = (branchALines.find((line) => line.extra?.messageId === "user-a")!.extra!._pitavernReplies as any);
  assert.ok(catalogA.versions[1].continuation?.some((raw: string) => raw.includes("user-b")));
  worldImportStore.selectReply(worldImported.id, "user-a", 1, worldImportStore.revisionId(worldImported.id));
  assert.equal(worldImportStore.readWorld(worldImported.id)!.snapshot.money.player, 10);
  const branchBLines = worldImportStore.readChat(worldImported.id)!;
  assert.ok(branchBLines.some((line) => line.extra?.messageId === "assistant-c"));
  assert.ok(branchBLines.some((line) => line.extra?.messageId === "user-b"));
  assert.ok(!branchBLines.some((line) => line.extra?.messageId === "user-c"));
  check("导入后切换隐藏分支：世界快照/变量/候选连续性/未知字段随分支各自恢复");

  const restartedWorldStore = new ChatStore(worldImportRoot);
  assert.equal(restartedWorldStore.readWorld(worldImported.id)!.snapshot.money.player, 10);
  assert.ok(restartedWorldStore.readChat(worldImported.id)!.some((line) => line.extra?.messageId === "assistant-c"));
  restartedWorldStore.selectReply(worldImported.id, "user-a", 0, restartedWorldStore.revisionId(worldImported.id));
  assert.equal(restartedWorldStore.readWorld(worldImported.id)!.snapshot.money.player, 20);
  restartedWorldStore.selectReply(worldImported.id, "user-a", 1, restartedWorldStore.revisionId(worldImported.id));
  assert.equal(restartedWorldStore.readWorld(worldImported.id)!.snapshot.money.player, 10);
  check("新 ChatStore 重启读取：候选/世界/隐藏 continuation 仍可切换");

  const beforeEdit = fs.readFileSync(worldImportedFile, "utf8");
  const backupsBeforeEdit = new Set(worldImportStore.backups(worldImported.id).backups.map((backup) => backup.id));
  worldImportStore.editMessage(worldImported.id, "assistant-c", "编辑后的回答丙", "回答丙");
  // 同一毫秒内可能有多份备份；按“编辑前不存在的 ID”选本次备份，避免随机 UUID 排序造成假失败。
  const worldBackup = worldImportStore.backups(worldImported.id).backups.find((backup) => !backupsBeforeEdit.has(backup.id));
  assert.ok(worldBackup);
  worldImportStore.restoreBackup(worldImported.id, worldBackup.id, worldImportStore.revisionId(worldImported.id));
  assert.equal(fs.readFileSync(worldImportedFile, "utf8"), beforeEdit, "聊天备份恢复后分支与未知字段不变");
  assert.equal(worldImportStore.readWorld(worldImported.id)!.snapshot.money.player, 10);
  check("聊天备份恢复：导入后的分支文件逐字节恢复");

  mockMode = "world";
  const worldConfig = makeConfig(worldImportRoot);
  const worldModels = { current: buildModels(worldConfig) };
  const worldManager = new SessionManager(worldConfig, () => worldModels.current, worldImportCharacters, worldImportStore, worldImportRoot);
  const requestsBefore = mockRequests.length;
  await worldManager.regenerate(worldImported.id, "assistant-c", "回答丙");
  assert.equal(mockRequests.length, requestsBefore + 2, "应有工具调用与正文两次合成请求");
  assert.ok(JSON.stringify(mockRequests[requestsBefore]).includes("world_command"), "合成请求必须带世界工具");
  const regeneratedLines = worldImportStore.readChat(worldImported.id)!;
  assert.equal(regeneratedLines.at(-1)!.mes, "导入后重生成正文");
  assert.equal(worldImportStore.readWorld(worldImported.id)!.snapshot.clockMinutes, 30);
  assert.deepEqual(worldImportStore.readMetadata(worldImported.id).variables, { gold: 1 });
  assert.equal((worldImportStore.readMetadata(worldImported.id).customMeta as any).keep, true);
  assert.equal(worldImportStore.readWorld(worldImported.id)!.template?.templateId, template.templateId);
  const userBLine = regeneratedLines.find((line) => line.extra?.messageId === "user-b")!;
  const regeneratedCatalog = userBLine.extra!._pitavernReplies as any;
  assert.equal(regeneratedCatalog.versions.length, 2);
  assert.equal(regeneratedCatalog.selected, 1);
  assert.equal(regeneratedCatalog.versions[1].state[WORLD_STATE_KEY].clockMinutes, 30);
  check("导入后本地 mock SSE 重生成：正文落库、world_command 提交（时钟 30）、变量与候选保留");

  const afterRegenStore = new ChatStore(worldImportRoot);
  assert.equal(afterRegenStore.readWorld(worldImported.id)!.snapshot.clockMinutes, 30);
  assert.equal(afterRegenStore.readChat(worldImported.id)!.at(-1)!.mes, "导入后重生成正文");
  assert.equal((afterRegenStore.readMetadata(worldImported.id).customMeta as any).keep, true);
  check("重生成后重启 ChatStore：正文/世界/未知元数据仍可读");

  const worldBackupStore = new LibraryBackupStore(worldImportRoot);
  const worldArchive = await worldBackupStore.export();
  const worldLibraryPreview = await worldBackupStore.preview(fs.createReadStream(worldArchive));
  const restoredWorldConfig = makeConfig(worldImportRoot);
  const restoredWorld = await worldBackupStore.restore(worldLibraryPreview.id, restoredWorldConfig);
  const restoredWorldStore = new ChatStore(restoredWorld.stDataDir);
  assert.equal(restoredWorldStore.readWorld(worldImported.id)!.snapshot.clockMinutes, 30);
  assert.equal(restoredWorldStore.readChat(worldImported.id)!.at(-1)!.mes, "导入后重生成正文");
  assert.deepEqual(restoredWorldStore.readMetadata(worldImported.id).variables, { gold: 1 });
  const restoredWorldService = new ChatImportService(restoredWorld.stDataDir, restoredWorldStore, new CharacterStore(path.join(restoredWorld.stDataDir, "characters")));
  expectImportError(() => restoredWorldService.import(exportBuffer, { fileName: "世界 分支 导出 2026.jsonl", character: "导入向导" }), "duplicate");
  restoredWorldStore.selectReply(worldImported.id, "user-a", 0, restoredWorldStore.revisionId(worldImported.id));
  assert.equal(restoredWorldStore.readWorld(worldImported.id)!.snapshot.money.player, 20);
  check("整库备份恢复：导入聊天、重生成世界提交、分支与导入索引全部保留");

  /* ---------------------------------------------------------------- */
  heading("D. HTTP");
  const httpRoot = path.join(RUN, "http");
  writeCard(httpRoot, "世界向导");
  const httpConfig = makeConfig(httpRoot);
  const httpCharacters = new CharacterStore(path.join(httpRoot, "characters"));
  const httpStore = new ChatStore(httpRoot);
  const httpModels = { current: buildModels(httpConfig) };
  const httpSessions = new SessionManager(httpConfig, () => httpModels.current, httpCharacters, httpStore, httpRoot);
  httpServer = http.createServer(createHttpApp({ config: httpConfig, modelsRef: httpModels, characters: httpCharacters, chats: httpStore, sessions: httpSessions, stDataDir: httpRoot, webDistDir: null }));
  httpServer.listen(0, "127.0.0.1");
  await once(httpServer, "listening");
  const base = "http://127.0.0.1:" + (httpServer.address() as AddressInfo).port;
  const rawHeaders = (fileName: string) => ({ "Content-Type": "application/octet-stream", "x-file-name": encodeURIComponent(fileName) });
  const previewRequest = (buffer: Buffer, fileName: string) => fetch(base + "/api/chat-import/preview", { method: "POST", headers: rawHeaders(fileName), body: new Uint8Array(buffer) });
  const importRequest = (buffer: Buffer, fileName: string, query: Record<string, string>) => fetch(base + "/api/chat-import?" + new URLSearchParams(query).toString(), { method: "POST", headers: rawHeaders(fileName), body: new Uint8Array(buffer) });
  const importParams = (character: string, sha?: string, title?: string) => ({ character, ...(sha ? { sha256: sha } : {}), ...(title ? { title } : {}) });

  const httpPreviewResponse = await previewRequest(Buffer.from(validSource), "我的 聊天 导出 3.jsonl");
  assert.equal(httpPreviewResponse.status, 200);
  const httpPreview = await httpPreviewResponse.json() as any;
  assert.equal(httpPreview.valid, true);
  assert.equal(httpPreview.fileName, "我的 聊天 导出 3.jsonl");
  assert.equal(httpPreview.suggestedTitle, "酒馆 旧档");
  const badPreviewResponse = await previewRequest(Buffer.from([JSON.stringify(chatHeader()), "{坏行"].join("\n") + "\n"), "坏 文件.jsonl");
  assert.equal(badPreviewResponse.status, 200);
  const badPreview = await badPreviewResponse.json() as any;
  assert.equal(badPreview.valid, false);
  assert.ok(badPreview.errors.some((issue: any) => issue.code === "json"));
  check("HTTP 预览：200+valid，中文空格 x-file-name，坏文件 200+valid=false");

  const missingParams = await fetch(base + "/api/chat-import", { method: "POST", headers: rawHeaders("缺参.jsonl"), body: new Uint8Array(Buffer.from(validSource)) });
  assert.equal(missingParams.status, 400);
  const badImport = await importRequest(Buffer.from([JSON.stringify(chatHeader()), "{坏行"].join("\n") + "\n"), "坏 文件.jsonl", importParams("世界向导"));
  assert.equal(badImport.status, 422);
  const badImportBody = await badImport.json() as any;
  assert.ok(Array.isArray(badImportBody.issues) && badImportBody.issues.length > 0);
  const missingCharacter = await importRequest(Buffer.from(validSource), "缺角色.jsonl", importParams("不存在"));
  assert.equal(missingCharacter.status, 422);
  const shaMismatch = await importRequest(Buffer.from(validSource), "哈希冲突.jsonl", importParams("世界向导", "0".repeat(64)));
  assert.equal(shaMismatch.status, 409);
  check("HTTP 导入参数缺失 400、坏文件 422、不存在角色 422、sha 不一致 409");

  const httpImportResponse = await importRequest(Buffer.from(validSource), "我的 聊天 导出 3.jsonl", importParams("世界向导", httpPreview.sha256));
  assert.equal(httpImportResponse.status, 200);
  const httpImported = await httpImportResponse.json() as any;
  assert.equal(typeof httpImported.id, "string");
  assert.equal(httpImported.character, "世界向导");
  const httpFile = httpStore.resolveChatFile(httpImported.id)!;
  assert.ok(fs.existsSync(httpFile));
  const httpHeader = JSON.parse(fs.readFileSync(httpFile, "utf8").split("\n")[0]);
  assert.equal(httpHeader.character_name, "世界向导");
  assert.equal(httpHeader.chat_metadata._pitavernImport.fileName, "我的 聊天 导出 3.jsonl");
  assert.match(path.basename(httpFile), /^\d{4}-\d{2}-\d{2}@\d{2}h\d{2}m\d{2}s\.jsonl$/);
  const chatsResponse = await fetch(base + "/api/chats");
  assert.equal(chatsResponse.status, 200);
  const chatsBody = await chatsResponse.json() as any[];
  assert.ok(chatsBody.some((chat) => chat.id === httpImported.id && chat.displayName === httpImported.title));
  const duplicateResponse = await importRequest(Buffer.from(validSource), "我的 聊天 导出 3.jsonl", importParams("世界向导"));
  assert.equal(duplicateResponse.status, 409);
  const duplicateBody = await duplicateResponse.json() as any;
  assert.equal(duplicateBody.duplicate.chatId, httpImported.id);
  check("HTTP 导入成功 200、重复 409、标题/导入来源写入、聊天列表可见");

  const exportedResponse = await fetch(base + "/api/library-backup/export");
  assert.equal(exportedResponse.status, 200);
  const httpArchive = Buffer.from(await exportedResponse.arrayBuffer());
  assert.ok(httpArchive.length > 0);
  const backupPreviewResponse = await fetch(base + "/api/library-backup/preview", { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: new Uint8Array(httpArchive) });
  assert.equal(backupPreviewResponse.status, 200);
  const httpBackupPreview = await backupPreviewResponse.json() as any;
  const restoreResponse = await fetch(base + "/api/library-backup/restore", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: httpBackupPreview.id }) });
  assert.equal(restoreResponse.status, 200);
  const httpRestored = await restoreResponse.json() as any;
  assert.equal(httpRestored.restartRequired, true);
  assert.notEqual(httpRestored.stDataDir, httpRoot);
  const httpRestoredStore = new ChatStore(httpRestored.stDataDir);
  assert.ok(httpRestoredStore.readDocument(httpImported.id));
  assert.equal(httpRestoredStore.listChats().find((chat) => chat.id === httpImported.id)!.displayName, httpImported.title);
  const httpRestoredService = new ChatImportService(httpRestored.stDataDir, httpRestoredStore, new CharacterStore(path.join(httpRestored.stDataDir, "characters")));
  expectImportError(() => httpRestoredService.import(Buffer.from(validSource), { fileName: "我的 聊天 导出 3.jsonl", character: "世界向导" }), "duplicate");
  check("HTTP 整库备份→预览→恢复：导入聊天与索引保留并可在新 ChatStore 读取");

  console.log("\n" + checks + " 项检查全部通过。");
  console.log("测试数据保留目录：" + RUN);
  console.log("覆盖缺口：浏览器入口/移动端专项不在本脚本；真实供应商与模型未调用（世界提交由本地 mock SSE 覆盖）；整库备份只验证导入索引与聊天，不覆盖备份内便携设置的迁移；分支节点上限只验证单层 versions（跨层累计总数未单独构造）；200000 行仅验证上限拒绝，未做满行性能测试；HTTP 管理接口无鉴权，未测试鉴权分支。");
} finally {
  if (httpServer) { httpServer.closeAllConnections(); httpServer.close(); }
  mock.closeAllConnections();
  mock.close();
}
