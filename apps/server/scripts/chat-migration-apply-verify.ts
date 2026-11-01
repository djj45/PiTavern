/** M3: 备份、一次原子替换、恢复与失败不改聊天。 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { WorldTemplate } from "@pitavern/shared/world";
import { WORLD_STATE_KEY, WORLD_TEMPLATES_KEY } from "@pitavern/shared/world";
import { createInitialWorldSnapshot, createWorldTemplateRecord } from "../src/world/index.ts";
import { planChatWorldMigration } from "../src/world/chat-migration.ts";
import { ChatStore } from "../src/stdata/chats.ts";

const repo = path.resolve(import.meta.dirname, "../../..");
fs.mkdirSync(path.join(repo, "data/test-runs"), { recursive: true });
const runDir = fs.mkdtempSync(path.join(repo, "data/test-runs/chat-migration-apply-"));
const chatRelative = "chats/掌柜/2026-11-01@00h00m00s.jsonl";
const chatFile = path.join(runDir, chatRelative);
fs.mkdirSync(path.dirname(chatFile), { recursive: true });
const template: WorldTemplate = {
  schemaVersion: 1, templateId: "tavern-sword", templateVersion: 1, rulesVersion: 1,
  locations: [{ id: "tavern", name: "酒馆" }, { id: "square", name: "集市" }],
  actors: [{ id: "player", name: "旅人" }, { id: "merchant", name: "掌柜" }],
  items: [{ id: "sword", name: "长剑", price: 30 }],
  initial: { actorId: "player", locationId: "tavern", money: 100, inventory: [{ ownerId: "merchant", itemId: "sword", quantity: 2 }] },
};
const sourceRecord = createWorldTemplateRecord(template, { name: "酒馆买剑", description: "旧描述" });
const targetTemplate: WorldTemplate = { ...structuredClone(template), templateVersion: 2, items: [{ id: "sword", name: "长剑", price: 40 }] };
const targetRecord = createWorldTemplateRecord(targetTemplate, { name: "酒馆买剑", description: "新描述" });
const snapshot = createInitialWorldSnapshot(sourceRecord);
const user = {
  name: "旅人", is_user: true, is_system: false, mes: "买一把剑。", send_date: "2026-11-01T00:00:00.000Z",
  extra: { _pitavernBeforeTurn: { metadata: { _pitavernWorld: snapshot } } },
};
const source = [
  JSON.stringify({ user_name: "旅人", character_name: "掌柜", chat_metadata: {
    [WORLD_STATE_KEY]: snapshot, [WORLD_TEMPLATES_KEY]: { [sourceRecord.contentHash]: sourceRecord },
  } }),
  JSON.stringify(user),
].join("\n") + "\n";
fs.writeFileSync(chatFile, source);
const chats = new ChatStore(runDir);
let checks = 0;
function check(label: string): void { checks += 1; console.log("✓ " + label); }
const originalHash = createHash("sha256").update(source).digest("hex");
const read = chats.readSource(chatRelative);
assert.equal(read.revision, chats.revisionId(chatRelative));
const plan = planChatWorldMigration(read.source, targetRecord);
assert.equal(plan.applyable, true);
assert.ok(plan.nextSource);
const applied = chats.applyWorldMigration(chatRelative, read.revision, plan.sourceHash, plan.nextSource!);
assert.ok(applied.backupId.endsWith(".jsonl"));
assert.notEqual(applied.revision, read.revision);
const afterApply = fs.readFileSync(chatFile, "utf8");
assert.ok(afterApply.includes(targetRecord.contentHash));
assert.ok(afterApply.includes(sourceRecord.contentHash), "旧模板记录保留");
const backups = chats.backups(chatRelative).backups;
assert.ok(backups.some((backup) => backup.id === applied.backupId));
check("迁移前备份、一次替换、返回明确 backupId，旧模板记录保留");

const current = chats.revisionId(chatRelative);
chats.restoreBackup(chatRelative, applied.backupId, current);
assert.equal(fs.readFileSync(chatFile, "utf8"), source);
check("使用返回的 backupId 恢复后原聊天字节一致");

const staleSource = fs.readFileSync(chatFile, "utf8");
const stalePlan = planChatWorldMigration(staleSource, targetRecord);
const staleRevision = chats.revisionId(chatRelative);
fs.appendFileSync(chatFile, "\n");
assert.throws(() => chats.applyWorldMigration(chatRelative, staleRevision, stalePlan.sourceHash, stalePlan.nextSource!), /已变化/);
assert.equal(fs.readFileSync(chatFile, "utf8"), staleSource + "\n", "stale revision 不写聊天");
fs.writeFileSync(chatFile, staleSource);
check("外部变化/旧 revision 拒绝且不改聊天");

const hashPlan = planChatWorldMigration(staleSource, targetRecord);
const hashRevision = chats.revisionId(chatRelative);
assert.throws(() => chats.applyWorldMigration(chatRelative, hashRevision, "0".repeat(64), hashPlan.nextSource!), /内容已变化/);
assert.equal(fs.readFileSync(chatFile, "utf8"), staleSource);
check("源内容哈希不符拒绝且不改聊天");

// 备份目录被文件占用：备份失败时不能替换聊天。
const backupRoot = path.join(runDir, ".pitavern", "backups");
fs.mkdirSync(path.dirname(backupRoot), { recursive: true });
if (fs.existsSync(backupRoot)) fs.rmSync(backupRoot, { recursive: true, force: true });
fs.writeFileSync(backupRoot, "blocked");
const beforeFailure = fs.readFileSync(chatFile, "utf8");
const failureRevision = chats.revisionId(chatRelative);
assert.throws(() => chats.applyWorldMigration(chatRelative, failureRevision, hashPlan.sourceHash, hashPlan.nextSource!), /EEXIST|文件已存在|not a directory|ENOTDIR|EEXIST/);
assert.equal(fs.readFileSync(chatFile, "utf8"), beforeFailure, "备份失败不改聊天");
fs.rmSync(backupRoot, { force: true });
check("备份写失败时不替换聊天");

// 临时文件写失败：备份成功但最终替换失败，聊天保持原样。
const blockedAfterBackup = async () => {
  const backupDir = path.join(runDir, ".pitavern", "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const actualPlan = planChatWorldMigration(beforeFailure, targetRecord);
  const revision = chats.revisionId(chatRelative);
  const tempDir = path.dirname(chatFile);
  const mode = fs.statSync(tempDir).mode;
  try {
    fs.chmodSync(tempDir, 0o555);
    assert.throws(() => chats.applyWorldMigration(chatRelative, revision, actualPlan.sourceHash, actualPlan.nextSource!), /EACCES|permission|只读/);
    assert.equal(fs.readFileSync(chatFile, "utf8"), beforeFailure);
  } finally {
    fs.chmodSync(tempDir, mode);
  }
};
await blockedAfterBackup();
check("临时文件写失败时聊天不变");

console.log("\n" + checks + " 项检查全部通过。测试数据保留：" + runDir);
