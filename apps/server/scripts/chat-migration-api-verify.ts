/** M4: 全聊天迁移预览/应用 API、冲突、no-op、元数据变化与阻断。 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { WorldChatMigrationPreviewDto, WorldChatMigrationResultDto } from "@pitavern/shared/world";
import type { TavernConfig } from "../src/config.ts";

const repo = path.resolve(import.meta.dirname, "../../..");
fs.mkdirSync(path.join(repo, "data/test-runs"), { recursive: true });
const runDir = fs.mkdtempSync(path.join(repo, "data/test-runs/chat-migration-api-"));
const dataDir = path.join(runDir, "st");
process.env.PITAVERN_CONFIG = path.join(runDir, "config.json");
const { defaultConfig, seedDataDirs } = await import("../src/config.ts");
const { WorldTemplateLibrary } = await import("../src/world/template-library.ts");
const { createInitialWorldSnapshot, createWorldTemplateRecord } = await import("../src/world/index.ts");
const { CharacterStore } = await import("../src/stdata/characters.ts");
const { ChatStore } = await import("../src/stdata/chats.ts");
const { buildModels } = await import("../src/providers/models.ts");
const { SessionManager } = await import("../src/session/manager.ts");
const { createHttpApp } = await import("../src/api/http.ts");
const { WORLD_STATE_KEY, WORLD_TEMPLATES_KEY } = await import("@pitavern/shared/world");

const config = defaultConfig() as TavernConfig;
config.stDataDir = dataDir; seedDataDirs(dataDir);
const library = new WorldTemplateLibrary(dataDir);
const blank = library.createBlank("迁移目标", "旧描述");
const targetTemplate = {
  schemaVersion: 1, templateId: blank.id, templateVersion: 2, rulesVersion: 1,
  locations: [{ id: "tavern", name: "酒馆" }, { id: "square", name: "集市" }],
  actors: [{ id: "player", name: "旅人" }, { id: "merchant", name: "掌柜" }],
  items: [{ id: "sword", name: "长剑", price: 40 }],
  initial: { actorId: "player", locationId: "tavern", money: 100, inventory: [{ ownerId: "merchant", itemId: "sword", quantity: 2 }] },
};
const saved = library.saveDraft(blank.id, blank.draftRevision, { name: "迁移目标", description: "旧描述", template: targetTemplate });
const published = library.publish(blank.id, saved.draftRevision);
const targetHash = published.publishedHash;
assert.ok(targetHash);
const sourceTemplate = { ...structuredClone(targetTemplate), templateVersion: 1, items: [{ id: "sword", name: "长剑", price: 30 }] };
const sourceRecord = createWorldTemplateRecord(sourceTemplate, { name: "迁移目标", description: "旧描述" });
const targetRecord = library.resolveHash(targetHash);
assert.ok(targetRecord);
const snapshot = createInitialWorldSnapshot(sourceRecord);
const chatId = "chats/掌柜/2026-11-01@00h00m00s.jsonl";
const chatFile = path.join(dataDir, chatId);
fs.mkdirSync(path.dirname(chatFile), { recursive: true });
const source = [
  JSON.stringify({ user_name: "旅人", character_name: "掌柜", chat_metadata: {
    [WORLD_STATE_KEY]: snapshot, [WORLD_TEMPLATES_KEY]: { [sourceRecord.contentHash]: sourceRecord },
  } }),
  JSON.stringify({ name: "旅人", is_user: true, is_system: false, mes: "买剑", send_date: "", extra: {
    _pitavernBeforeTurn: { metadata: { [WORLD_STATE_KEY]: snapshot } },
  } }),
].join("\n") + "\n";
fs.writeFileSync(chatFile, source);
const characters = new CharacterStore(path.join(dataDir, "characters"));
const chats = new ChatStore(dataDir);
const modelsRef = { current: buildModels(config) };
const sessions = new SessionManager(config, () => modelsRef.current, characters, chats, dataDir);
const server = http.createServer(createHttpApp({ config, modelsRef, characters, chats, sessions, stDataDir: dataDir, webDistDir: null }));
server.listen(0, "127.0.0.1"); await once(server, "listening");
const base = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
let checks = 0;
function check(label: string): void { checks += 1; console.log("✓ " + label); }
const post = async (route: string, body: unknown) => {
  const response = await fetch(base + route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
};
try {
  const before = fs.readFileSync(chatFile, "utf8");
  const preview = await post("/api/chat/world/migrate/preview", { chatId, targetHash });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.applyable, true);
  assert.equal(preview.body.target.description, "旧描述");
  assert.equal(fs.readFileSync(chatFile, "utf8"), before, "预览不写聊天");
  assert.ok(preview.body.locations.some((location: any) => location.kind === "checkpoint"));
  const applied = await post("/api/chat/world/migrate/apply", { chatId, targetHash,
    expectedRevision: preview.body.revision, previewHash: preview.body.previewHash });
  assert.equal(applied.status, 200);
  const result = applied.body as WorldChatMigrationResultDto;
  assert.ok(result.backupId);
  assert.ok(fs.readFileSync(chatFile, "utf8").includes(targetHash));
  const backupsAfter = chats.backups(chatId).backups.length;
  const repeated = await post("/api/chat/world/migrate/apply", { chatId, targetHash,
    expectedRevision: preview.body.revision, previewHash: preview.body.previewHash });
  assert.equal(repeated.status, 409);
  assert.equal(chats.backups(chatId).backups.length, backupsAfter, "重复提交不重复备份");
  const noopPreview = await post("/api/chat/world/migrate/preview", { chatId, targetHash });
  assert.equal(noopPreview.status, 200);
  assert.equal(noopPreview.body.noop, true);
  assert.equal(noopPreview.body.applyable, false);
  const noopApply = await post("/api/chat/world/migrate/apply", { chatId, targetHash,
    expectedRevision: noopPreview.body.revision, previewHash: noopPreview.body.previewHash });
  assert.equal(noopApply.status, 200);
  assert.equal(noopApply.body.noop, true);
  assert.equal(chats.backups(chatId).backups.length, backupsAfter);
  check("预览→应用→no-op 重复提交；预览不写聊天且不重复备份");

  chats.restoreBackup(chatId, result.backupId!, chats.revisionId(chatId));
  assert.equal(fs.readFileSync(chatFile, "utf8"), before);
  const stalePreview = await post("/api/chat/world/migrate/preview", { chatId, targetHash });
  assert.equal(stalePreview.status, 200);
  fs.appendFileSync(chatFile, "\n");
  const staleApply = await post("/api/chat/world/migrate/apply", { chatId, targetHash,
    expectedRevision: stalePreview.body.revision, previewHash: stalePreview.body.previewHash });
  assert.equal(staleApply.status, 409);
  assert.equal(fs.readFileSync(chatFile, "utf8"), before + "\n");
  fs.writeFileSync(chatFile, before);
  check("恢复备份；预览后聊天变化返回 409 且不写");

  // 同 hash 修改目标描述：旧 previewHash 必须失效，重新预览后可应用。
  const oldPreview = await post("/api/chat/world/migrate/preview", { chatId, targetHash });
  assert.equal(oldPreview.status, 200);
  const targetSaved = library.saveDraft(blank.id, published.draftRevision, { name: "迁移目标", description: "新描述", template: published.draft });
  const targetUpdated = library.publish(blank.id, targetSaved.draftRevision);
  assert.equal(targetUpdated.publishedHash, targetHash);
  const expired = await post("/api/chat/world/migrate/apply", { chatId, targetHash,
    expectedRevision: oldPreview.body.revision, previewHash: oldPreview.body.previewHash });
  assert.equal(expired.status, 409);
  const fresh = await post("/api/chat/world/migrate/preview", { chatId, targetHash });
  assert.equal(fresh.status, 200);
  assert.equal(fresh.body.target.description, "新描述");
  assert.notEqual(fresh.body.previewHash, oldPreview.body.previewHash);
  const appliedFresh = await post("/api/chat/world/migrate/apply", { chatId, targetHash,
    expectedRevision: fresh.body.revision, previewHash: fresh.body.previewHash });
  assert.equal(appliedFresh.status, 200);
  check("同 hash 目标描述变化使旧 previewHash 失效，重新预览可应用");

  const missingTarget = await post("/api/chat/world/migrate/preview", { chatId, targetHash: "0".repeat(64) });
  assert.equal(missingTarget.status, 404);
  const noWorldFile = path.join(dataDir, "chats/掌柜/2026-11-01@00h00m01s.jsonl");
  fs.writeFileSync(noWorldFile, JSON.stringify({ user_name: "旅人", character_name: "掌柜", chat_metadata: {} }) + "\n");
  const noWorld = await post("/api/chat/world/migrate/preview", { chatId: "chats/掌柜/2026-11-01@00h00m01s.jsonl", targetHash });
  assert.equal(noWorld.status, 422);
  check("目标不存在 404；无世界聊天 422");

  // 坏快照：422 返回 preview，不写文件。
  const badFile = path.join(dataDir, "chats/掌柜/2026-11-01@00h00m02s.jsonl");
  const badSnapshot = { ...snapshot, rulesVersion: 999 };
  fs.writeFileSync(badFile, [
    JSON.stringify({ user_name: "旅人", character_name: "掌柜", chat_metadata: {
      [WORLD_STATE_KEY]: badSnapshot, [WORLD_TEMPLATES_KEY]: { [sourceRecord.contentHash]: sourceRecord },
    } }),
  ].join("\n") + "\n");
  const badBefore = fs.readFileSync(badFile, "utf8");
  const badPreview = await post("/api/chat/world/migrate/preview", { chatId: "chats/掌柜/2026-11-01@00h00m02s.jsonl", targetHash });
  assert.equal(badPreview.status, 422);
  assert.ok(badPreview.body.preview);
  assert.ok(badPreview.body.preview.blocking.length > 0);
  assert.equal(fs.readFileSync(badFile, "utf8"), badBefore);
  check("坏快照预览 422 返回阻断位置且不写文件");

  const wrongPreview = await post("/api/chat/world/migrate/apply", { chatId, targetHash,
    expectedRevision: chats.revisionId(chatId), previewHash: "0".repeat(64) });
  assert.equal(wrongPreview.status, 409);
  check("previewHash 不匹配 409");

  console.log("\n" + checks + " 项检查全部通过。测试数据保留：" + runDir);
} finally {
  server.closeAllConnections(); server.close();
}