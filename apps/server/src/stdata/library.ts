import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { LibraryDocumentDto, LibraryKind, LibraryResourceDto } from "@pitavern/shared";
import { normalizeRegexScripts, parseFindRegex, type RegexScript } from "@pitavern/shared/regex";
import { atomicWrite, object } from "./files.ts";
import { parseCardFromPng, rewritePngRegex } from "./png.ts";

const hash = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const dirs = { world: "worlds", "preset-regex": "OpenAI Settings", "character-regex": "characters", "global-regex": ".pitavern" };
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
    for (const kind of ["world", "preset-regex", "character-regex"] as const) {
      const dir = path.join(this.root, dirs[kind]);
      if (!fs.existsSync(dir)) continue;
      for (const file of fs.readdirSync(dir).sort()) {
        if (!/\.json$/i.test(file) && !(kind === "character-regex" && /\.png$/i.test(file))) continue;
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
      (kind !== "global-regex" && !/\.json$/i.test(name) && !(kind === "character-regex" && /\.png$/i.test(name)))) throw new Error("资料标识无效");
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
    let data: LibraryDocumentDto["data"];
    if (resource.kind === "world") { validateWorld(raw); data = raw; }
    else if (resource.kind === "global-regex") data = (raw.scripts ?? []) as RegexScript[];
    else {
      const body = resource.kind === "character-regex" && !/\.png$/i.test(resource.label) && object(raw.data) ? raw.data : raw;
      data = (object(body.extensions) ? body.extensions.regex_scripts ?? [] : []) as RegexScript[];
    }
    if (resource.kind !== "world" && !Array.isArray(data)) throw new Error("正则列表不是数组");
    if (resource.kind !== "world" && (data as unknown[]).some((s) => !object(s) || typeof s.findRegex !== "string" || typeof s.replaceString !== "string" || !Array.isArray(s.placement) ||
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
