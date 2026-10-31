import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { WORLD_STATE_KEY, type WorldTemplate } from "@pitavern/shared/world";
import { ChatStore } from "../src/stdata/chats.ts";
import { stateFields } from "../src/stdata/replies.ts";
import { WorldTransaction } from "../src/world/index.ts";

const ROOT = path.resolve(import.meta.dirname, "../../..");

function setup() {
  fs.mkdirSync(path.join(ROOT, "data/test-runs"), { recursive: true });
  const root = fs.mkdtempSync(path.join(ROOT, "data/test-runs/world-lifecycle-"));
  const st = path.join(root, "st");
  const store = new ChatStore(st);
  const chat = store.createChat("世界向导", { name: "世界向导", is_user: false, is_system: false, mes: "欢迎来到酒馆。" });
  return { root, st, store, chat };
}

const template: WorldTemplate = {
  schemaVersion: 1, templateId: "tavern-v1", templateVersion: 1, rulesVersion: 1,
  locations: [{ id: "tavern", name: "酒馆" }],
  actors: [{ id: "player", name: "旅人" }, { id: "merchant", name: "掌柜" }],
  items: [{ id: "sword", name: "长剑", price: 10 }],
  initial: { actorId: "player", locationId: "tavern", money: 20, inventory: [{ ownerId: "merchant", itemId: "sword", quantity: 1 }] },
};

const purchase = {
  commandId: "buy-1", type: "purchase_item" as const,
  buyerId: "player", sellerId: "merchant", itemId: "sword", quantity: 1,
};

test("世界初始化写入快照和模板，重启后可读", () => {
  const { root, st, store, chat } = setup();
  const state = store.initializeWorld(chat.id, template);
  assert.equal(state.snapshot.revision, 0);
  assert.equal(state.snapshot.money.player, 20);
  assert.ok(state.snapshot.templateHash);
  const metadata = store.readMetadata(chat.id);
  assert.ok(metadata[WORLD_STATE_KEY]);
  assert.ok(stateFields(metadata)[WORLD_STATE_KEY]);
  const restarted = new ChatStore(st).readWorld(chat.id);
  assert.equal(restarted?.snapshot.money.player, 20);
  assert.ok(fs.existsSync(root));
});

test("已有用户发言后拒绝中途初始化世界", () => {
  const { store, chat } = setup();
  store.appendMessage(chat.id, { name: "User", is_user: true, is_system: false, mes: "先说话" });
  assert.throws(() => store.initializeWorld(chat.id, template), /新聊天/);
});

test("回合提交、候选切换和重启恢复各自世界", () => {
  const { st, store, chat } = setup();
  store.initializeWorld(chat.id, template);
  const worldA = store.readWorld(chat.id)!.snapshot;
  const before = stateFields(store.readMetadata(chat.id));
  const user = store.appendMessage(chat.id, {
    name: "User", is_user: true, is_system: false, mes: "买一把剑",
    extra: { _pitavernBeforeTurn: { metadata: before, enforcement: { turn: 1, usedThisTurn: 0, cooldownUntilTurn: 0 } } },
  });
  const current = store.appendMessage(chat.id, { name: "世界向导", is_user: false, is_system: false, mes: "第一版回答" });
  const regeneration = store.prepareRegeneration(chat.id, current.extra!.messageId as string, current.mes);
  const transaction = new WorldTransaction(store.readWorld(chat.id)!, 1);
  const result = transaction.execute(purchase);
  assert.equal(result.status, "staged");
  const worldB = transaction.commit();
  const nextMetadata = { ...regeneration.metadata, [WORLD_STATE_KEY]: worldB };
  regeneration.commit([{ name: "世界向导", is_user: false, is_system: false, mes: "第二版回答", send_date: new Date().toISOString(), extra: { messageId: "assistant-b" } }], nextMetadata);
  assert.equal(store.readWorld(chat.id)!.snapshot.money.player, 10);
  assert.equal(store.readWorld(chat.id)!.snapshot.inventory.find((entry) => entry.ownerId === "player")?.quantity, 1);

  const revision = store.revisionId(chat.id);
  store.selectReply(chat.id, user.extra!.messageId as string, 0, revision);
  assert.equal(store.readWorld(chat.id)!.snapshot.money.player, 20);
  assert.equal(store.readWorld(chat.id)!.snapshot.revision, worldA.revision);
  store.selectReply(chat.id, user.extra!.messageId as string, 1, store.revisionId(chat.id));
  assert.equal(store.readWorld(chat.id)!.snapshot.money.player, 10);

  const restarted = new ChatStore(st);
  assert.equal(restarted.readWorld(chat.id)!.snapshot.money.player, 10);
});

