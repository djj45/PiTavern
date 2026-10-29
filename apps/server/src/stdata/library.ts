import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { LibraryDocumentDto, LibraryKind, LibraryResourceDto, LibraryHistoryDto, LibraryHistoryPageDto, LibraryHistoryPreviewDto } from "@pitavern/shared";
import { normalizeRegexScripts, parseFindRegex, type RegexScript } from "@pitavern/shared/regex";
import { atomicWrite, object } from "./files.ts";
import { parseCardFromPng, rewritePngRegex, rewritePngCard } from "./png.ts";

const hash = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const dirs = { world: "worlds", "character-world": "characters", "preset-regex": "OpenAI Settings", "character-regex": "characters", "global-regex": ".pitavern" };
const isCharacter = (kind: LibraryKind) => kind === "character-regex" || kind === "character-world";

function validateCardBook(data: unknown): asserts data is Record<string, unknown> {
  if (!object(data) || !Array.isArray(data.entries) || data.entries.length > 10000) throw new Error("卡内世界书需要 entries 数组，最多 10000 条");
  for (const entry of data.entries) {
    if (!object(entry) || typeof entry.content !== "string" || (entry.extensions != null && !object(entry.extensions))) throw new Error("卡内世界书条目结构无效");
    for (const key of ["keys", "secondary_keys"]) {
      if (entry[key] !== undefined && (!Array.isArray(entry[key]) || (entry[key] as unknown[]).some((value) => typeof value !== "string"))) throw new Error("关键词需要字符串数组");
    }
    for (const key of ["enabled", "constant", "selective", "case_sensitive"]) {
      if (entry[key] != null && typeof entry[key] !== "boolean") throw new Error(key + " 必须为开关");
    }
    const numeric = ["insertion_order", "probability", "sticky", "cooldown", "delay"];
    for (const key of numeric) if (entry[key] != null && (typeof entry[key] !== "number" || !Number.isFinite(entry[key]))) throw new Error(key + " 必须为有限数值");
    if (object(entry.extensions)) {
      for (const key of ["position", "order", "depth", "probability", "sticky", "cooldown", "delay", "group_weight", "groupWeight", "scan_depth", "scanDepth", "selectiveLogic"]) {
        const value = entry.extensions[key];
        if (value != null && (typeof value !== "number" || !Number.isFinite(value))) throw new Error(key + " 必须为有限数值");
      }
      for (const key of ["vectorized", "useProbability", "case_sensitive", "caseSensitive", "match_whole_words", "matchWholeWords", "exclude_recursion", "excludeRecursion", "prevent_recursion", "preventRecursion", "group_override", "groupOverride", "use_group_scoring", "useGroupScoring"]) {
        if (entry.extensions[key] != null && typeof entry.extensions[key] !== "boolean") throw new Error(key + " 必须为开关");
      }
    }
  }
}
const globalFile = "regex.json";
const safeFile = (name: string) => name.length > 0 && name !== "." && name !== ".." && !/[\\/\x00-\x1f]/.test(name) && path.basename(name) === name;

export function globalRegex(stDataDir: string): RegexScript[] {
  const file = path.join(stDataDir, ".pitavern", globalFile);
  if (!fs.existsSync(file)) return [];
  return normalizeRegexScripts(JSON.parse(fs.readFileSync(file, "utf8")).scripts);
}

function validateScripts(data: unknown): asserts data is RegexScript[] {
  if (!Array.isArray(data) || data.length > 1000) throw new Error("正则必须是数组，最多 1000 条");
  for (const script of data) {
    if (!object(script) || typeof script.findRegex !== "string" || typeof script.replaceString !== "string" ||
      !Array.isArray(script.placement) || script.placement.some((p) => ![0, 1, 2, 3, 5, 6].includes(p))) throw new Error("正则内容或作用位置无效");
    if (!script.disabled && !parseFindRegex(script.findRegex)) throw new Error(`正则表达式无效：${script.scriptName ?? script.findRegex}`);
    for (const key of ["disabled", "markdownOnly", "promptOnly"] as const) {
      if (script[key] !== undefined && typeof script[key] !== "boolean") throw new Error(`${key} 必须为开关`);
    }
    for (const key of ["minDepth", "maxDepth"] as const) {
      const n = script[key];
      if (n != null && (typeof n !== "number" || !Number.isInteger(n) || n < -1 || n > 100000)) throw new Error("正则深度无效");
    }
    if (script.trimStrings !== undefined && (!Array.isArray(script.trimStrings) || script.trimStrings.some((s) => typeof s !== "string"))) throw new Error("裁剪内容必须是字符串数组");
  }
}

