/** M6: 整聊天迁移后的实际购买、候选切换、重生成检查点、重启与恢复。 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { WorldTemplate } from "@pitavern/shared/world";
import { WORLD_STATE_KEY, WORLD_TEMPLATES_KEY } from "@pitavern/shared/world";
import { WorldTransaction, createInitialWorldSnapshot, createWorldTemplateRecord } from "../src/world/index.ts";
import { planChatWorldMigration } from "../src/world/chat-migration.ts";
import { WorldTemplateLibrary } from "../src/world/template-library.ts";
import { ChatStore } from "../src/stdata/chats.ts";

const repo = path.resolve(import.meta.dirname, "../../..");
fs.mkdirSync(path.join(repo, "data/test-runs"), { recursive: true });
const runDir = fs.mkdtempSync(path.join(repo, "data/test-runs/chat-migration-game-"));
const dataDir = path.join(runDir, "st");
const library = new WorldTemplateLibrary(dataDir);
const blank = library.createBlank("酒馆买剑", "v1");
const baseTemplate: WorldTemplate = {
  schemaVersion: 1, templateId: blank.id, templateVersion: 1, rulesVersion: 1,
  locations: [{ id: "tavern", name: "酒馆" }, { id: "square", name: "集市" }],
  actors: [{ id: "player", name: "旅人" }, { id: "merchant", name: "掌柜" }, { id: "bard", name: "吟游诗人" }],
  items: [{ id: "sword", name: "长剑", price: 17 }],
  initial: { actorId: "player", locationId: "tavern", money: 100, inventory: [{ ownerId: "merchant", itemId: "sword", quantity: 2 }] },
};
const saved = library.saveDraft(blank.id, blank.draftRevision, { name: "酒馆买剑", description: "v1", template: baseTemplate });
const published = library.publish(blank.id, saved.draftRevision);
const sourceRecord = library.resolveHash(published.publishedHash!);
const sourceSnapshot = createInitialWorldSnapshot(sourceRecord);
const targetTemplate = { ...structuredClone(baseTemplate), items: [{ id: "sword", name: "长剑", price: 23 }] };
const saved2 = library.saveDraft(blank.id, published.draftRevision, { name: "酒馆买剑·新价", description: "v2", template: targetTemplate });
const published2 = library.publish(blank.id, saved2.draftRevision);
const targetRecord = library.resolveHash(published2.publishedHash!);
const before = structuredClone(sourceSnapshot);
const assistant = { name: "掌柜", is_user: false, is_system: false, mes: "掌柜抬眼。", send_date: "2026-11-01T00:00:01.000Z", extra: { messageId: "assistant-1" } };
const userLine = {
  name: "旅人", is_user: true, is_system: false, mes: "买剑。", send_date: "2026-11-01T00:00:02.000Z",
  extra: {
    messageId: "user-1",
    _pitavernBeforeTurn: { metadata: { [WORLD_STATE_KEY]: before } },
    _pitavernReplies: { selected: 0, versions: [
      { messages: [assistant], state: { [WORLD_STATE_KEY]: before } },
      { messages: [{ ...assistant, mes: "另一版。" }], state: { [WORLD_STATE_KEY]: before } },
    ] },
  },
};
const source = [
  JSON.stringify({ user_name: "旅人", character_name: "掌柜", chat_metadata: {
    [WORLD_STATE_KEY]: before, [WORLD_TEMPLATES_KEY]: { [sourceRecord.contentHash]: sourceRecord },
  } }),
  JSON.stringify(userLine),
  JSON.stringify(assistant),
].join("\n") + "\n";
const chatId = "chats/掌柜/2026-11-01@00h00m00s.jsonl";
const chatFile = path.join(dataDir, chatId);
fs.mkdirSync(path.dirname(chatFile), { recursive: true });
fs.writeFileSync(chatFile, source);
const chats = new ChatStore(dataDir);
let checks = 0;
function check(label: string): void { checks += 1; console.log("✓ " + label); }
function worlds(value: unknown, out: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> {
  if (!value || typeof value !== "object") return out;
  if (Array.isArray(value)) { for (const item of value) worlds(item, out); return out; }
  const record = value as Record<string, unknown>;
  if (record[WORLD_STATE_KEY] && typeof record[WORLD_STATE_KEY] === "object") out.push(record[WORLD_STATE_KEY] as Record<string, unknown>);
  for (const [key, item] of Object.entries(record)) if (key !== WORLD_STATE_KEY) worlds(item, out);
  return out;
}
const read = chats.readSource(chatId);
const plan = planChatWorldMigration(read.source, targetRecord);
assert.equal(plan.applyable, true);
const applied = chats.applyWorldMigration(chatId, read.revision, plan.sourceHash, plan.nextSource!);
const afterSource = fs.readFileSync(chatFile, "utf8");
const allWorlds = worlds(JSON.parse(afterSource.split("\n")[0]).chat_metadata);
for (const line of afterSource.split("\n").slice(1).filter(Boolean)) worlds(JSON.parse(line), allWorlds);
assert.ok(allWorlds.length >= 3);
assert.ok(allWorlds.every((world) => world.templateHash === targetRecord.contentHash && world.templateVersion === 2));
const afterMessages = afterSource.split("\n").filter(Boolean).slice(1).map((line) => JSON.parse(line));
assert.equal(afterMessages[0].mes, "买剑。");
assert.equal(afterMessages[1].mes, "掌柜抬眼。");
check("所有活动/检查点/候选快照使用目标版本，历史正文不变");

const world = chats.readWorld(chatId);
assert.ok(world);
const tx = new WorldTransaction(world!, 1);
const purchase = tx.execute({ commandId: "buy-at-new-price", type: "purchase_item", buyerId: "player", sellerId: "merchant", itemId: "sword", quantity: 1 });
assert.equal(purchase.status, "staged", JSON.stringify(purchase));
const committed = tx.commit();
assert.equal(committed.money.player, 77);
assert.equal(committed.inventory.find((entry) => entry.ownerId === "player" && entry.itemId === "sword")?.quantity, 1);
assert.equal(committed.recentEvents.at(-1)?.moneyDelta, -23);
check("迁移后实际购买按新价格 23 结算：100 → 77");

const currentRevision = chats.revisionId(chatId);
chats.selectReply(chatId, "user-1", 1, currentRevision);
const selected = chats.readMetadata(chatId);
assert.equal((selected[WORLD_STATE_KEY] as Record<string, unknown>).templateHash, targetRecord.contentHash);
const switchedSource = fs.readFileSync(chatFile, "utf8");
assert.ok(switchedSource.includes("另一版。"));
check("切换旧候选后世界仍使用迁移后的模板");

const regenerated = chats.prepareRegeneration(chatId, "assistant-1", "另一版。", false);
assert.equal((regenerated.metadata[WORLD_STATE_KEY] as Record<string, unknown>).templateHash, targetRecord.contentHash);
check("重生成使用迁移后的回合前检查点");

const restarted = new ChatStore(dataDir);
assert.equal(restarted.readWorld(chatId)!.snapshot.templateHash, targetRecord.contentHash);
check("重启后仍使用新模板");

const backupBeforeRestore = fs.readFileSync(chatFile, "utf8");
chats.restoreBackup(chatId, applied.backupId, chats.revisionId(chatId));
assert.equal(fs.readFileSync(chatFile, "utf8"), source);
assert.equal(chats.readWorld(chatId)!.snapshot.templateHash, sourceRecord.contentHash);
const afterRestore = chats.readSource(chatId);
const planAgain = planChatWorldMigration(afterRestore.source, targetRecord);
assert.equal(planAgain.applyable, true);
const appliedAgain = chats.applyWorldMigration(chatId, afterRestore.revision, planAgain.sourceHash, planAgain.nextSource!);
assert.ok(appliedAgain.backupId);
assert.equal(JSON.parse(fs.readFileSync(chatFile, "utf8").split("\n")[0]).chat_metadata[WORLD_STATE_KEY].templateHash, targetRecord.contentHash);
check("恢复迁移前备份并再次迁移成功");

assert.notEqual(backupBeforeRestore, source);
console.log("\n" + checks + " 项检查全部通过。测试数据保留：" + runDir);
