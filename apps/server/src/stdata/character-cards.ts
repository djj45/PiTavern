import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type {
  CharacterCardDeleteResultDto,
  CharacterCardEditorDto,
  CharacterCardFieldsDto,
  CharacterCardFormat,
  CharacterCardSummaryDto,
} from "@pitavern/shared";
import type { CharacterStore, CharacterStoreEntry } from "./characters.ts";
import type { ChatStore } from "./chats.ts";
import { atomicWrite, object } from "./files.ts";
import { rewritePngCard } from "./png.ts";

const MAX_FIELD_LENGTH = 100_000;
const MAX_ARRAY_ITEMS = 100;
const MAX_NAME_LENGTH = 200;
const PREVIEW_LENGTH = 200;
const MAX_DUPLICATE_ATTEMPTS = 1000;

const hash = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

/** 角色卡不存在（HTTP 404）。 */
export class CharacterCardNotFoundError extends Error {
  constructor(name: string) {
    super(`角色卡不存在：${name}`);
    this.name = "CharacterCardNotFoundError";
  }
}

/** 角色卡版本冲突或目标重名（HTTP 409）。 */
export class CharacterCardConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CharacterCardConflictError";
  }
}

/** 导出原格式文件的字节与下载信息。 */
export interface CharacterCardExportFile {
  buffer: Buffer;
  fileName: string;
  contentType: string;
}

function cardFormat(file: string): CharacterCardFormat {
  const extension = path.extname(file).toLowerCase();
  if (extension === ".png") return "png";
  if (extension === ".json") return "json";
  throw new Error("角色卡格式无效");
}

function cardBookEntryCount(value: unknown): number {
  return object(value) && Array.isArray(value.entries) ? value.entries.length : 0;
}

function preview(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, PREVIEW_LENGTH);
}

function validateCardName(value: unknown): string {
  if (typeof value !== "string") throw new Error("角色名称必须是文本");
  const name = value.trim();
  if (!name) throw new Error("角色名称不能为空");
  if (Array.from(name).length > MAX_NAME_LENGTH) throw new Error(`角色名称最多 ${MAX_NAME_LENGTH} 个字符`);
  if (/[\x00-\x1f]/.test(name)) throw new Error("角色名称包含控制字符");
  return name;
}

/** 复制时生成文件名；不移动原文件，只做字符替换和长度限制。 */
function safeFileStem(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").trim().replace(/^\.+$/, "");
  const characters = Array.from(cleaned || "角色卡");
  let stem = "";
  for (const character of characters) {
    if (Buffer.byteLength(stem + character) > 200) break;
    stem += character;
  }
  return stem || "角色卡";
}

function stringField(input: Record<string, unknown>, key: string, label: string): string {
  const value = input[key];
  if (typeof value !== "string") throw new Error(`${label}必须是文本`);
  if (value.length > MAX_FIELD_LENGTH) throw new Error(`${label}最多 ${MAX_FIELD_LENGTH} 个字符`);
  return value;
}

function stringArrayField(input: Record<string, unknown>, key: string, label: string): string[] {
  const value = input[key];
  if (!Array.isArray(value) || value.length > MAX_ARRAY_ITEMS) {
    throw new Error(`${label}需要字符串数组，最多 ${MAX_ARRAY_ITEMS} 条`);
  }
  for (const item of value) {
    if (typeof item !== "string") throw new Error(`${label}需要字符串数组`);
    if (item.length > MAX_FIELD_LENGTH) throw new Error(`${label}单条最多 ${MAX_FIELD_LENGTH} 个字符`);
  }
  return [...value] as string[];
}

function validateFields(name: string, input: unknown): CharacterCardFieldsDto {
  if (!object(input)) throw new Error("角色卡字段无效");
  if (Object.hasOwn(input, "name") && input.name !== name) throw new Error("角色名称不可修改");
  return {
    description: stringField(input, "description", "描述"),
    personality: stringField(input, "personality", "性格"),
    scenario: stringField(input, "scenario", "场景"),
    firstMes: stringField(input, "firstMes", "默认开场白"),
    mesExample: stringField(input, "mesExample", "示例对话"),
    creatorNotes: stringField(input, "creatorNotes", "作者备注"),
    systemPrompt: stringField(input, "systemPrompt", "系统提示"),
    postHistoryInstructions: stringField(input, "postHistoryInstructions", "历史后指令"),
    alternateGreetings: stringArrayField(input, "alternateGreetings", "备用开场白"),
    tags: stringArrayField(input, "tags", "标签"),
  };
}

function applyFields(card: Record<string, unknown>, fields: CharacterCardFieldsDto): void {
  card.description = fields.description;
  card.personality = fields.personality;
  card.scenario = fields.scenario;
  card.first_mes = fields.firstMes;
  card.mes_example = fields.mesExample;
  card.creator_notes = fields.creatorNotes;
  card.system_prompt = fields.systemPrompt;
  card.post_history_instructions = fields.postHistoryInstructions;
  card.alternate_greetings = [...fields.alternateGreetings];
  card.tags = [...fields.tags];
}

