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

test("备份恢复保留世界快照和模板", () => {
  const { store, chat } = setup();
  store.initializeWorld(chat.id, template);
  store.editMessage(chat.id, "line-0", "欢迎来到酒馆。", "欢迎来到酒馆。");
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