test("丢弃事务不改变聊天世界", () => {
  const { store, chat } = setup();
  store.initializeWorld(chat.id, template);
  const before = store.readWorld(chat.id)!.snapshot;
  const transaction = store.beginWorldTransaction(chat.id, 1)!;
  assert.equal(transaction.execute(purchase).status, "staged");
  transaction.discard();
  assert.deepEqual(store.readWorld(chat.id)!.snapshot, before);
});

test("备份恢复保留世界快照和模板", async () => {
  const { store, chat } = setup();
  store.initializeWorld(chat.id, template);
  await new Promise((resolve) => setTimeout(resolve, 5));
  store.editMessage(chat.id, "line-0", "欢迎来到酒馆。", "欢迎来到酒馆。");
  await new Promise((resolve) => setTimeout(resolve, 5));
  store.editMessage(chat.id, "line-0", "欢迎来到酒馆。 ", "欢迎来到酒馆。");
  const backup = store.backups(chat.id).backups[0];
  assert.ok(backup);
  store.restoreBackup(chat.id, backup.id, store.revisionId(chat.id));
  assert.equal(store.readWorld(chat.id)!.snapshot.money.player, 20);
  assert.ok(store.readMetadata(chat.id)._pitavernWorldTemplates);
});

test("文本编辑保留世界和分支恢复点", () => {
  const { store, chat } = setup();
  store.initializeWorld(chat.id, template);
  const before = stateFields(store.readMetadata(chat.id));
  const user = store.appendMessage(chat.id, {
    name: "User", is_user: true, is_system: false, mes: "原始文本",
    extra: { _pitavernBeforeTurn: { metadata: before, enforcement: { turn: 1, usedThisTurn: 0, cooldownUntilTurn: 0 } } },
  });
  const current = store.appendMessage(chat.id, { name: "世界向导", is_user: false, is_system: false, mes: "原始回答" });
  const regeneration = store.prepareRegeneration(chat.id, current.extra!.messageId as string, current.mes);
  const transaction = new WorldTransaction(store.readWorld(chat.id)!, 1);
  transaction.execute(purchase);
  const worldB = transaction.commit();
  regeneration.commit([{ name: "世界向导", is_user: false, is_system: false, mes: "新回答", send_date: new Date().toISOString(), extra: { messageId: "assistant-edit" } }],
    { ...regeneration.metadata, [WORLD_STATE_KEY]: worldB });
  store.editMessage(chat.id, user.extra!.messageId as string, "改过的文本", "原始文本");
  assert.equal(store.readWorld(chat.id)!.snapshot.money.player, 10);
  store.selectReply(chat.id, user.extra!.messageId as string, 0, store.revisionId(chat.id));
  assert.equal(store.readWorld(chat.id)!.snapshot.money.player, 20);
});

test("旧聊天中途初始化世界并回填检查点与候选状态", () => {
  const { store, chat } = setup();
  const before = stateFields(store.readMetadata(chat.id));
  const user = store.appendMessage(chat.id, {
    name: "User", is_user: true, is_system: false, mes: "旧剧情",
    extra: { _pitavernBeforeTurn: { metadata: before, enforcement: { turn: 1, usedThisTurn: 0, cooldownUntilTurn: 0 } } },
  });
  const current = store.appendMessage(chat.id, { name: "世界向导", is_user: false, is_system: false, mes: "旧回答 A" });
  const regeneration = store.prepareRegeneration(chat.id, current.extra!.messageId as string, current.mes);
  regeneration.commit([{ name: "世界向导", is_user: false, is_system: false, mes: "旧回答 B", send_date: new Date().toISOString(), extra: { messageId: "assistant-old-b" } }], regeneration.metadata);
  assert.equal(store.readWorld(chat.id), null);
  store.initializeWorld(chat.id, template, undefined, { allowExisting: true });
  assert.equal(store.readWorld(chat.id)!.snapshot.money.player, 20);
  const userLine = store.readDocument(chat.id)!.lines.find((line) => line.is_user)!;
  assert.ok((userLine.extra!._pitavernBeforeTurn as { metadata: Record<string, unknown> }).metadata[WORLD_STATE_KEY]);
  const catalog = userLine.extra!._pitavernReplies as { versions: Array<{ state?: Record<string, unknown> }> };
  assert.equal(catalog.versions.length, 2);
  for (const version of catalog.versions) assert.ok(version.state?.[WORLD_STATE_KEY]);
  store.selectReply(chat.id, user.extra!.messageId as string, 0, store.revisionId(chat.id));
  assert.equal(store.readWorld(chat.id)!.snapshot.money.player, 20);
});

