/** 多分支树：任意历史回合切换、后续剧情保留、状态恢复、自动候选与换路线指令。 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { INSTRUCT_TEMPLATES } from "@pitavern/shared";

const root = path.resolve(import.meta.dirname, "../../..");
fs.mkdirSync(path.join(root, "data/test-runs"), { recursive: true });
const runDir = fs.mkdtempSync(path.join(root, "data/test-runs/branches-"));
process.env.PITAVERN_CONFIG = path.join(runDir, "config.json");
const { defaultConfig, seedDataDirs } = await import("../src/config.ts");
const { ChatStore } = await import("../src/stdata/chats.ts");
const { CharacterStore } = await import("../src/stdata/characters.ts");
const { buildModels } = await import("../src/providers/models.ts");
const { SessionManager } = await import("../src/session/manager.ts");
const { createHttpApp } = await import("../src/api/http.ts");

let mode = "normal";
let serial = 0;
const requests: any[] = [];
const mock = http.createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  requests.push(body);
  fs.writeFileSync(path.join(runDir, "request-" + requests.length + ".json"), JSON.stringify(body, null, 2));
  if (mode === "error") { res.writeHead(400); res.end("test failure"); return; }
  const text = "**分支回复 " + (++serial) + "**";
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const frame = (end: boolean) => "data: " + JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture",
    choices: [{ index: 0, delta: end ? {} : { role: "assistant", content: text }, finish_reason: end ? "stop" : null }],
    ...(end ? { usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } } : {}) }) + "\n\n";
  res.end(frame(false) + frame(true) + "data: [DONE]\n\n");
});
mock.listen(0, "127.0.0.1"); await once(mock, "listening");
const config = defaultConfig();
config.stDataDir = path.join(runDir, "st"); seedDataDirs(config.stDataDir);
config.providers = [{ id: "fixture", name: "fixture", baseUrl: "http://127.0.0.1:" + (mock.address() as AddressInfo).port + "/v1",
  apiType: "chat", instruct: INSTRUCT_TEMPLATES.ChatML, apiKey: "synthetic",
  models: [{ id: "fixture", name: "fixture", contextWindow: 32000, maxTokens: 500 }] }];
config.defaultProvider = "fixture"; config.defaultModel = "fixture"; config.toolsEnabled = false;
config.branches = { autoGenerate: 0 };
fs.writeFileSync(path.join(config.stDataDir, "characters/fixture.json"), JSON.stringify({ name: "向导", first_mes: "开场白" }));
const store = new ChatStore(config.stDataDir);
const characters = new CharacterStore(path.join(config.stDataDir, "characters"));
const modelsRef = { current: buildModels(config) };
const manager = new SessionManager(config, () => modelsRef.current, characters, store, config.stDataDir);
const server = http.createServer(createHttpApp({ config, modelsRef, characters, chats: store, sessions: manager, webDistDir: null, stDataDir: config.stDataDir }));
server.listen(0, "127.0.0.1"); await once(server, "listening");
const base = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
const read = (chatId: string) => manager.snapshot(chatId)!;
const userAt = (snapshot: ReturnType<typeof read>, index: number) => snapshot.messages.filter((m) => m.role === "user")[index]!;
const revision = (chatId: string) => store.revisionId(chatId);
const switchViaHttp = async (chatId: string, userMessageId: string, selected: number) => {
  const response = await fetch(base + "/api/chat/reply", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chatId, userMessageId, selected, revision: revision(chatId) }) });
  if (response.status !== 200) throw new Error("切换失败 " + response.status + " " + await response.text());
};
const waitFor = async (predicate: () => boolean, label: string, timeout = 8000) => {
  const end = Date.now() + timeout;
  while (!predicate()) { assert.ok(Date.now() < end, "等待超时: " + label); await new Promise((resolve) => setTimeout(resolve, 20)); }
};

try {
  const chat = store.createChat("向导", { name: "向导", is_user: false, is_system: false, mes: "开场白" });
  store.writeMetadata(chat.id, { variables: { value: "A" }, projection: "初始状态" });
  await manager.send(chat.id, "{{setvar::value::{{getvar::value}}x}}第一问");
  let snapshot = read(chat.id);
  assert.equal(snapshot.messages.length, 3);
  const a1 = snapshot.messages.at(-1)!;
  const user1 = userAt(snapshot, 0);
  assert.equal((store.readMetadata(chat.id).variables as any).value, "Ax");

  await manager.regenerate(chat.id, a1.id, a1.text);
  snapshot = read(chat.id);
  const a2 = snapshot.messages.at(-1)!;
  assert.notEqual(a2.text, a1.text);
  assert.equal(snapshot.replyChoices?.count, 2);
  assert.equal(snapshot.branchChoices?.length, 1);
  assert.equal(snapshot.branchChoices![0].turn, 1);
  assert.equal(snapshot.branchChoices![0].count, 2);
  assert.equal(snapshot.branchChoices![0].selected, 1);

  // 切回第一条分支，再继续往下写：新回合只属于该分支。
  await switchViaHttp(chat.id, user1.id, 0);
  snapshot = read(chat.id);
  assert.equal(snapshot.messages.at(-1)!.text, a1.text);
  assert.equal((store.readMetadata(chat.id).variables as any).value, "Ax");
  assert.equal(snapshot.branchChoices![0].selected, 0);
  await manager.send(chat.id, "{{setvar::value::第二}}第二问");
  snapshot = read(chat.id);
  const b1 = snapshot.messages.at(-1)!;
  const user2 = userAt(snapshot, 1);
  assert.equal((store.readMetadata(chat.id).variables as any).value, "第二");
  assert.equal(snapshot.messages.length, 5);

  // 切到另一条更早的分支：后续回合整体收进 continuation，再从文件消失。
  await switchViaHttp(chat.id, user1.id, 1);
  snapshot = read(chat.id);
  assert.equal(snapshot.messages.length, 3);
  assert.equal(snapshot.messages.at(-1)!.text, a2.text);
  assert.equal((store.readMetadata(chat.id).variables as any).value, "Ax", "切到短分支须恢复该分支末尾状态");
  assert.equal(snapshot.branchChoices![0].selected, 1);
  assert.equal(snapshot.branchChoices![0].candidates[0].hasContinuation, true, "未选中的长分支须保留后续剧情标记");
  const rawAfterTruncate = store.readChat(chat.id)!;
  assert.ok(!rawAfterTruncate.some((line) => line.mes.includes("第二问")), "活动 JSONL 只保留当前分支");
  const savedUser1 = rawAfterTruncate.find((line) => line.is_user)!;
  assert.ok(JSON.stringify(savedUser1.extra?._pitavernReplies).includes("第二问"), "后续剧情必须保存在候选 continuation 里");

  // 切回长分支：后续回合、状态和文件原样恢复。
  await switchViaHttp(chat.id, user1.id, 0);
  snapshot = read(chat.id);
  assert.equal(snapshot.messages.length, 5);
  assert.equal(snapshot.messages.at(-1)!.text, b1.text);
  assert.equal((store.readMetadata(chat.id).variables as any).value, "第二");

  // 第二轮也生成候选，形成嵌套/多层分支点。
  await manager.regenerate(chat.id, b1.id, b1.text);
  snapshot = read(chat.id);
  const b2 = snapshot.messages.at(-1)!;
  assert.equal(snapshot.branchChoices?.length, 2);
  assert.equal(snapshot.branchChoices![1].turn, 2);
  assert.equal(snapshot.branchChoices![1].count, 2);
  await switchViaHttp(chat.id, user2.id, 0);
  assert.equal(read(chat.id).messages.at(-1)!.text, b1.text);
  // 回到第一轮的另一条分支，再切回来，第二轮候选仍然完整。
  await switchViaHttp(chat.id, user1.id, 1);
  assert.equal(read(chat.id).messages.length, 3);
  await switchViaHttp(chat.id, user1.id, 0);
  snapshot = read(chat.id);
  assert.equal(snapshot.messages.at(-1)!.text, b1.text);
  await switchViaHttp(chat.id, user2.id, 1);
  assert.equal(read(chat.id).messages.at(-1)!.text, b2.text);
  assert.equal(read(chat.id).branchChoices?.length, 2);
  console.log("✓ 任意历史回合切换分支：状态恢复、后续剧情保留、嵌套分叉点与 JSONL 活动路径");

  // 过期 revision 必须拒绝；HTTP 会返回 409。
  const stale = revision(chat.id);
  await switchViaHttp(chat.id, user1.id, 1);
  const rejected = await fetch(base + "/api/chat/reply", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chatId: chat.id, userMessageId: user2.id, selected: 1, revision: stale }) });
  assert.equal(rejected.status, 409);
  await switchViaHttp(chat.id, user1.id, 0);
  console.log("✓ 分支切换 revision 冲突拒绝");

  // 换条路线的指令只发给本次模型请求，不写进聊天。
  const beforeInstruction = store.readChat(chat.id)!.length;
  const instructionText = "让向导拒绝邀请，改走夜探路线";
  await manager.regenerate(chat.id, read(chat.id).messages.at(-1)!.id, read(chat.id).messages.at(-1)!.text, instructionText);
  const sent = JSON.stringify(requests.at(-1));
  assert.ok(sent.includes(instructionText), "方向要求必须进入本次请求");
  assert.ok(!JSON.stringify(store.readChat(chat.id)).includes(instructionText), "方向要求不得落进聊天正文");
  assert.ok(store.readChat(chat.id)!.length >= beforeInstruction);
  const b3 = read(chat.id).messages.at(-1)!;
  assert.equal(read(chat.id).branchChoices?.length, 2);
  assert.equal(read(chat.id).branchChoices![1].count, 3);
  console.log("✓ 换路线指令只影响本次生成");

  // 自动候选分支：成功回复后自动追加 2 个候选。
  config.branches.autoGenerate = 2;
  const autoChat = store.createChat("向导", null);
  await manager.send(autoChat.id, "自动多分支");
  await waitFor(() => !manager.isStreaming(autoChat.id) && (read(autoChat.id).replyChoices?.count ?? 0) === 3, "自动生成 2 个候选");
  const autoSnapshot = read(autoChat.id);
  assert.equal(autoSnapshot.branchChoices?.length, 1);
  assert.equal(autoSnapshot.branchChoices![0].count, 3);
  assert.equal(autoSnapshot.messages.length, 2);
  assert.equal(autoSnapshot.messages.at(-1)!.role, "assistant");
  console.log("✓ 设置开启后自动追加候选分支（0→2 个额外候选）");

  // 服务器重启后分支树、状态和选中项仍可恢复。
  const reloaded = new SessionManager(config, () => modelsRef.current, characters, new ChatStore(config.stDataDir), config.stDataDir);
  const restored = reloaded.snapshot(chat.id)!;
  assert.equal(restored.branchChoices?.length, 2);
  assert.equal(restored.branchChoices![1].count, 3);
  assert.equal(restored.messages.at(-1)!.text, b3.text);
  const restoredUser1 = restored.messages.find((message) => message.role === "user")!;
  reloaded.selectReply(chat.id, restoredUser1.id, 1, reloaded.snapshot(chat.id)!.page!.revision);
  assert.equal(reloaded.snapshot(chat.id)!.messages.length, 3);
  console.log("✓ 重启后分支树、continuation 和状态恢复可继续切换");

  // 失败重生成不得改动已有分支。
  const beforeFailure = fs.readFileSync(chat.file, "utf8");
  const target = reloaded.snapshot(chat.id)!.messages.at(-1)!;
  mode = "error";
  await reloaded.regenerate(chat.id, target.id, target.text);
  assert.equal(fs.readFileSync(chat.file, "utf8"), beforeFailure, "失败时分支状态不变");
  console.log("✓ 重新生成失败时分支和 JSONL 状态不变");

  // 完整目录索引包含非活动路径上的嵌套分支；按祖先路径一次切换并保留元数据。
  mode = "normal";
  const indexResponse = await fetch(base + "/api/chat/branch-index?chatId=" + encodeURIComponent(chat.id));
  assert.equal(indexResponse.status, 200);
  const fullIndex = await indexResponse.json() as any;
  const allNodes: any[] = [];
  const walk = (nodes: any[]) => { for (const node of nodes) { allNodes.push(node); walk(node.children); } };
  walk(fullIndex.nodes);
  assert.ok(fullIndex.total > (reloaded.snapshot(chat.id)!.branchChoices?.length ?? 0), "目录必须包含非活动路径");
  assert.ok(allNodes.every((node) => typeof node.branchId === "string" && node.branchId), "每个目录节点必须带稳定 branchId");
  const deepLeaf = allNodes.find((node) => node.depth > 0 && node.children.length === 0 && !node.isActive);
  assert.ok(deepLeaf, "应能发现非活动路径上的深层叶子");
  assert.ok(deepLeaf.path.length > 1, "深层叶子应带完整祖先路径");
  const beforeSwitch = fs.readFileSync(chat.file, "utf8");
  const switchedResponse = await fetch(base + "/api/chat/branch-switch", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chatId: chat.id, revision: revision(chat.id), path: deepLeaf.path }) });
  const switchedText = await switchedResponse.text();
  assert.equal(switchedResponse.status, 200, switchedText);
  const switched = JSON.parse(switchedText) as any;
  assert.equal(switched.index.currentNodeId, deepLeaf.id, "跨层切换后必须定位到目标节点");
  assert.ok(fs.readFileSync(chat.file, "utf8") !== beforeSwitch, "切换必须写入目标活动路径");
  console.log("✓ 完整目录读取非活动嵌套分支，并支持一次跨层切换");

  const previewResponse = await fetch(base + "/api/chat/branch-preview?" + new URLSearchParams({
    chatId: chat.id, nodeId: deepLeaf.id, offset: "0", limit: "1" }));
  const previewText = await previewResponse.text();
  assert.equal(previewResponse.status, 200, previewText);
  const previewPage = JSON.parse(previewText) as any;
  assert.equal(previewPage.nodeId, deepLeaf.id);
  assert.ok(previewPage.total >= 1 && previewPage.messages.length <= 1);
  assert.equal(typeof previewPage.messages[0]?.text, "string");
  if (previewPage.nextOffset != null) {
    const nextResponse = await fetch(base + "/api/chat/branch-preview?" + new URLSearchParams({
      chatId: chat.id, nodeId: deepLeaf.id, offset: String(previewPage.nextOffset), limit: "1" }));
    const nextText = await nextResponse.text();
    assert.equal(nextResponse.status, 200, nextText);
    const nextPage = JSON.parse(nextText) as any;
    assert.notEqual(nextPage.messages[0]?.id, previewPage.messages[0]?.id, "分页必须返回后续原文");
  }
  console.log("✓ 分支全文预览按原文分页返回");

  const metaResponse = await fetch(base + "/api/chat/branch-meta", { method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chatId: chat.id, revision: revision(chat.id), nodeId: deepLeaf.id, patch: { name: "深层路线", favorite: true } }) });
  const metaText = await metaResponse.text();
  assert.equal(metaResponse.status, 200, metaText);
  const metaIndex = JSON.parse(metaText) as any;
  const metaNodes: any[] = []; const collect = (nodes: any[]) => { for (const node of nodes) { metaNodes.push(node); collect(node.children); } }; collect(metaIndex.index.nodes);
  const renamed = metaNodes.find((node) => node.id === deepLeaf.id);
  assert.equal(renamed.name, "深层路线");
  assert.equal(renamed.favorite, true);
  const reloadedIndex = new ChatStore(config.stDataDir).branchIndex(chat.id);
  const reloadedNodes: any[] = []; const collectReloaded = (nodes: any[]) => { for (const node of nodes) { reloadedNodes.push(node); collectReloaded(node.children); } }; collectReloaded(reloadedIndex.nodes);
  const reloadedMeta = reloadedNodes.find((node) => node.id === deepLeaf.id);
  assert.equal(reloadedMeta?.name, "深层路线", "重启/重新读取后名称保留");
  assert.equal(reloadedMeta?.favorite, true, "重启/重新读取后收藏保留");
  assert.equal(reloadedMeta?.branchId, deepLeaf.branchId, "branchId 跨读取稳定");
  console.log("✓ 分支名称与收藏写入 chat_metadata，刷新目录后保留");

  const beforeBadSwitch = fs.readFileSync(chat.file, "utf8");
  const badResponse = await fetch(base + "/api/chat/branch-switch", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chatId: chat.id, revision: revision(chat.id), path: [{ userMessageId: "missing-user", selected: 0 }] }) });
  assert.equal(badResponse.status, 409);
  assert.equal(fs.readFileSync(chat.file, "utf8"), beforeBadSwitch, "跨层切换失败不得留下中间状态");
  console.log("✓ 跨层切换失败时原 JSONL 原子保留");
} finally {
  server.close(); mock.close();
}
console.log("分支树验证全部通过，样本保留在 " + runDir);
