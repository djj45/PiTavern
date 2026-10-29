/** Local synthetic fixtures only. Preserve all run data for inspection. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { crc32 } from "node:zlib";
import type { AddressInfo } from "node:net";
import type { LibraryDocumentDto, LibraryBackupPreviewDto, ServerEvent } from "@pitavern/shared";
import type { RegexScript } from "@pitavern/shared/regex";
import { applyRegex } from "@pitavern/shared/regex";
import { extractPngTextChunks, parseCardFromPng } from "../src/stdata/png.ts";

const root = path.resolve(import.meta.dirname, "../../..");
fs.mkdirSync(path.join(root, "data/test-runs"), { recursive: true });
const runDir = fs.mkdtempSync(path.join(root, "data/test-runs/library-"));
process.env.PITAVERN_CONFIG = path.join(runDir, "config.json");
const { defaultConfig, saveConfig, seedDataDirs } = await import("../src/config.ts");
const { LibraryStore } = await import("../src/stdata/library.ts");
const { ChatStore } = await import("../src/stdata/chats.ts");
const { CharacterStore } = await import("../src/stdata/characters.ts");
const { buildModels } = await import("../src/providers/models.ts");
const { SessionManager } = await import("../src/session/manager.ts");
const { createHttpApp } = await import("../src/api/http.ts");
const { attachWebSocket } = await import("../src/api/ws.ts");
const config = defaultConfig(); config.stDataDir = path.join(runDir, "st"); seedDataDirs(config.stDataDir);
const originalRoot = config.stDataDir;
const script = (findRegex: string, replaceString: string): RegexScript => ({ scriptName: "合成脚本", findRegex, replaceString, placement: [1] });
const card = { spec: "chara_card_v3", spec_version: "3.0", outerCustom: { retained: true }, data: { name: "合成向导", description: "本地测试", custom: [1, 2], extensions: { custom: "保留", regex_scripts: [script("preset", "card")] } } };
fs.writeFileSync(path.join(originalRoot, "characters/fixture.json"), JSON.stringify(card));
const preset = { prompts: [], prompt_order: [{ character_id: 100001, order: [{ identifier: "chatHistory", enabled: true }] }],
  custom: "预设保留", extensions: { custom: { retained: true }, regex_scripts: [] } };
fs.writeFileSync(path.join(originalRoot, "OpenAI Settings/fixture.json"), JSON.stringify(preset));
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=", "base64");
const chunk = (keyword: string, text: string) => {
  const data = Buffer.from(`${keyword}\0${text}`, "latin1");
  const out = Buffer.alloc(data.length + 12); out.writeUInt32BE(data.length); out.write("tEXt", 4); data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, out.length - 4)), out.length - 4); return out;
};
const encoded = Buffer.from(JSON.stringify(card)).toString("base64");
const pngCard = Buffer.concat([png.subarray(0, png.length - 12), chunk("Comment", "preserved"), chunk("chara", encoded), chunk("ccv3", encoded), png.subarray(png.length - 12)]);
fs.writeFileSync(path.join(originalRoot, "characters/fixture.png"), pngCard);

const requests: unknown[] = [];
let hold = false;
let received: (() => void) | undefined;
let release: (() => void) | undefined;
const mock = http.createServer(async (req, res) => {
  let raw = ""; for await (const part of req) raw += part;
  requests.push(JSON.parse(raw)); fs.writeFileSync(path.join(runDir, `request-${requests.length}.json`), raw);
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const frame = (delta: object, finish_reason: string | null) => "data: " + JSON.stringify({ id: "synthetic", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta, finish_reason }] }) + "\n\n";
  res.write(frame({ role: "assistant", content: "本地合成回复" }, null));
  if (hold) { received?.(); await new Promise<void>((resolve) => { release = resolve; }); }
  res.end(frame({}, "stop") + "data: [DONE]\n\n");
});
mock.listen(0, "127.0.0.1"); await once(mock, "listening");
config.providers = [{ id: "fixture", name: "合成连接", apiKey: "synthetic-only", baseUrl: `http://127.0.0.1:${(mock.address() as AddressInfo).port}/v1`, models: [{ id: "fixture", name: "本地模型", contextWindow: 8000, maxTokens: 500 }] }];
config.defaultProvider = "fixture"; config.defaultModel = "fixture"; config.contextMode = "bridge"; config.activePreset = "fixture"; config.toolsEnabled = false;
saveConfig(config);
const modelsRef = { current: buildModels(config) };
const characters = new CharacterStore(path.join(originalRoot, "characters"));
const chats = new ChatStore(originalRoot);
const manager = new SessionManager(config, () => modelsRef.current, characters, chats, originalRoot);
const events: ServerEvent[] = []; manager.onEvent((event) => events.push(event));
const server = http.createServer(createHttpApp({ config, modelsRef, characters, chats, sessions: manager, stDataDir: originalRoot, webDistDir: null }));
server.listen(0, "127.0.0.1"); await once(server, "listening");
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const get = async <T>(route: string): Promise<T> => { const response = await fetch(base + route); assert.equal(response.status, 200, await response.clone().text()); return response.json() as Promise<T>; };
const document = (id: string) => get<LibraryDocumentDto>("/api/library/document?" + new URLSearchParams({ id }));
const put = (doc: LibraryDocumentDto) => fetch(base + "/api/library/document", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: doc.resource.id, revision: doc.revision, data: doc.data }) });
try {
  const created = await fetch(base + "/api/library/world", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "合成世界书" }) });
  assert.equal(created.status, 200);
  const world = await created.json() as LibraryDocumentDto;
  world.data = { entries: { "0": { uid: 0, comment: "旅馆", key: ["旅馆"], content: "合成资料", group: "scene", groupWeight: 30, position: 7, outletName: "map", custom: { retained: true } } }, custom: "顶层保留" };
  assert.equal((await put(world)).status, 200);
  const persisted = await document(world.resource.id); assert.deepEqual(persisted.data, world.data);
  assert.equal((await put(world)).status, 409, "旧窗口不能覆盖新的版本");
  const globals = await document("global-regex:regex.json"); globals.data = [{ ...script("start", "global"), custom: { retained: true } } as RegexScript];
  assert.equal((await put(globals)).status, 200);
  const presetDoc = await document("preset-regex:fixture.json"); presetDoc.data = [script("global", "preset")]; assert.equal((await put(presetDoc)).status, 200);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(originalRoot, "OpenAI Settings/fixture.json"), "utf8")), { ...preset, extensions: { ...preset.extensions, regex_scripts: presetDoc.data } });
  const cached = characters.getCharacter("合成向导"); assert.ok(cached);
  const jsonDoc = await document("character-regex:fixture.json"); jsonDoc.data = [{ ...script("preset", "card"), scriptName: "卡片规则" }]; assert.equal((await put(jsonDoc)).status, 200);
  assert.equal((characters.getCharacter("合成向导")!.extensions.regex_scripts as RegexScript[])[0].scriptName, "卡片规则");
  const pngDoc = await document("character-regex:fixture.png"); pngDoc.data = [script("word", "replacement")]; assert.equal((await put(pngDoc)).status, 200);
  const changedPng = fs.readFileSync(path.join(originalRoot, "characters/fixture.png"));
  const chunks = extractPngTextChunks(changedPng)!; assert.equal(chunks.Comment, "preserved");
  for (const keyword of ["chara", "ccv3"]) assert.deepEqual(JSON.parse(Buffer.from(chunks[keyword], "base64").toString("utf8")), { ...card, data: { ...card.data, extensions: { ...card.data.extensions, regex_scripts: pngDoc.data } } });
  for (let offset = 8; offset + 12 <= changedPng.length;) {
    const length = changedPng.readUInt32BE(offset), type = changedPng.toString("latin1", offset + 4, offset + 8);
    if (type === "tEXt") assert.equal(changedPng.readUInt32BE(offset + length + 8), crc32(changedPng.subarray(offset + 4, offset + length + 8)));
    if (type === "IDAT") assert.ok(pngCard.includes(changedPng.subarray(offset, offset + length + 12)), "图像数据原样保留");
    offset += length + 12;
  }
  assert.equal((parseCardFromPng(changedPng)!.data as any).name, card.data.name);
  const history = await get<import("@pitavern/shared").LibraryHistoryPageDto>("/api/library/history?id=character-regex:fixture.png");
  assert.equal(history.items.length, 1);
  const previous = await get<import("@pitavern/shared").LibraryHistoryPreviewDto>("/api/library/history/preview?" + new URLSearchParams({ id: pngDoc.resource.id, backupId: history.items[0].id }));
  assert.deepEqual(previous.document.data, card.data.extensions.regex_scripts);
  const restoreHistory = (revision: string) => fetch(base + "/api/library/history/restore", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: pngDoc.resource.id, backupId: history.items[0].id, revision }) });
  assert.equal((await restoreHistory("stale")).status, 409);
  assert.equal((await restoreHistory((await document(pngDoc.resource.id)).revision)).status, 200);
  assert.deepEqual(fs.readFileSync(path.join(originalRoot, "characters/fixture.png")), pngCard, "历史恢复保持 PNG 原始字节");
  assert.equal((await put(pngDoc)).status, 200);
  assert.equal((await fetch(base + "/api/library/history/preview?" + new URLSearchParams({ id: pngDoc.resource.id, backupId: "../config.json" }))).status, 400);
  assert.ok(events.some((event) => event.type === "library.changed"));
  console.log("✓ 世界书增改、未知字段、旧版本冲突、JSON/PNG 双格式正则、图片与 CRC 保留、缓存刷新");

  const chat = chats.createChat("合成向导", { name: "合成向导", is_user: false, is_system: false, mes: "欢迎" });
  await manager.send(chat.id, "start");
  assert.ok(JSON.stringify(requests[0]).includes('"content":"card"'), "实际请求按全局→预设→角色卡顺序执行");
  const snapshot = manager.snapshot(chat.id)!; assert.equal(snapshot.display!.scripts.length, 3);
  assert.equal(applyRegex("start", snapshot.display!.scripts, { placement: 1, depth: 0, layer: "display" }), "card");
  assert.equal(chats.readChat(chat.id)!.find((line) => line.is_user)!.mes, "start", "原始存档保留");
  chats.editMessage(chat.id, snapshot.messages[0].id, "欢迎回来", snapshot.messages[0].text);
  hold = true;
  const receivedRequest = new Promise<void>((resolve) => { received = resolve; });
  const generating = manager.send(chat.id, "下一轮");
  await receivedRequest;
  assert.equal((await fetch(base + "/api/library-backup/export")).status, 409);
  assert.equal((await put(await document("global-regex:regex.json"))).status, 409);
  release!(); await generating; hold = false;
  const unlock = manager.beginMaintenance("合成备份操作");
  assert.equal((await fetch(base + "/api/chats")).status, 503);
  const count = requests.length; await manager.send(chat.id, "维护期间消息"); assert.equal(requests.length, count); unlock();
  assert.equal((await fetch(base + "/api/chats")).status, 200);
  console.log("✓ 全局正则实际请求与显示顺序、原文存档、生成互斥、维护后恢复操作");

  fs.mkdirSync(path.join(originalRoot, "skills/demo/references"), { recursive: true }); fs.writeFileSync(path.join(originalRoot, "skills/demo/references/test.md"), "# 合成参考");
  fs.mkdirSync(path.join(originalRoot, ".pitavern/vectors/cache"), { recursive: true }); fs.writeFileSync(path.join(originalRoot, ".pitavern/vectors/cache/index.json"), "[]");
  const exported = await fetch(base + "/api/library-backup/export"); assert.equal(exported.status, 200);
  const archive = Buffer.from(await exported.arrayBuffer()); fs.writeFileSync(path.join(runDir, "library.pitavern.gz"), archive);
  const upload = (buffer: Buffer) => fetch(base + "/api/library-backup/preview", { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: new Uint8Array(buffer) });
  const previewResponse = await upload(archive); assert.equal(previewResponse.status, 200, await previewResponse.clone().text());
  const preview = await previewResponse.json() as LibraryBackupPreviewDto; assert.ok(preview.files > 10); assert.ok(preview.counts.chats > 0); assert.ok(preview.counts[".pitavern"] > 0);
  const oldConfig = fs.readFileSync(process.env.PITAVERN_CONFIG!, "utf8"); const oldChat = fs.readFileSync(chat.file);
  assert.equal((await upload(archive.subarray(0, Math.floor(archive.length / 2)))).status, 400, "未完成传输的归档不能恢复");
  assert.equal(fs.readFileSync(process.env.PITAVERN_CONFIG!, "utf8"), oldConfig); assert.deepEqual(fs.readFileSync(chat.file), oldChat);
  const rename = fs.renameSync;
  try {
    fs.renameSync = (source, target) => {
      if (String(target) === process.env.PITAVERN_CONFIG) throw new Error("合成配置写入故障");
      return rename(source, target);
    };
    const failedRestore = await fetch(base + "/api/library-backup/restore", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: preview.id }) });
    assert.equal(failedRestore.status, 400);
    assert.equal(fs.readFileSync(process.env.PITAVERN_CONFIG!, "utf8"), oldConfig);
    assert.equal(config.stDataDir, originalRoot); assert.equal(manager.writeBlocked, null);
    assert.deepEqual(fs.readFileSync(chat.file), oldChat);
  } finally { fs.renameSync = rename; }
  const restoredResponse = await fetch(base + "/api/library-backup/restore", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: preview.id }) });
  assert.equal(restoredResponse.status, 200, await restoredResponse.clone().text());
  const restored = await restoredResponse.json() as { stDataDir: string; previousDataDir: string; restartRequired: boolean };
  assert.equal(restored.previousDataDir, originalRoot); assert.notEqual(restored.stDataDir, originalRoot); assert.equal(restored.restartRequired, true);
  assert.deepEqual(fs.readFileSync(chat.file), oldChat); assert.equal(config.providers[0].apiKey, "synthetic-only");
  assert.equal(JSON.parse(fs.readFileSync(process.env.PITAVERN_CONFIG!, "utf8")).stDataDir, restored.stDataDir);
  assert.equal((await fetch(base + "/api/library")).status, 503); assert.match(manager.writeBlocked!, /重启/);
  assert.equal(fs.existsSync(path.join(restored.stDataDir, ".pitavern/vectors")), false);
  const compare = (dir: string) => {
    for (const name of fs.readdirSync(path.join(originalRoot, dir))) {
      const relative = `${dir}/${name}`;
      if (relative === ".pitavern/vectors") continue;
      if (fs.statSync(path.join(originalRoot, relative)).isDirectory()) compare(relative);
      else assert.deepEqual(fs.readFileSync(path.join(restored.stDataDir, relative)), fs.readFileSync(path.join(originalRoot, relative)), relative);
    }
  };
  for (const dir of ["characters", "chats", "worlds", "OpenAI Settings", "skills", ".pitavern"]) compare(dir);
  const restoredChats = new ChatStore(restored.stDataDir), restoredCharacters = new CharacterStore(path.join(restored.stDataDir, "characters"));
  const restarted = new SessionManager(config, () => modelsRef.current, restoredCharacters, restoredChats, restored.stDataDir);
  assert.equal(restarted.snapshot(chat.id)!.activity!.totalGenerations, 2); assert.equal(restarted.snapshot(chat.id)!.display!.scripts.length, 3);
  assert.deepEqual(new LibraryStore(restored.stDataDir).read(world.resource.id).data, world.data);
  console.log("✓ 整库往返逐文件比对、活动与历史备份、跳过缓存、传输/配置写入失败保持旧库、重启切换与连接保留");
  console.log("测试数据保留：" + runDir);
  if (process.argv.includes("--preview")) {
    const previewServer = http.createServer(createHttpApp({ config, modelsRef, characters: restoredCharacters, chats: restoredChats, sessions: restarted, stDataDir: restored.stDataDir, webDistDir: path.join(root, "apps/web/dist") }));
    attachWebSocket(previewServer, restarted); previewServer.listen(0, "127.0.0.1"); await once(previewServer, "listening");
    const info = { url: `http://127.0.0.1:${(previewServer.address() as AddressInfo).port}`, runDir, pid: process.pid };
    fs.writeFileSync(path.join(runDir, "preview.json"), JSON.stringify(info)); console.log(JSON.stringify(info));
    await new Promise(() => {});
  }
} finally { server.closeAllConnections(); server.close(); mock.closeAllConnections(); mock.close(); }