function validateWorld(data: unknown): asserts data is Record<string, unknown> {
  if (!object(data) || !object(data.entries)) throw new Error("世界书需要 entries 对象");
  if (Object.keys(data.entries).length > 10000) throw new Error("世界书最多 10000 条");
  for (const entry of Object.values(data.entries)) {
    if (!object(entry) || typeof entry.content !== "string") throw new Error("世界书条目需要文本内容");
    for (const key of ["key", "keysecondary"]) {
      if (entry[key] !== undefined && (!Array.isArray(entry[key]) || (entry[key] as unknown[]).some((k) => typeof k !== "string"))) throw new Error("关键词需要字符串数组");
    }
    for (const key of ["order", "position", "depth", "probability", "sticky", "cooldown", "delay", "groupWeight", "scanDepth"]) {
      const n = entry[key];
      if (n != null && (typeof n !== "number" || !Number.isFinite(n))) throw new Error(`${key} 必须为有限数值`);
    }
    for (const key of ["constant", "disable", "selective", "vectorized", "useProbability", "caseSensitive", "matchWholeWords", "excludeRecursion", "preventRecursion", "groupOverride", "useGroupScoring"]) {
      if (entry[key] != null && typeof entry[key] !== "boolean") throw new Error(`${key} 必须为开关`);
    }
  }
}

export class LibraryStore {
  constructor(private readonly root: string) {}

  list(): LibraryResourceDto[] {
    const result: LibraryResourceDto[] = [{ id: "global-regex:regex.json", kind: "global-regex", label: "全局正则" }];
    for (const kind of ["world", "character-world", "preset-regex", "character-regex"] as const) {
      const dir = path.join(this.root, dirs[kind]);
      if (!fs.existsSync(dir)) continue;
      for (const file of fs.readdirSync(dir).sort()) {
        if (!/\.json$/i.test(file) && !(isCharacter(kind) && /\.png$/i.test(file))) continue;
        if (!fs.lstatSync(path.join(dir, file)).isFile()) continue;
        result.push({ id: `${kind}:${file}`, kind, label: file });
      }
    }
    return result;
  }

  private locate(id: string): { resource: LibraryResourceDto; file: string } {
    const colon = id.indexOf(":");
    const kind = id.slice(0, colon) as LibraryKind;
    const name = id.slice(colon + 1);
    if (!Object.hasOwn(dirs, kind) || !safeFile(name) || (kind === "global-regex" && name !== globalFile) ||
      (kind !== "global-regex" && !/\.json$/i.test(name) && !(isCharacter(kind) && /\.png$/i.test(name)))) throw new Error("资料标识无效");
    const file = path.join(this.root, dirs[kind], name);
    if (fs.existsSync(file) && !fs.lstatSync(file).isFile()) throw new Error("资料不是普通文件");
    return { file, resource: { id, kind, label: kind === "global-regex" ? "全局正则" : name } };
  }

  private source(id: string) {
    const located = this.locate(id);
    const exists = fs.existsSync(located.file);
    if (!exists && located.resource.kind !== "global-regex") throw new Error("资料不存在");
    const buffer = exists ? fs.readFileSync(located.file) : Buffer.from('{"scripts":[]}');
    const raw = /\.png$/i.test(located.file) ? parseCardFromPng(buffer)?.data : JSON.parse(buffer.toString("utf8"));
    if (!object(raw)) throw new Error("资料内容不是对象");
    return { ...located, buffer, raw, exists };
  }

  read(id: string): LibraryDocumentDto {
    const { resource, buffer, raw } = this.source(id);
    return this.document(resource, buffer, raw);
  }

  private document(resource: LibraryResourceDto, buffer: Buffer, raw: Record<string, unknown>): LibraryDocumentDto {
    let data: LibraryDocumentDto["data"];
    if (resource.kind === "world") { validateWorld(raw); data = raw; }
    else if (resource.kind === "character-world") {
      const body = !/\.png$/i.test(resource.label) && object(raw.data) ? raw.data : raw;
      data = body.character_book == null ? { entries: [] } : body.character_book as Record<string, unknown>;
      validateCardBook(data);
    }
    else if (resource.kind === "global-regex") data = (raw.scripts ?? []) as RegexScript[];
    else {
      const body = resource.kind === "character-regex" && !/\.png$/i.test(resource.label) && object(raw.data) ? raw.data : raw;
      data = (object(body.extensions) ? body.extensions.regex_scripts ?? [] : []) as RegexScript[];
    }
    if (resource.kind !== "world" && resource.kind !== "character-world" && !Array.isArray(data)) throw new Error("正则列表不是数组");
    if (resource.kind !== "world" && resource.kind !== "character-world" && (data as unknown[]).some((s) => !object(s) || typeof s.findRegex !== "string" || typeof s.replaceString !== "string" || !Array.isArray(s.placement) ||
      (s.trimStrings != null && (!Array.isArray(s.trimStrings) || s.trimStrings.some((item) => typeof item !== "string"))))) throw new Error("正则脚本结构损坏，请先修正源文件");
    return { resource, revision: hash(buffer), data };
  }