test("手工修正世界校验模板并同步活动候选", () => {
  const { store, chat } = setup();
  store.initializeWorld(chat.id, template);
  const before = stateFields(store.readMetadata(chat.id));
  const user = store.appendMessage(chat.id, {
    name: "User", is_user: true, is_system: false, mes: "旧剧情",
    extra: { _pitavernBeforeTurn: { metadata: before, enforcement: { turn: 1, usedThisTurn: 0, cooldownUntilTurn: 0 } } },
  });
  const current = store.appendMessage(chat.id, { name: "世界向导", is_user: false, is_system: false, mes: "旧回答 A" });
  const regeneration = store.prepareRegeneration(chat.id, current.extra!.messageId as string, current.mes);
  const transaction = new WorldTransaction(store.readWorld(chat.id)!, 1);
  transaction.execute(purchase);
  const worldB = transaction.commit();
  regeneration.commit([{ name: "世界向导", is_user: false, is_system: false, mes: "旧回答 B", send_date: new Date().toISOString(), extra: { messageId: "assistant-correct-b" } }],
    { ...regeneration.metadata, [WORLD_STATE_KEY]: worldB });
  const snapshot = store.readWorld(chat.id)!.snapshot;
  const corrected = { ...snapshot, clockMinutes: 120, money: { ...snapshot.money, player: 77 } };
  store.correctWorld(chat.id, corrected, store.revisionId(chat.id));
  assert.equal(store.readWorld(chat.id)!.snapshot.clockMinutes, 120);
  assert.equal(store.readWorld(chat.id)!.snapshot.money.player, 77);
  assert.equal(store.readWorld(chat.id)!.snapshot.revision, snapshot.revision + 1);
  const userLine = store.readDocument(chat.id)!.lines.find((line) => line.is_user)!;
  const catalog = userLine.extra!._pitavernReplies as { selected: number; versions: Array<{ state?: Record<string, unknown> }> };
  assert.equal((catalog.versions[catalog.selected].state?.[WORLD_STATE_KEY] as { clockMinutes?: number }).clockMinutes, 120);
  const revision = store.revisionId(chat.id);
  assert.throws(() => store.correctWorld(chat.id, { ...corrected, templateHash: "0".repeat(64) }, revision), /模板/);
  assert.equal(store.readWorld(chat.id)!.snapshot.clockMinutes, 120);
  assert.equal(store.readWorld(chat.id)!.snapshot.revision, snapshot.revision + 1);
});

test("重启、备份和单文件 JSONL 都保留旧聊天世界与模板", () => {
  const { st, store, chat } = setup();
  store.initializeWorld(chat.id, template);
  const before = stateFields(store.readMetadata(chat.id));
  store.appendMessage(chat.id, {
    name: "User", is_user: true, is_system: false, mes: "旧剧情",
    extra: { _pitavernBeforeTurn: { metadata: before, enforcement: { turn: 1, usedThisTurn: 0, cooldownUntilTurn: 0 } } },
  });
  store.appendMessage(chat.id, { name: "世界向导", is_user: false, is_system: false, mes: "旧回答" });
  const snapshot = store.readWorld(chat.id)!.snapshot;
  store.correctWorld(chat.id, { ...snapshot, money: { ...snapshot.money, player: 77 } }, store.revisionId(chat.id));

  const restarted = new ChatStore(st);
  const restartedState = restarted.readWorld(chat.id)!;
  assert.equal(restartedState.snapshot.money.player, 77);
  assert.ok(restartedState.template);

  const copyRoot = fs.mkdtempSync(path.join(ROOT, "data/test-runs/world-copy-"));
  const copySt = path.join(copyRoot, "st");
  fs.mkdirSync(path.join(copySt, "chats", "copied"), { recursive: true });
  fs.copyFileSync(chat.file, path.join(copySt, "chats", "copied", "export.jsonl"));
  const copied = new ChatStore(copySt).readWorld("chats/copied/export.jsonl")!;
  assert.equal(copied.snapshot.money.player, 77);
  assert.ok(copied.template);
  const transaction = new WorldTransaction(copied, 1);
  const result = transaction.execute(purchase);
  assert.equal(result.status, "staged");
  assert.equal(transaction.snapshot.money.player, 67);

  const backup = store.backups(chat.id).backups[0];
  assert.ok(backup);
  store.restoreBackup(chat.id, backup.id, store.revisionId(chat.id));
  const restored = store.readWorld(chat.id)!;
  assert.ok(restored.template);
  assert.equal(restored.snapshot.templateHash, snapshot.templateHash);
  assert.equal(restored.snapshot.revision, snapshot.revision);
});
