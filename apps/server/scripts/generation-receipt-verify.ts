import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import type { ClientMessage, ServerEvent } from "@pitavern/shared";
import { createHttpApp } from "../src/api/http.ts";
import { attachWebSocket } from "../src/api/ws.ts";
import { findGenerationRequest, REQUEST_KEY } from "../src/session/narrative.ts";
import { stateFields } from "../src/stdata/replies.ts";
import { twoStageFixture, submit } from "./two-stage-fixture.ts";

let checks = 0;
const check = (message: string) => { checks++; console.log("✓ " + message); };
const damaged = ["  damaged legacy row { 原样保留\r", '{"mes":"truncated'];
const receipt = (hash: string) => ({ is_user: false, extra: { [REQUEST_KEY]: { id: "saved-request", hash } } });
const hash = "committed-content";
const source = [damaged[0], "", JSON.stringify(receipt(hash)), damaged[1]].join("\n");
assert.equal(findGenerationRequest(source, "saved-request", hash), true);
assert.equal(findGenerationRequest(source, "missing-request", hash), false);
assert.throws(() => findGenerationRequest(source, "saved-request", "different-content"), /请求 ID/);
assert.throws(() => findGenerationRequest(source + "\n" + JSON.stringify(receipt("conflict")), "saved-request", hash), /请求 ID/);
check("顶层坏行与空行跳过后继续扫描合法回执，已匹配仍检查后续 ID 冲突");

const nested = JSON.stringify({ versions: [{ continuation: [damaged[0], JSON.stringify(receipt(hash)), damaged[1]] }] });
assert.equal(findGenerationRequest(damaged[0] + "\n" + nested, "saved-request", hash), true);
assert.throws(() => findGenerationRequest(nested, "saved-request", "different-content"), /请求 ID/);
check("隐藏 continuation 中的坏行不阻断合法回执，冲突仍拒绝");

const f = await twoStageFixture();
const server = http.createServer(createHttpApp({ config: f.config, modelsRef: { current: f.models }, characters: f.cards, chats: f.chats, sessions: f.sessions, stDataDir: f.data, webDistDir: null }));
attachWebSocket(server, f.sessions);
server.listen(0, "127.0.0.1");
await once(server, "listening");
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const ws = new WebSocket(base.replace("http:", "ws:") + "/ws");
await once(ws, "open");