  private backup(file: string, buffer: Buffer): void {
    atomicWrite(path.join(this.root, ".pitavern/editor-backups", hash(path.relative(this.root, file)), `${Date.now()}-${randomUUID()}${path.extname(file)}`), buffer);
  }

  save(id: string, revision: string, data: unknown): LibraryDocumentDto {
    const { file, resource, buffer, raw, exists } = this.source(id);
    if (revision !== hash(buffer)) throw new Error("资料已被其他窗口修改；草稿已保留，请重新载入后合并");
    let output: Buffer | string;
    if (resource.kind === "world") { validateWorld(data); output = JSON.stringify(data, null, 2) + "\n"; }
    else if (resource.kind === "character-world") {
      validateCardBook(data);
      if (/\.png$/i.test(file)) output = rewritePngCard(buffer, (card) => { card.character_book = data; });
      else {
        const body = object(raw.data) ? raw.data : raw;
        body.character_book = data;
        output = JSON.stringify(raw, null, 2) + "\n";
      }
    }
    else {
      validateScripts(data);
      if (/\.png$/i.test(file)) output = rewritePngRegex(buffer, data);
      else {
        if (resource.kind === "global-regex") raw.scripts = data;
        else {
          const body = resource.kind === "character-regex" && object(raw.data) ? raw.data : raw;
          if (body.extensions != null && !object(body.extensions)) throw new Error("extensions 不是对象");
          body.extensions = { ...body.extensions as Record<string, unknown>, regex_scripts: data };
        }
        output = JSON.stringify(raw, null, 2) + "\n";
      }
    }
    if (exists) this.backup(file, buffer);
    atomicWrite(file, output);
    return this.read(id);
  }

  private historyDirectory(id: string): string {
    const { file } = this.locate(id);
    return path.join(this.root, ".pitavern/editor-backups", hash(path.relative(this.root, file)));
  }

  private historySource(id: string, backupId: string) {
    if (!/^\d{13}-[a-f0-9-]{36}\.(json|png)$/i.test(backupId)) throw new Error("历史版本标识无效");
    const file = path.join(this.historyDirectory(id), backupId);
    if (!fs.lstatSync(file).isFile()) throw new Error("历史版本不是普通文件");
    const buffer = fs.readFileSync(file);
    const backup: LibraryHistoryDto = { id: backupId, createdAt: new Date(Number(backupId.slice(0, 13))).toISOString(), bytes: buffer.length, revision: hash(buffer) };
    return { buffer, backup };
  }

  history(id: string, before?: string): LibraryHistoryPageDto {
    const directory = this.historyDirectory(id);
    if (!fs.existsSync(directory)) return { items: [], before: null };
    const names = fs.readdirSync(directory).filter((name) => /^\d{13}-[a-f0-9-]{36}\.(json|png)$/i.test(name) && (!before || name < before)).sort().reverse();
    const items = names.slice(0, 50).map((name) => this.historySource(id, name).backup);
    return { items, before: names.length > 50 ? items.at(-1)!.id : null };
  }

  previewHistory(id: string, backupId: string): LibraryHistoryPreviewDto {
    const { buffer, backup } = this.historySource(id, backupId);
    const { resource } = this.locate(id);
    const raw = /\.png$/i.test(resource.label) ? parseCardFromPng(buffer)?.data : JSON.parse(buffer.toString("utf8"));
    if (!object(raw)) throw new Error("历史版本内容损坏");
    return { backup, document: this.document(resource, buffer, raw) };
  }

  restoreHistory(id: string, backupId: string, revision: string): LibraryDocumentDto {
    const current = this.source(id);
    if (hash(current.buffer) !== revision) throw new Error("资料已被其他窗口修改，请重新载入后再恢复");
    const { buffer } = this.historySource(id, backupId);
    const raw = /\.png$/i.test(current.resource.label) ? parseCardFromPng(buffer)?.data : JSON.parse(buffer.toString("utf8"));
    if (!object(raw)) throw new Error("历史版本内容损坏");
    this.document(current.resource, buffer, raw); // Validate and restore the same bytes.
    if (current.exists) this.backup(current.file, current.buffer);
    atomicWrite(current.file, buffer);
    return this.read(id);
  }

  createWorld(name: string, data: unknown = { entries: {} }): LibraryDocumentDto {
    const fileName = name.trim().replace(/\.json$/i, "") + ".json";
    if (fileName === ".json" || !safeFile(fileName)) throw new Error("请输入有效世界书名称");
    validateWorld(data);
    const { file, resource } = this.locate(`world:${fileName}`);
    if (fs.existsSync(file)) throw new Error("同名世界书已存在，请选择后编辑");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    return this.read(resource.id);
  }

  importWorld(name: string, data: unknown): LibraryDocumentDto {
    const fileName = name.trim().replace(/\.json$/i, "") + ".json";
    const id = `world:${fileName}`;
    const { file } = this.locate(id);
    return fs.existsSync(file) ? this.save(id, this.read(id).revision, data) : this.createWorld(name, data);
  }
}
