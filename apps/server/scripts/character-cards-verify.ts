/** Local synthetic fixtures only. Preserve all run data for inspection. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";
import type { AddressInfo } from "node:net";
import type {
  CharacterCardDeleteResultDto,
  CharacterCardEditorDto,
  CharacterCardFieldsDto,
  CharacterCardSummaryDto,
} from "@pitavern/shared";
import { extractPngTextChunks, parseCardFromPng } from "../src/stdata/png.ts";

const sha = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const repo = path.resolve(import.meta.dirname, "../../..");
fs.mkdirSync(path.join(repo, "data/test-runs"), { recursive: true });
const runDir = fs.mkdtempSync(path.join(repo, "data/test-runs/character-cards-"));
process.env.PITAVERN_CONFIG = path.join(runDir, "config.json");
const { defaultConfig, seedDataDirs } = await import("../src/config.ts");
const { CharacterStore } = await import("../src/stdata/characters.ts");
const { CharacterCardManager, CharacterCardConflictError, CharacterCardNotFoundError } = await import("../src/stdata/character-cards.ts");
const { ChatStore } = await import("../src/stdata/chats.ts");
const { buildModels } = await import("../src/providers/models.ts");
const { SessionManager } = await import("../src/session/manager.ts");
const { createHttpApp } = await import("../src/api/http.ts");

const config = defaultConfig();
config.stDataDir = path.join(runDir, "st");
seedDataDirs(config.stDataDir);
config.toolsEnabled = false;
const dataDir = config.stDataDir;
const charactersDir = path.join(dataDir, "characters");
const backupsRoot = path.join(dataDir, ".pitavern", "card-backups");

const pngChunk = (type: string, data: Buffer): Buffer => {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, out.length - 4)), out.length - 4);
  return out;
};
const textChunk = (keyword: string, text: string) => pngChunk("tEXt", Buffer.from(keyword + "\0" + text, "latin1"));
const encodeCard = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");

interface PngChunk { type: string; keyword: string; data: Buffer }
const pngChunks = (buffer: Buffer): PngChunk[] => {
  const result: PngChunk[] = [];
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("latin1", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    let keyword = "";
    if (type === "tEXt") {
      const zero = data.indexOf(0);
      keyword = data.toString("latin1", 0, Math.max(0, zero));
    }
    result.push({ type, keyword, data });
    offset += length + 12;
    if (type === "IEND") break;
  }
  return result;
};
const isCardChunk = (chunk: PngChunk) => chunk.type === "tEXt" && (chunk.keyword === "chara" || chunk.keyword === "ccv3");
const assertPreservedChunks = (before: Buffer, after: Buffer): void => {
  const original = pngChunks(before).filter((chunk) => !isCardChunk(chunk));
  const saved = pngChunks(after).filter((chunk) => !isCardChunk(chunk));
  assert.equal(saved.length, original.length, "未知 chunk 数量不变");
  for (let index = 0; index < original.length; index++) {
    assert.equal(saved[index]!.type, original[index]!.type);
    assert.deepEqual(saved[index]!.data, original[index]!.data, "像素/未知 chunk 字节原样保留");
  }
};

const cardData = (name: string, description: string) => ({
  name,
  description,
  personality: "原始性格",
  scenario: "原始场景",
  first_mes: "开场白\n第二行",
  mes_example: "原始示例",
  creator_notes: "原始备注",
  system_prompt: "原始系统",
  post_history_instructions: "原始后指令",
  alternate_greetings: ["备用甲", "备用乙"],
  tags: ["标签甲", "标签乙"],
  creator: "作者",
  character_version: "1.0",
  character_book: { name: "卡内书", entries: [{ keys: ["甲"], content: "条目一" }, { keys: ["乙"], content: "条目二" }] },
  extensions: { world: "卡内世界", customUnknown: { keep: true } },
});

const jsonCard = {
  spec: "chara_card_v3",
  spec_version: "3.0",
  topUnknown: { retained: true },
  data: { ...cardData("JSON向导", "JSON原始描述"), dataUnknown: { retained: true } },
};
const jsonFile = path.join(charactersDir, "json-fixture.json");
fs.writeFileSync(jsonFile, JSON.stringify(jsonCard, null, 2) + "\n");

const flatCard = {
  name: "扁平向导",
  description: "扁平原始",
  personality: "扁平性格",
  scenario: "扁平场景",
  first_mes: "扁平开场",
  mes_example: "",
  creator_notes: "",
  system_prompt: "",
  post_history_instructions: "",
  alternate_greetings: [],
  tags: [],
  unknownTop: { retained: true },
};
const flatFile = path.join(charactersDir, "flat-fixture.json");
fs.writeFileSync(flatFile, JSON.stringify(flatCard, null, 2) + "\n");

const basePng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=", "base64");
const cardV2 = { spec: "chara_card_v2", spec_version: "2.0", data: { ...cardData("PNG向导", "PNG原始描述"), v2Unknown: { retained: true } } };
const cardV3 = { spec: "chara_card_v3", spec_version: "3.0", topUnknown: { retained: true }, data: { ...cardData("PNG向导", "PNG原始描述"), v3Unknown: { retained: true } } };
const originalPng = Buffer.concat([
  basePng.subarray(0, basePng.length - 12),
  textChunk("Comment", "preserved-comment"),
  pngChunk("prVt", Buffer.from("unknown-chunk-bytes")),
  textChunk("chara", encodeCard(cardV2)),
  textChunk("ccv3", encodeCard(cardV3)),
  basePng.subarray(basePng.length - 12),
]);
const pngFile = path.join(charactersDir, "png-fixture.png");
fs.writeFileSync(pngFile, originalPng);

const characters = new CharacterStore(charactersDir);
const chats = new ChatStore(dataDir);
const manager = new CharacterCardManager(dataDir, characters, chats);
const noTemporaryFiles = () => assert.deepEqual(
  fs.readdirSync(charactersDir).filter((name) => name.includes(".tmp") || name.includes(".pitavern-write")),
  [],
  "失败/成功写操作都不留下临时文件",
);
const backupNames = (file: string): string[] => {
  const directory = path.join(backupsRoot, sha(path.relative(dataDir, file)));
  return fs.existsSync(directory) ? fs.readdirSync(directory) : [];
};
const fields = (label: string): CharacterCardFieldsDto => ({
  description: "编辑后" + label,
  personality: "新性格",
  scenario: "新场景",
  firstMes: "新开场白" + label,
  mesExample: "新示例",
  creatorNotes: "新备注",
  systemPrompt: "新系统",
  postHistoryInstructions: "新后指令",
  alternateGreetings: ["新备用一", "新备用二", "新备用三"],
  tags: ["新标签", "第二标签"],
});

try {
  const entry = characters.getEntry("PNG向导");
  assert.ok(entry, "getEntry 返回文件与解析卡");
  assert.ok(path.isAbsolute(entry.file), "entry 文件路径为绝对路径");
  assert.equal(entry.file, pngFile);
  assert.equal(characters.getCharacter("PNG向导")!.name, "PNG向导", "保留 getCharacter 行为");
  assert.equal(characters.listCharacters().length, 3);
  assert.equal(characters.listEntries().length, 3);
  assert.equal(new Set(characters.listEntries().map((item) => item.file)).size, 3);

  const pngChat = chats.createChat("PNG向导", { name: "PNG向导", is_user: false, is_system: false, mes: "欢迎" }, "旅人");
  const jsonChat = chats.createChat("JSON向导", { name: "JSON向导", is_user: false, is_system: false, mes: "欢迎" }, "旅人");

  const summaries = manager.list();
  assert.equal(summaries.length, 3);
  const pngSummary = summaries.find((item) => item.name === "PNG向导")!;
  assert.equal(pngSummary.format, "png");
  assert.equal(pngSummary.file, "characters/png-fixture.png");
  assert.equal(pngSummary.chatCount, 1);
  assert.equal(pngSummary.characterBookEntries, 2);
  assert.equal(pngSummary.worldName, "卡内世界");
  assert.equal(pngSummary.alternateGreetings, 2);
  assert.equal(pngSummary.firstMesPreview, "开场白 第二行");
  assert.equal(pngSummary.revision, sha(originalPng));
  assert.equal(pngSummary.avatarUrl, "/api/characters/" + encodeURIComponent("PNG向导") + "/avatar");
  const jsonSummary = summaries.find((item) => item.name === "JSON向导")!;
  assert.equal(jsonSummary.format, "json");
  assert.equal(jsonSummary.file, "characters/json-fixture.json");
  assert.equal(jsonSummary.chatCount, 1);
  assert.equal(jsonSummary.characterBookEntries, 2);
  assert.equal(jsonSummary.worldName, "卡内世界");
  assert.equal(jsonSummary.avatarUrl, "");
  const flatSummary = summaries.find((item) => item.name === "扁平向导")!;
  assert.equal(flatSummary.format, "json");
  assert.equal(flatSummary.chatCount, 0);
  assert.equal(flatSummary.characterBookEntries, 0);
  assert.equal(flatSummary.worldName, undefined);

  const pngEditor = manager.read("PNG向导");
  assert.equal(pngEditor.spec, "chara_card_v3");
  assert.equal(pngEditor.firstMes, "开场白\n第二行");
  assert.equal(pngEditor.mesExample, "原始示例");
  assert.deepEqual(pngEditor.alternateGreetingTexts, ["备用甲", "备用乙"]);
  assert.equal(pngEditor.revision, pngSummary.revision);
  assert.throws(() => manager.read("不存在的角色"), CharacterCardNotFoundError);
  console.log("✓ listEntries/getEntry 绝对路径、摘要中的格式/世界书/worldName/chatCount/预览/头像/版本");

  const pngSaved = manager.save("PNG向导", pngEditor.revision, fields("PNG"));
  assert.equal(pngSaved.description, "编辑后PNG");
  assert.equal(pngSaved.alternateGreetings, 3);
  assert.deepEqual(pngSaved.alternateGreetingTexts, ["新备用一", "新备用二", "新备用三"]);
  assert.equal(pngSaved.chatCount, 1, "保存不影响已有聊天");
  const savedPng = fs.readFileSync(pngFile);
  assert.equal(pngSaved.revision, sha(savedPng));
  assert.notEqual(pngSaved.revision, pngEditor.revision);
  const savedText = extractPngTextChunks(savedPng)!;
  assert.equal(savedText.Comment, "preserved-comment");
  for (const keyword of ["chara", "ccv3"]) {
    const raw = JSON.parse(Buffer.from(savedText[keyword], "base64").toString("utf8")) as Record<string, any>;
    const body = raw.data as Record<string, any>;
    assert.equal(body.name, "PNG向导", "名称不可通过字段修改");
    assert.equal(body.description, "编辑后PNG");
    assert.equal(body.personality, "新性格");
    assert.equal(body.scenario, "新场景");
    assert.equal(body.first_mes, "新开场白PNG");
    assert.equal(body.mes_example, "新示例");
    assert.equal(body.creator_notes, "新备注");
    assert.equal(body.system_prompt, "新系统");
    assert.equal(body.post_history_instructions, "新后指令");
    assert.deepEqual(body.alternate_greetings, ["新备用一", "新备用二", "新备用三"]);
    assert.deepEqual(body.tags, ["新标签", "第二标签"]);
    assert.equal(body.extensions.world, "卡内世界");
    assert.equal(body.extensions.customUnknown.keep, true);
    assert.equal(body.character_book.entries.length, 2);
    if (keyword === "chara") assert.equal(body.v2Unknown.retained, true, "V2 chunk 未知字段保留");
    else {
      assert.equal(body.v3Unknown.retained, true, "V3 chunk 未知字段保留");
      assert.equal(raw.topUnknown.retained, true, "PNG 顶层未知字段保留");
    }
  }
  assertPreservedChunks(originalPng, savedPng);
  assert.equal((parseCardFromPng(savedPng)!.data as Record<string, unknown>).name, "PNG向导");
  const pngBackups = backupNames(pngFile);
  assert.equal(pngBackups.length, 1);
  assert.deepEqual(fs.readFileSync(path.join(backupsRoot, sha(path.relative(dataDir, pngFile)), pngBackups[0]!)), originalPng);

  assert.throws(
    () => manager.save("PNG向导", pngEditor.revision, fields("冲突")),
    (error: unknown) => error instanceof CharacterCardConflictError && /其他窗口/.test(error.message),
  );
  assert.deepEqual(fs.readFileSync(pngFile), savedPng, "revision 冲突不覆盖他人修改");
  assert.equal(backupNames(pngFile).length, 1, "revision 冲突不产生新备份");
  assert.throws(() => manager.save("PNG向导", pngSaved.revision, { ...fields("越界"), tags: new Array(101).fill("x") }), /最多 100 条/);
  assert.deepEqual(fs.readFileSync(pngFile), savedPng, "字段校验失败不落盘");
  assert.equal(backupNames(pngFile).length, 1);
  assert.throws(() => manager.save("PNG向导", pngSaved.revision, { ...fields("改名"), name: "新名字" }), /名称不可修改/);
  assert.deepEqual(fs.readFileSync(pngFile), savedPng, "名称修改被拒绝且不落盘");
  noTemporaryFiles();
  const pngAgain = manager.save("PNG向导", pngSaved.revision, fields("PNG二"));
  assert.equal(pngAgain.description, "编辑后PNG二");
  assert.equal(backupNames(pngFile).length, 2, "每次成功保存前都备份原文件");
  noTemporaryFiles();
  console.log("✓ PNG 编辑保留像素/未知 chunk/V2+V3 双 chunk/未知字段；冲突与校验失败无半成品，备份存在");

  const jsonEditor = manager.read("JSON向导");
  const jsonSaved = manager.save("JSON向导", jsonEditor.revision, fields("JSON"));
  assert.equal(jsonSaved.description, "编辑后JSON");
  const jsonRaw = JSON.parse(fs.readFileSync(jsonFile, "utf8")) as Record<string, any>;
  assert.equal(jsonRaw.spec, "chara_card_v3");
  assert.equal(jsonRaw.spec_version, "3.0");
  assert.equal(jsonRaw.topUnknown.retained, true, "JSON 顶层未知字段保留");
  assert.equal(jsonRaw.data.dataUnknown.retained, true, "JSON data 未知字段保留");
  assert.equal(jsonRaw.data.name, "JSON向导");
  assert.equal(jsonRaw.data.description, "编辑后JSON");
  assert.deepEqual(jsonRaw.data.alternate_greetings, ["新备用一", "新备用二", "新备用三"]);
  assert.equal(jsonRaw.data.character_book.entries.length, 2);
  assert.equal(jsonRaw.data.extensions.customUnknown.keep, true);
  assert.equal(jsonSaved.revision, sha(fs.readFileSync(jsonFile)));
  assert.equal(backupNames(jsonFile).length, 1);

  const flatEditor = manager.read("扁平向导");
  const flatSaved = manager.save("扁平向导", flatEditor.revision, fields("扁平"));
  assert.equal(flatSaved.spec, "chara_card_v2");
  const flatRaw = JSON.parse(fs.readFileSync(flatFile, "utf8")) as Record<string, any>;
  assert.equal(flatRaw.data, undefined, "扁平 JSON 不新增 spec/data 顶层结构");
  assert.equal(flatRaw.unknownTop.retained, true, "扁平 JSON 未知字段保留");
  assert.equal(flatRaw.name, "扁平向导");
  assert.equal(flatRaw.description, "编辑后扁平");
  assert.deepEqual(flatRaw.alternate_greetings, ["新备用一", "新备用二", "新备用三"]);
  noTemporaryFiles();
  console.log("✓ JSON spec/data 与扁平结构分别编辑，顶层/未知字段和卡内世界书保留");

  const firstCopy = manager.duplicate("PNG向导");
  assert.equal(firstCopy.name, "PNG向导 副本");
  assert.equal(firstCopy.format, "png");
  assert.equal(firstCopy.file, "characters/PNG向导 副本.png");
  assert.equal(firstCopy.chatCount, 0, "复制不复制聊天");
  assert.equal(firstCopy.characterBookEntries, 2);
  assert.equal(firstCopy.worldName, "卡内世界");
  const firstCopyFile = path.join(charactersDir, "PNG向导 副本.png");
  assert.ok(fs.existsSync(firstCopyFile));
  const firstCopyBuffer = fs.readFileSync(firstCopyFile);
  assertPreservedChunks(fs.readFileSync(pngFile), firstCopyBuffer);
  const copyText = extractPngTextChunks(firstCopyBuffer)!;
  for (const keyword of ["chara", "ccv3"]) {
    const raw = JSON.parse(Buffer.from(copyText[keyword], "base64").toString("utf8")) as Record<string, any>;
    assert.equal(raw.data.name, "PNG向导 副本", "PNG 副本改卡片名");
    assert.equal(raw.data.description, "编辑后PNG二");
  }
  assert.equal(chats.listChats("PNG向导 副本").length, 0);
  const secondCopy = manager.duplicate("PNG向导");
  assert.equal(secondCopy.name, "PNG向导 副本 2", "默认副本名自动唯一");
  const explicitCopy = manager.duplicate("JSON向导", "JSON向导 自定义");
  assert.equal(explicitCopy.name, "JSON向导 自定义");
  assert.equal(explicitCopy.file, "characters/JSON向导 自定义.json");
  assert.equal(explicitCopy.chatCount, 0);
  const explicitFile = path.join(charactersDir, "JSON向导 自定义.json");
  const explicitRaw = JSON.parse(fs.readFileSync(explicitFile, "utf8")) as Record<string, any>;
  assert.equal(explicitRaw.data.name, "JSON向导 自定义");
  assert.equal(explicitRaw.data.description, "编辑后JSON");
  assert.equal(explicitRaw.topUnknown.retained, true, "JSON 副本保留顶层未知字段");
  assert.equal(explicitRaw.data.dataUnknown.retained, true);
  assert.throws(() => manager.duplicate("PNG向导", "JSON向导"), CharacterCardConflictError);
  const placeholder = path.join(charactersDir, "占位卡.png");
  fs.writeFileSync(placeholder, "not a png card");
  assert.throws(
    () => manager.duplicate("PNG向导", "占位卡"),
    (error: unknown) => error instanceof CharacterCardConflictError && /文件名已存在/.test(error.message),
  );
  assert.deepEqual(fs.readdirSync(charactersDir).filter((name) => name.includes(".tmp")), [], "复制冲突不留下临时文件");
  fs.unlinkSync(placeholder);
  console.log("✓ 复制默认名/自动唯一/显式命名/独立文件/不含聊天/重名与文件名冲突 409 类错误");

  const pngExport = manager.export("PNG向导");
  assert.equal(pngExport.fileName, "png-fixture.png");
  assert.equal(pngExport.contentType, "image/png");
  assert.deepEqual(pngExport.buffer, fs.readFileSync(pngFile));
  const jsonExport = manager.export("JSON向导");
  assert.equal(jsonExport.fileName, "json-fixture.json");
  assert.equal(jsonExport.contentType, "application/json");
  assert.deepEqual(jsonExport.buffer, fs.readFileSync(jsonFile));
  assert.throws(() => manager.export("不存在的角色"), CharacterCardNotFoundError);
  console.log("✓ 导出字节与当前文件一致，格式/content-type 正确");

  const modelsRef = { current: buildModels(config) };
  const sessions = new SessionManager(config, () => modelsRef.current, characters, chats, dataDir);
  const eventTypes: string[] = [];
  sessions.onEvent((event) => eventTypes.push(event.type));
  const server = http.createServer(createHttpApp({ config, modelsRef, characters, chats, sessions, stDataDir: dataDir, webDistDir: null }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  const cardRoute = (name: string) => base + "/api/character-cards/" + encodeURIComponent(name);
  try {
    const listResponse = await fetch(base + "/api/character-cards");
    assert.equal(listResponse.status, 200);
    const list = await listResponse.json() as CharacterCardSummaryDto[];
    assert.ok(list.some((item) => item.name === "PNG向导"));
    assert.ok(list.some((item) => item.name === "扁平向导"));

    const getResponse = await fetch(cardRoute("PNG向导"));
    assert.equal(getResponse.status, 200);
    const editor = await getResponse.json() as CharacterCardEditorDto;
    assert.equal(editor.name, "PNG向导");
    assert.equal(editor.revision, sha(fs.readFileSync(pngFile)));
    assert.equal((await fetch(cardRoute("no-such-card"))).status, 404);

    const stale = await fetch(cardRoute("PNG向导"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ revision: "stale", fields: fields("HTTP") }),
    });
    assert.equal(stale.status, 409);
    assert.match((await stale.json() as { error: string }).error, /其他窗口/);

    const savedResponse = await fetch(cardRoute("PNG向导"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ revision: editor.revision, fields: fields("HTTP") }),
    });
    assert.equal(savedResponse.status, 200, await savedResponse.clone().text());
    const httpEditor = await savedResponse.json() as CharacterCardEditorDto;
    assert.equal(httpEditor.description, "编辑后HTTP");
    assert.equal(httpEditor.revision, sha(fs.readFileSync(pngFile)));

    const duplicateResponse = await fetch(cardRoute("PNG向导") + "/duplicate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(duplicateResponse.status, 200);
    const httpCopy = await duplicateResponse.json() as CharacterCardSummaryDto;
    assert.equal(httpCopy.name, "PNG向导 副本 3");
    const conflictResponse = await fetch(cardRoute("PNG向导") + "/duplicate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "JSON向导" }),
    });
    assert.equal(conflictResponse.status, 409);
    assert.match((await conflictResponse.json() as { error: string }).error, /已存在/);

    const exportResponse = await fetch(cardRoute("PNG向导") + "/export");
    assert.equal(exportResponse.status, 200);
    assert.equal(exportResponse.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await exportResponse.arrayBuffer()), fs.readFileSync(pngFile));
    const jsonExportResponse = await fetch(cardRoute("JSON向导") + "/export");
    assert.equal(jsonExportResponse.status, 200);
    assert.equal(jsonExportResponse.headers.get("content-type"), "application/json");
    assert.deepEqual(Buffer.from(await jsonExportResponse.arrayBuffer()), fs.readFileSync(jsonFile));

    const deleteResponse = await fetch(cardRoute(httpCopy.name), { method: "DELETE" });
    assert.equal(deleteResponse.status, 200);
    assert.deepEqual(await deleteResponse.json() as CharacterCardDeleteResultDto, { name: "PNG向导 副本 3", chatCount: 0 });
    assert.equal(fs.existsSync(path.join(charactersDir, "PNG向导 副本 3.png")), false);
    assert.ok(eventTypes.filter((type) => type === "library.changed").length >= 3, "写操作广播 library.changed");
    console.log("✓ HTTP 列表/读取/404/409 冲突/保存/自动重名复制/显式重名 409/导出字节/删除/广播");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  const deleteResult = manager.delete("JSON向导");
  assert.deepEqual(deleteResult, { name: "JSON向导", chatCount: 1 });
  assert.equal(fs.existsSync(jsonFile), false);
  assert.equal(chats.listChats("JSON向导").length, 1, "删除角色卡不删除聊天");
  assert.ok(chats.readChat(jsonChat.id), "原聊天仍可读取");
  assert.equal(chats.readChat(jsonChat.id)![0]!.mes, "欢迎");
  assert.throws(() => manager.read("JSON向导"), CharacterCardNotFoundError);
  assert.ok(fs.existsSync(explicitFile), "删除原卡不影响复制卡");
  assert.ok(fs.existsSync(pngFile), "删除原卡不影响其他角色");
  assert.ok(chats.readChat(pngChat.id));
  console.log("✓ 删除只移除角色卡文件，聊天与复制卡保留");

  const finalList = manager.list();
  assert.equal(finalList.length, 5);
  assert.equal(finalList.find((item) => item.name === "扁平向导")!.chatCount, 0);
  assert.equal(backupNames(pngFile).length, 3);
  noTemporaryFiles();
  console.log("测试数据保留：" + runDir);
} finally {
  // 保留全部验证产物（包括失败场景的中间文件）供排查。
}