/**
 * 角色卡管理：列表/编辑/复制/删除/导出。
 * 编辑只改归一化字段对应的 JSON；PNG 走 rewritePngCard 保留像素/未知 chunk，JSON 保留顶层结构与未知字段。
 */
export class CharacterCardManager {
  private readonly charactersDir: string;

  constructor(
    private readonly stDataDir: string,
    private readonly characters: CharacterStore,
    private readonly chats: ChatStore,
  ) {
    this.charactersDir = path.resolve(stDataDir, "characters");
  }

  list(): CharacterCardSummaryDto[] {
    // 一次扫描聊天列表，避免每张卡都重建一次全量聊天索引。
    const counts = new Map<string, number>();
    for (const chat of this.chats.listChats()) {
      for (const name of new Set([chat.character, ...(chat.group?.members ?? [])])) {
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    }
    return this.characters.listEntries().map((entry) => this.summary(entry, fs.readFileSync(entry.file), counts.get(entry.card.name) ?? 0));
  }

  read(name: string): CharacterCardEditorDto {
    const entry = this.entry(name);
    const buffer = fs.readFileSync(entry.file);
    return this.editor(entry, buffer);
  }

  /** 新建空白 JSON 角色卡；不写头像，名称唯一，文件独占创建。 */
  create(nameInput: unknown): CharacterCardEditorDto {
    const name = validateCardName(nameInput);
    if (this.characters.getEntry(name)) throw new CharacterCardConflictError(`同名角色已存在：${name}`);
    const target = this.newCardFile(name, "json");
    if (fs.existsSync(target)) throw new CharacterCardConflictError(`角色卡文件名已存在：${path.basename(target)}`);
    const raw = {
      spec: "chara_card_v2", spec_version: "2.0",
      data: {
        name, description: "", personality: "", scenario: "", first_mes: "", mes_example: "",
        creator_notes: "", system_prompt: "", post_history_instructions: "",
        alternate_greetings: [], tags: [], creator: "", character_version: "", extensions: {},
      },
    };
    const content = Buffer.from(JSON.stringify(raw, null, 2) + "\n");
    try {
      this.exclusiveWrite(target, content);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new CharacterCardConflictError(`角色卡文件名已存在：${path.basename(target)}`);
      }
      throw error;
    }
    this.characters.invalidate();
    return this.read(name);
  }

  /** 带 revision 的保存；写前备份，冲突不落盘、不产生临时文件。 */
  save(name: string, expectedRevision: string, input: unknown): CharacterCardEditorDto {
    if (typeof expectedRevision !== "string" || !expectedRevision) throw new Error("缺少角色卡版本");
    const entry = this.entry(name);
    const buffer = fs.readFileSync(entry.file);
    if (hash(buffer) !== expectedRevision) {
      throw new CharacterCardConflictError("角色卡已被其他窗口修改；请重新载入后再保存");
    }
    const fields = validateFields(entry.card.name, input);
    const format = cardFormat(entry.file);
    const output = format === "png"
      ? rewritePngCard(buffer, (card) => applyFields(card, fields))
      : this.updatedJson(buffer, fields);
    this.backup(entry.file, buffer);
    atomicWrite(entry.file, output);
    this.characters.invalidate();
    return this.read(entry.card.name);
  }

