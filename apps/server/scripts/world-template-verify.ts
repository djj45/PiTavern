/** 0.5.0 世界模板库：草稿/发布/版本/冲突/备份/新聊天版本选择。 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { WORLD_TEMPLATES_KEY, WORLD_STATE_KEY, type WorldTemplate } from "@pitavern/shared/world";

const root = path.resolve(import.meta.dirname, "../../..");
fs.mkdirSync(path.join(root, "data/test-runs"), { recursive: true });
const run = fs.mkdtempSync(path.join(root, "data/test-runs/world-templates-"));
process.env.PITAVERN_CONFIG = path.join(run, "config.json");
const { defaultConfig, seedDataDirs, saveConfig } = await import("../src/config.ts");
const { CharacterStore } = await import("../src/stdata/characters.ts");
const { ChatStore } = await import("../src/stdata/chats.ts");
const { SessionManager } = await import("../src/session/manager.ts");
const { buildModels } = await import("../src/providers/models.ts");
const { createHttpApp } = await import("../src/api/http.ts");
const { WorldTemplateLibrary, WorldTemplateConflictError, WorldTemplateNotFoundError } = await import("../src/world/template-library.ts");
const { LibraryBackupStore } = await import("../src/stdata/library-backup.ts");

let checks = 0;
function check(label: string): void { checks += 1; console.log("✓ " + label); }
function card(rootDir: string, name = "验收角色"): void {
  fs.mkdirSync(path.join(rootDir, "characters"), { recursive: true });
  fs.writeFileSync(path.join(rootDir, "characters", name + ".json"), JSON.stringify({
    spec: "chara_card_v2", data: { name, first_mes: "欢迎" },
  }));
}
function clone<T>(value: T): T { return structuredClone(value); }
function withPrice(template: WorldTemplate, price: number): WorldTemplate {
  const next = clone(template);
  next.items[0].price = price;
  return next;
}

const st = path.join(run, "st");
seedDataDirs(st);
card(st);
const config = defaultConfig();
config.stDataDir = st;
saveConfig(config);
const characters = new CharacterStore(path.join(st, "characters"));
const chats = new ChatStore(st);
const library = new WorldTemplateLibrary(st);
const sessions = new SessionManager(config, () => buildModels(config), characters, chats, st);

// A. 草稿与发布 -----------------------------------------------------------------
const blank = library.createBlank("验收世界", "模板库验收");
assert.equal(blank.draft.templateId, blank.id);
assert.equal(blank.draftRevision, 1);
assert.equal(blank.versions.length, 0);
assert.equal(blank.initialSnapshot!.money.player, 0);
assert.equal(library.list().length, 1);
check("新建模板草稿：稳定 ID、初始快照、列表摘要");

const draft = clone(blank.draft);
draft.locations.push({ id: "square", name: "广场" });
draft.actors.push({ id: "merchant", name: "掌柜" });
draft.items.push({ id: "sword", name: "长剑", price: 30 });
draft.initial = { actorId: "player", locationId: "start", money: 100, inventory: [{ ownerId: "merchant", itemId: "sword", quantity: 2 }] };
const saved = library.saveDraft(blank.id, blank.draftRevision, { name: "验收世界", description: "模板库验收", template: draft });
assert.equal(saved.draftRevision, 2);
assert.equal(saved.draft.items[0].price, 30);
assert.equal(saved.initialSnapshot!.money.player, 100);
assert.equal(saved.draftDirty, true);
check("保存草稿：服务端校验、初始世界预览、revision 递增");

const duplicate = clone(saved.draft);
duplicate.locations.push({ ...duplicate.locations[0] });
assert.throws(() => library.saveDraft(blank.id, saved.draftRevision, { name: "坏模板", template: duplicate }), /重复/);
const badInitial = clone(saved.draft);
badInitial.initial.actorId = "missing";
assert.throws(() => library.saveDraft(blank.id, saved.draftRevision, { name: "坏模板", template: badInitial }), /未声明/);
check("重复 ID / 无效初始引用由服务端拒绝，不覆盖草稿");

assert.throws(() => library.saveDraft(blank.id, 1, { name: "验收世界", template: saved.draft }), WorldTemplateConflictError);
check("过期 draftRevision 保存冲突");

const v1 = library.publish(blank.id, saved.draftRevision);
assert.equal(v1.versions.length, 1);
assert.equal(v1.publishedVersion, 1);
assert.equal(v1.draftDirty, false);
assert.ok(v1.publishedHash);
assert.equal(library.resolvePublished(blank.id).template.items[0].price, 30);
check("发布生成不可变版本记录与版本摘要");

const edited = library.saveDraft(blank.id, v1.draftRevision, { name: "验收世界", description: "第二版", template: withPrice(v1.draft, 40) });
const v2 = library.publish(blank.id, edited.draftRevision);
assert.equal(v2.versions.length, 2);
assert.equal(v2.publishedVersion, 2);
const v1Hash = v1.publishedHash!;
const v2Hash = v2.publishedHash!;
assert.notEqual(v1Hash, v2Hash);
assert.equal(library.resolveHash(v1Hash).template.items[0].price, 30);
assert.equal(library.resolveHash(v2Hash).template.items[0].price, 40);
assert.deepEqual(library.versions(blank.id).map((version) => version.templateVersion), [2, 1]);
check("发布新版本：旧版本文件保留、版本选择哈希可读");

// B. 新聊天版本选择与已有聊天不变 -------------------------------------------------
const chatV1 = chats.createChat("验收角色", null);
sessions.initializeChatWorldByHash(chatV1.id, v1Hash, chats.revisionId(chatV1.id), false);
const worldV1 = chats.readWorld(chatV1.id)!;
assert.equal(worldV1.snapshot.templateVersion, 1);
assert.equal(worldV1.template!.items[0].price, 30);
const chatV1Record = (chats.readMetadata(chatV1.id)[WORLD_TEMPLATES_KEY] as Record<string, any>)[v1Hash];
assert.equal(chatV1Record.name, "验收世界");
assert.equal(sessions.snapshot(chatV1.id)!.world?.templateName, "验收世界");

const chatV2 = chats.createChat("验收角色", null);
sessions.initializeChatWorldByHash(chatV2.id, v2Hash, chats.revisionId(chatV2.id), false);
assert.equal(chats.readWorld(chatV2.id)!.snapshot.templateVersion, 2);
assert.equal(chats.readWorld(chatV2.id)!.template!.items[0].price, 40);
check("新聊天按 contentHash 选择精确模板版本，并保存自定义名称");

const v3 = library.saveDraft(blank.id, v2.draftRevision, { name: "验收世界", template: withPrice(v2.draft, 50) });
library.publish(blank.id, v3.draftRevision);
assert.equal(chats.readWorld(chatV1.id)!.snapshot.templateVersion, 1);
assert.equal(chats.readWorld(chatV1.id)!.template!.items[0].price, 30);
assert.equal(chats.readWorld(chatV2.id)!.snapshot.templateVersion, 2);
check("模板后续发布不改变已有聊天的内嵌版本");

// C. 冲突和删除 ---------------------------------------------------------------
const a = new WorldTemplateLibrary(st), b = new WorldTemplateLibrary(st);
const snapshot = a.get(blank.id);
const first = b.saveDraft(blank.id, snapshot.draftRevision, { name: "验收世界", template: withPrice(snapshot.draft, 60) });
assert.throws(() => a.saveDraft(blank.id, snapshot.draftRevision, { name: "验收世界", template: withPrice(snapshot.draft, 70) }), WorldTemplateConflictError);
assert.equal(b.get(blank.id).draftRevision, first.draftRevision);
check("两个模板库实例同时保存：后提交者冲突，不覆盖");

const copied = library.copyBuiltIn("tavern-sword", "内置副本", "复制验收");
assert.notEqual(copied.id, "tavern-sword");
assert.equal(copied.name, "内置副本");
assert.equal(copied.draft.locations.length, 2);
const exported = library.exportTemplate(copied.id);
const imported = library.importTemplate(exported);
assert.notEqual(imported.id, copied.id);
assert.deepEqual(imported.draft.locations, copied.draft.locations);
check("复制内置模板、导出/导入模板 JSON");

const removedId = blank.id;
library.delete(removedId);
assert.throws(() => library.get(removedId), WorldTemplateNotFoundError);
assert.equal(chats.readWorld(chatV1.id)!.template!.items[0].price, 30);
assert.equal(chats.readWorld(chatV2.id)!.snapshot.templateVersion, 2);
assert.equal(chats.readWorld(chatV2.id)!.template!.items[0].price, 40);
assert.equal(chats.readWorld(chatV2.id)!.snapshot.templateHash, v2Hash);
assert.throws(() => library.resolveHash(v2Hash), WorldTemplateNotFoundError, "已删除模板不应再供新聊天选择");
check("删除模板目录条目不影响已有聊天/分支内嵌版本，且不再供新聊天选择");

// D. 受控 HTTP + 整库备份 -------------------------------------------------------
const httpRoot = path.join(run, "http");
seedDataDirs(httpRoot);
card(httpRoot);
const httpConfig = defaultConfig();
httpConfig.stDataDir = httpRoot;
httpConfig.port = 0;
saveConfig(httpConfig);
const httpCharacters = new CharacterStore(path.join(httpRoot, "characters"));
const httpChats = new ChatStore(httpRoot);
const httpSessions = new SessionManager(httpConfig, () => buildModels(httpConfig), httpCharacters, httpChats, httpRoot);
const app = createHttpApp({ config: httpConfig, modelsRef: { current: buildModels(httpConfig) }, characters: httpCharacters, chats: httpChats, sessions: httpSessions, stDataDir: httpRoot, webDistDir: null });
const server = http.createServer(app);
server.listen(0, "127.0.0.1");
await once(server, "listening");
const base = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
const created = await (await fetch(base + "/api/world/template-library", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "blank", name: "HTTP 世界" }),
})).json() as any;
const httpDraft = clone(created.draft) as WorldTemplate;
httpDraft.locations.push({ id: "square", name: "广场" });
httpDraft.actors.push({ id: "merchant", name: "掌柜" });
httpDraft.items.push({ id: "sword", name: "长剑", price: 20 });
httpDraft.initial = { actorId: "player", locationId: "start", money: 50, inventory: [{ ownerId: "merchant", itemId: "sword", quantity: 1 }] };
const httpSaved = await (await fetch(base + "/api/world/template-library/" + encodeURIComponent(created.id), {
  method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: created.draftRevision, name: "HTTP 世界", template: httpDraft }),
})).json() as any;
const httpPublished = await (await fetch(base + "/api/world/template-library/" + encodeURIComponent(created.id) + "/publish", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: httpSaved.draftRevision }),
})).json() as any;
const httpVersions = await (await fetch(base + "/api/world/template-library/" + encodeURIComponent(created.id) + "/versions")).json() as any;
assert.equal(httpVersions.length, 1);
assert.equal((await (await fetch(base + "/api/world/templates")).json() as any[]).some((item) => item.contentHash === httpPublished.publishedHash && item.source === "library"), true);
const createdChat = await (await fetch(base + "/api/chats", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ character: "验收角色", worldTemplateHash: httpPublished.publishedHash }),
})).json() as any;
const httpWorld = await (await fetch(base + "/api/chats/" + createdChat.id.split("/").map(encodeURIComponent).join("/"))).json() as any;
assert.equal(httpWorld.world.templateName, "HTTP 世界");
assert.equal(httpWorld.world.snapshot.templateHash, httpPublished.publishedHash);
const staleSave = await fetch(base + "/api/world/template-library/" + encodeURIComponent(created.id), {
  method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: 1, name: "HTTP 世界", template: httpPublished.draft }),
});
assert.equal(staleSave.status, 409);
check("HTTP 模板创建/保存/发布/版本列表/新聊天版本选择/冲突");

server.close();
const backup = new LibraryBackupStore(httpRoot);
const archive = await backup.export();
const preview = await backup.preview(fs.createReadStream(archive));
const restoreConfig = { ...httpConfig, stDataDir: httpRoot };
const restored = await backup.restore(preview.id, restoreConfig as any);
const restoredLibrary = new WorldTemplateLibrary(restored.stDataDir);
assert.equal(restoredLibrary.get(created.id).publishedHash, httpPublished.publishedHash);
const restoredChats = new ChatStore(restored.stDataDir);
assert.equal(restoredChats.readWorld(createdChat.id)!.snapshot.templateHash, httpPublished.publishedHash);
check("整库备份恢复保留模板索引、版本记录和聊天内嵌模板");

console.log("\n" + checks + " 项检查全部通过。");
console.log("测试数据保留目录：" + run);