async function command(message: ClientMessage & { chatId: string }): Promise<ServerEvent[]> {
  return new Promise((resolve, reject) => {
    const events: ServerEvent[] = [];
    const timer = setTimeout(() => { ws.off("message", listener); reject(new Error("WS command timeout")); }, 10_000);
    const listener = (raw: unknown) => {
      const event = JSON.parse(String(raw)) as ServerEvent;
      if (!("chatId" in event) || event.chatId !== message.chatId) return;
      events.push(event);
      if (event.type === "chat.finished") { clearTimeout(timer); ws.off("message", listener); resolve(events); }
    };
    ws.on("message", listener);
    ws.send(JSON.stringify(message));
  });
}
function noErrors(events: ServerEvent[]) { assert.deepEqual(events.filter(event => event.type === "chat.error"), []); }
function addDamagedRows(chat: { id: string; file: string }) {
  const lines = f.chats.readSource(chat.id).source.trimEnd().split("\n");
  lines.splice(1, 0, damaged[0]);
  lines.push(damaged[1]);
  fs.writeFileSync(chat.file, lines.join("\n") + "\n");
}
function preserved(chatId: string) {
  const lines = f.chats.readSource(chatId).source.split("\n");
  for (const row of damaged) assert.equal(lines.filter(line => line === row).length, 1);
}
const plan = (twoStage: boolean, text: string) => twoStage ? [{ calls: [submit] }, { text }] : [{ text }];
try {
  for (const kind of ["single-no-world", "single-world", "two-stage-world"] as const) {
    const twoStage = kind === "two-stage-world";
    f.config.twoStage = twoStage;
    const chat = kind === "single-no-world" ? f.chats.createChat("掌柜", null) : f.chat();
    addDamagedRows(chat);
    const send = { type: "chat.send" as const, chatId: chat.id, text: "公开问路", requestId: randomUUID(), revision: f.chats.revisionId(chat.id) };
    f.plan(kind + " send", plan(twoStage, "旧聊天继续生成"));
    noErrors(await command(send));
    assert.equal(f.count(), twoStage ? 2 : 1);
    assert.equal(f.chats.readChat(chat.id)!.at(-1)!.mes, "旧聊天继续生成");
    preserved(chat.id);
    const committed = f.chats.readSource(chat.id).source, requests = f.requests.length;
    noErrors(await command(send));
    assert.equal(f.requests.length, requests);
    assert.equal(f.chats.readSource(chat.id).source, committed);
    const conflictEvents = await command({ ...send, text: "同 ID 不同输入" });
    const conflictMessage = kind === "single-no-world" ? "请求 ID 已用于其他内容" : "本轮生成未完成，世界与知识未提交。";
    assert.deepEqual(conflictEvents.filter(event => event.type === "chat.error").map(event => event.message), [conflictMessage]);
    assert.equal(f.requests.length, requests);
    assert.equal(f.chats.readSource(chat.id).source, committed);
    check(kind + "：WS 携带 ID 可发送，坏行原文保留、重放不生成、冲突拒绝");

    if (kind === "single-no-world") continue;
    const reply = f.chats.readChat(chat.id)!.at(-1)!;
    const regenerate = { type: "chat.regenerate" as const, chatId: chat.id, messageId: String(reply.extra!.messageId), expectedText: reply.mes, requestId: randomUUID(), revision: f.chats.revisionId(chat.id) };
    f.plan(kind + " regenerate", plan(twoStage, "重生成候选"));
    noErrors(await command(regenerate));
    assert.equal(f.count(), twoStage ? 2 : 1);
    assert.equal(f.chats.readChat(chat.id)!.at(-1)!.mes, "重生成候选");
    assert.equal(f.sessions.snapshot(chat.id)!.replyChoices!.count, 2);
    preserved(chat.id);
    const regenerated = f.chats.readSource(chat.id).source, count = f.requests.length;
    noErrors(await command(regenerate));
    assert.equal(f.requests.length, count);
    assert.equal(f.chats.readSource(chat.id).source, regenerated);
    const regenerationConflict = await command({ ...regenerate, instruction: "不同路线复用 ID" });
    assert.deepEqual(regenerationConflict.filter(event => event.type === "chat.error").map(event => event.message), [conflictMessage]);
    assert.equal(f.requests.length, count);
    assert.equal(f.chats.readSource(chat.id).source, regenerated);
    check(kind + "：WS 重生成保留坏行与旧候选，合法回执重放及冲突校验不变");

    if (!twoStage) continue;
    const e = f.sessions.snapshot(chat.id)!.rewrite!;
    assert.equal(e.enabled, true);
    const rewrite = { chatId: chat.id, messageId: e.messageId!, candidate: e.candidate!, revision: e.revision, requestId: randomUUID(), instruction: "更简洁" };
    const state = stateFields(f.chats.readMetadata(chat.id));
    const post = (body: typeof rewrite) => fetch(base + "/api/chat/rewrite", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    f.plan("damaged chat rewrite", [{ text: "重写文字候选" }]);
    const response = await post(rewrite);
    assert.equal(response.status, 200, await response.text());
    assert.equal(f.count(), 1);
    assert.deepEqual(stateFields(f.chats.readMetadata(chat.id)), state);
    assert.equal(f.chats.readChat(chat.id)!.at(-1)!.mes, "重写文字候选");
    assert.equal(f.sessions.snapshot(chat.id)!.replyChoices!.count, 3);
    preserved(chat.id);
    const rewritten = f.chats.readSource(chat.id).source, n = f.requests.length;
    const replay = await post(rewrite);
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).replayed, true);
    const conflict = await post({ ...rewrite, instruction: "不同方向复用 ID" });
    assert.equal(conflict.status, 400);
    assert.match(await conflict.text(), /请求 ID/);
    assert.equal(f.requests.length, n);
    assert.equal(f.chats.readSource(chat.id).source, rewritten);
    check("HTTP 正文重写保留坏行、旧正文及世界状态，重放无请求，冲突仍拒绝");
  }
  assert.deepEqual(f.problems, []);
} finally {
  ws.terminate();
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await f.close();
}
console.log(`${checks} 组坏行请求去重检查通过：${f.run}`);