  /** 同格式另存新卡：默认“原名 副本”并自动避开重名；不复制聊天，不覆盖已有文件。 */
  duplicate(name: string, requestedName?: string): CharacterCardSummaryDto {
    const source = this.entry(name);
    const buffer = fs.readFileSync(source.file);
    const format = cardFormat(source.file);

    if (requestedName !== undefined) {
      const targetName = validateCardName(requestedName);
      if (this.characters.getEntry(targetName)) throw new CharacterCardConflictError(`同名角色已存在：${targetName}`);
      const target = this.newCardFile(targetName, format);
      if (fs.existsSync(target)) throw new CharacterCardConflictError(`角色卡文件名已存在：${path.basename(target)}`);
      try {
        this.writeDuplicate(buffer, format, targetName, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new CharacterCardConflictError(`角色卡文件名已存在：${path.basename(target)}`);
        }
        throw error;
      }
      this.characters.invalidate();
      return this.summary(this.entry(targetName));
    }

    for (let index = 1; index <= MAX_DUPLICATE_ATTEMPTS; index++) {
      const candidate = (index === 1 ? `${name} 副本` : `${name} 副本 ${index}`).trim();
      if (!candidate || this.characters.getEntry(candidate)) continue;
      const target = this.newCardFile(candidate, format);
      if (fs.existsSync(target)) continue;
      try {
        this.writeDuplicate(buffer, format, candidate, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw error;
      }
      this.characters.invalidate();
      return this.summary(this.entry(candidate));
    }
    throw new CharacterCardConflictError("无法生成不重名的副本名称");
  }

  /** 只删除角色卡文件；聊天、群聊和世界书保持不变。 */
  delete(name: string): CharacterCardDeleteResultDto {
    const entry = this.entry(name);
    if (!fs.lstatSync(entry.file).isFile()) throw new Error("角色卡不是普通文件");
    const chatCount = this.chats.listChats(entry.card.name).length;
    fs.unlinkSync(entry.file);
    this.characters.invalidate();
    return { name: entry.card.name, chatCount };
  }

  /** 返回当前卡文件原始字节（导出不触发写操作）。 */
  export(name: string): CharacterCardExportFile {
    const entry = this.entry(name);
    const format = cardFormat(entry.file);
    return {
      buffer: fs.readFileSync(entry.file),
      fileName: path.basename(entry.file),
      contentType: format === "png" ? "image/png" : "application/json",
    };
  }

  private entry(name: string): CharacterStoreEntry {
    const entry = this.characters.getEntry(name);
    if (!entry) throw new CharacterCardNotFoundError(name);
    return entry;
  }

  private summary(
    entry: CharacterStoreEntry,
    buffer: Buffer = fs.readFileSync(entry.file),
    chatCount = this.chats.listChats(entry.card.name).length,
  ): CharacterCardSummaryDto {
    const card = entry.card;
    return {
      name: card.name,
      avatarUrl: card.avatarFile ? `/api/characters/${encodeURIComponent(card.name)}/avatar` : "",
      format: cardFormat(entry.file),
      file: path.relative(this.stDataDir, entry.file).split(path.sep).join("/"),
      description: card.description,
      tags: [...card.tags],
      firstMesPreview: preview(card.firstMes),
      alternateGreetings: card.alternateGreetings.length,
      characterBookEntries: cardBookEntryCount(card.characterBook),
      ...(card.worldName ? { worldName: card.worldName } : {}),
      chatCount,
      revision: hash(buffer),
    };
  }

  private editor(entry: CharacterStoreEntry, buffer: Buffer): CharacterCardEditorDto {
    const card = entry.card;
    return {
      ...this.summary(entry, buffer),
      spec: card.spec,
      personality: card.personality,
      scenario: card.scenario,
      firstMes: card.firstMes,
      mesExample: card.mesExample,
      creatorNotes: card.creatorNotes,
      systemPrompt: card.systemPrompt,
      postHistoryInstructions: card.postHistoryInstructions,
      alternateGreetingTexts: [...card.alternateGreetings],
      creator: card.creator,
      characterVersion: card.characterVersion,
    };
  }

  private parseJson(buffer: Buffer): Record<string, unknown> {
    let raw: unknown;
    try {
      raw = JSON.parse(buffer.toString("utf8"));
    } catch {
      throw new Error("角色卡 JSON 无法解析");
    }
    if (!object(raw)) throw new Error("角色卡 JSON 不是对象");
    return raw;
  }

  /** 与 CharacterStore 一致：有 data 对象时改 data，否则改扁平顶层。 */
  private jsonBody(raw: Record<string, unknown>): Record<string, unknown> {
    return object(raw.data) ? raw.data : raw;
  }

  private updatedJson(buffer: Buffer, fields: CharacterCardFieldsDto): Buffer {
    const raw = this.parseJson(buffer);
    applyFields(this.jsonBody(raw), fields);
    return Buffer.from(JSON.stringify(raw, null, 2) + "\n");
  }

  private writeDuplicate(buffer: Buffer, format: CharacterCardFormat, name: string, target: string): void {
    const output = format === "png"
      ? rewritePngCard(buffer, (card) => { card.name = name; })
      : (() => {
        const raw = this.parseJson(buffer);
        this.jsonBody(raw).name = name;
        return Buffer.from(JSON.stringify(raw, null, 2) + "\n");
      })();
    this.exclusiveWrite(target, output);
  }

  private newCardFile(name: string, format: CharacterCardFormat): string {
    return path.join(this.charactersDir, `${safeFileStem(name)}.${format}`);
  }

  /** 写前备份原文件；路径哈希与资料库编辑器备份目录分开。 */
  private backup(file: string, buffer: Buffer): void {
    const relative = path.relative(this.stDataDir, file);
    const directory = path.join(this.stDataDir, ".pitavern", "card-backups", hash(relative));
    atomicWrite(path.join(directory, `${Date.now()}-${randomUUID()}${path.extname(file).toLowerCase()}`), buffer);
  }

  /** 新文件按独占 link 发布：绝不覆盖已有文件，失败不留下半张卡。 */
  private exclusiveWrite(file: string, content: Buffer): void {
    const directory = path.dirname(file);
    fs.mkdirSync(directory, { recursive: true });
    const temporary = path.join(directory, `.pitavern-duplicate-${randomUUID()}.tmp`);
    try {
      const fd = fs.openSync(temporary, "wx", 0o600);
      try {
        fs.writeFileSync(fd, content);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.linkSync(temporary, file);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
}
