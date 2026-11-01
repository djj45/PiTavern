import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  WorldSnapshot,
  WorldTemplate,
  WorldTemplateEditorDto,
  WorldTemplateExportDto,
  WorldTemplateLibrarySummaryDto,
  WorldTemplateRecord,
  WorldTemplateSummaryDto,
  WorldTemplateVersionDto,
} from "@pitavern/shared/world";
import { atomicWrite } from "../stdata/files.ts";
import { getWorldTemplate, worldTemplateName } from "./catalog.ts";
import { WORLD_RULES_VERSION, createInitialWorldSnapshot, createWorldTemplateRecord } from "./index.ts";

const INDEX_SCHEMA_VERSION = 1 as const;
const MAX_NAME = 100;
const MAX_DESCRIPTION = 500;

interface IndexVersion {
  contentHash: string;
  templateVersion: number;
  rulesVersion: number;
  createdAt: string;
  name: string;
  description?: string;
}

interface IndexEntry {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  draftRevision: number;
  draft: WorldTemplate;
  publishedHash?: string;
  versions: IndexVersion[];
}

interface IndexFile {
  schemaVersion: 1;
  revision: number;
  templates: Record<string, IndexEntry>;
}

export class WorldTemplateNotFoundError extends Error {
  constructor(message = "世界模板不存在") { super(message); this.name = "WorldTemplateNotFoundError"; }
}

export class WorldTemplateConflictError extends Error {
  constructor(message = "模板已被其他窗口修改，请重新载入") { super(message); this.name = "WorldTemplateConflictError"; }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function now(): string { return new Date().toISOString(); }
function cleanName(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_NAME);
}
function cleanDescription(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_DESCRIPTION);
  return text || undefined;
}
function clone<T>(value: T): T { return structuredClone(value); }

/** 0.5.0 模板库：草稿可编辑，发布版本不可变；版本选择只影响新聊天。 */
export class WorldTemplateLibrary {
  private readonly root: string;
  private readonly indexPath: string;
  private readonly versionsDir: string;

  constructor(stDataDir: string) {
    this.root = path.join(stDataDir, ".pitavern", "world-templates");
    this.indexPath = path.join(this.root, "index.json");
    this.versionsDir = path.join(this.root, "versions");
  }

  private emptyIndex(): IndexFile { return { schemaVersion: INDEX_SCHEMA_VERSION, revision: 0, templates: {} }; }

  private readIndex(): IndexFile {
    if (!fs.existsSync(this.indexPath)) return this.emptyIndex();
    let value: unknown;
    try { value = JSON.parse(fs.readFileSync(this.indexPath, "utf8")); }
    catch (error) { throw new Error("世界模板索引损坏：" + (error instanceof Error ? error.message : String(error))); }
    if (!isObject(value) || value.schemaVersion !== INDEX_SCHEMA_VERSION || !Number.isInteger(value.revision) || !isObject(value.templates)) {
      throw new Error("世界模板索引格式无效");
    }
    const templates: Record<string, IndexEntry> = {};
    for (const [id, entry] of Object.entries(value.templates)) {
      if (!isObject(entry) || entry.id !== id || typeof entry.name !== "string" || !Number.isInteger(entry.draftRevision)
        || !isObject(entry.draft) || !Array.isArray(entry.versions) || typeof entry.createdAt !== "string" || typeof entry.updatedAt !== "string") {
        throw new Error("世界模板索引条目无效：" + id);
      }
      templates[id] = entry as unknown as IndexEntry;
    }
    return { schemaVersion: INDEX_SCHEMA_VERSION, revision: value.revision as number, templates };
  }

  private writeIndex(index: IndexFile): void {
    index.revision += 1;
    atomicWrite(this.indexPath, JSON.stringify(index, null, 2) + "\n");
  }

  private versionPath(contentHash: string): string {
    if (!/^[a-f0-9]{64}$/.test(contentHash)) throw new Error("模板版本哈希无效");
    return path.join(this.versionsDir, contentHash + ".json");
  }

  private writeVersion(record: WorldTemplateRecord): void {
    const file = this.versionPath(record.contentHash);
    if (fs.existsSync(file)) {
      const existing = this.readVersion(record.contentHash);
      if (existing.contentHash !== record.contentHash) throw new Error("模板版本文件冲突");
      return;
    }
    fs.mkdirSync(this.versionsDir, { recursive: true });
    const payload: WorldTemplateRecord = {
      contentHash: record.contentHash, template: record.template,
      ...(record.name ? { name: record.name } : {}), ...(record.description ? { description: record.description } : {}),
    };
    fs.writeFileSync(file, JSON.stringify(payload) + "\n", { flag: "wx", mode: 0o600 });
  }

  private readVersion(contentHash: string): WorldTemplateRecord {
    const file = this.versionPath(contentHash);
    if (!fs.existsSync(file)) throw new WorldTemplateNotFoundError("模板版本文件缺失：" + contentHash.slice(0, 12));
    let value: unknown;
    try { value = JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (error) { throw new Error("模板版本文件损坏：" + (error instanceof Error ? error.message : String(error))); }
    if (!isObject(value) || typeof value.contentHash !== "string") throw new Error("模板版本文件格式无效");
    const record = createWorldTemplateRecord(value.template, {
      ...(typeof value.name === "string" ? { name: value.name } : {}),
      ...(typeof value.description === "string" ? { description: value.description } : {}),
    });
    if (record.contentHash !== value.contentHash || record.contentHash !== contentHash) throw new Error("模板版本内容哈希不匹配");
    return record;
  }

  private entrySummary(entry: IndexEntry): WorldTemplateLibrarySummaryDto {
    const publishedVersion = entry.publishedHash ? entry.versions.find((version) => version.contentHash === entry.publishedHash) : undefined;
    let draftDirty = true;
    try { draftDirty = entry.publishedHash !== createWorldTemplateRecord(entry.draft).contentHash; }
    catch { draftDirty = true; }
    return {
      id: entry.id, name: entry.name, ...(entry.description ? { description: entry.description } : {}),
      createdAt: entry.createdAt, updatedAt: entry.updatedAt, draftRevision: entry.draftRevision,
      ...(entry.publishedHash ? { publishedHash: entry.publishedHash } : {}),
      ...(publishedVersion ? { publishedVersion: publishedVersion.templateVersion } : {}),
      versionCount: entry.versions.length, draftDirty,
    };
  }

  private editor(entry: IndexEntry): WorldTemplateEditorDto {
    const summary = this.entrySummary(entry);
    const published = entry.publishedHash ? this.readVersion(entry.publishedHash) : undefined;
    const initial = createInitialWorldSnapshot(createWorldTemplateRecord(entry.draft, { name: entry.name, description: entry.description }));
    return {
      ...summary, draft: clone(entry.draft), ...(published ? { published } : {}),
      versions: this.versionDtos(entry), initialSnapshot: initial,
    };
  }

  private versionDtos(entry: IndexEntry): WorldTemplateVersionDto[] {
    return [...entry.versions].sort((a, b) => b.templateVersion - a.templateVersion).map((version) => ({
      contentHash: version.contentHash, templateVersion: version.templateVersion, rulesVersion: version.rulesVersion,
      createdAt: version.createdAt, name: version.name, ...(version.description ? { description: version.description } : {}),
    }));
  }

  private uniqueId(existing: Set<string>): string {
    for (let attempt = 0; attempt < 100; attempt++) {
      const id = "custom-" + randomUUID().slice(0, 12);
      if (!existing.has(id)) return id;
    }
    throw new Error("无法生成唯一模板 ID");
  }

  private addEntry(index: IndexFile, template: WorldTemplate, nameInput: unknown, descriptionInput: unknown, options: { preserveId?: boolean } = {}): IndexEntry {
    const name = cleanName(nameInput) || "未命名模板";
    const description = cleanDescription(descriptionInput);
    const existing = new Set(Object.keys(index.templates));
    const keepId = options.preserveId && typeof template.templateId === "string"
      && template.templateId.trim().length > 0 && !existing.has(template.templateId);
    const id = keepId ? template.templateId : this.uniqueId(existing);
    const next = clone(template);
    next.templateId = id;
    next.rulesVersion = WORLD_RULES_VERSION;
    const record = createWorldTemplateRecord(next, { name, ...(description ? { description } : {}) });
    const createdAt = now();
    const entry: IndexEntry = {
      id, name, ...(description ? { description } : {}), createdAt, updatedAt: createdAt,
      draftRevision: 1, draft: clone(record.template), versions: [],
    };
    index.templates[id] = entry;
    return entry;
  }

  list(): WorldTemplateLibrarySummaryDto[] {
    const index = this.readIndex();
    return Object.values(index.templates).map((entry) => this.entrySummary(entry)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  get(id: string): WorldTemplateEditorDto {
    const entry = this.readIndex().templates[id];
    if (!entry) throw new WorldTemplateNotFoundError();
    return this.editor(entry);
  }

  createBlank(nameInput: unknown, descriptionInput: unknown): WorldTemplateEditorDto {
    const index = this.readIndex();
    const template: WorldTemplate = {
      schemaVersion: 1, templateId: "", templateVersion: 1, rulesVersion: WORLD_RULES_VERSION,
      locations: [{ id: "start", name: "起点" }],
      actors: [{ id: "player", name: "旅人" }],
      items: [],
      initial: { actorId: "player", locationId: "start", money: 0, inventory: [] },
    };
    const entry = this.addEntry(index, template, nameInput, descriptionInput);
    this.writeIndex(index);
    return this.editor(entry);
  }

  copyBuiltIn(sourceId: string, nameInput: unknown, descriptionInput: unknown): WorldTemplateEditorDto {
    const source = getWorldTemplate(sourceId);
    if (!source) throw new WorldTemplateNotFoundError("内置世界模板不存在：" + sourceId);
    const index = this.readIndex();
    const template = clone(source);
    template.templateId = "";
    template.templateVersion = 1;
    template.rulesVersion = WORLD_RULES_VERSION;
    const entry = this.addEntry(index, template, cleanName(nameInput) || worldTemplateName(sourceId) + " 副本", descriptionInput ?? undefined);
    this.writeIndex(index);
    return this.editor(entry);
  }

  importTemplate(input: unknown): WorldTemplateEditorDto {
    if (!isObject(input) || input.format !== "pitavern-world-template" || input.version !== 1 || !isObject(input.template)) {
      throw new Error("模板导入格式无效；需要 format=pitavern-world-template，version=1");
    }
    const template = clone(input.template) as unknown as WorldTemplate;
    const index = this.readIndex();
    const entry = this.addEntry(index, template, input.name, input.description, { preserveId: true });
    this.writeIndex(index);
    return this.editor(entry);
  }

  saveDraft(id: string, expectedRevision: number, input: { name?: unknown; description?: unknown; template?: unknown }): WorldTemplateEditorDto {
    const index = this.readIndex();
    const entry = index.templates[id];
    if (!entry) throw new WorldTemplateNotFoundError();
    if (!Number.isInteger(expectedRevision) || entry.draftRevision !== expectedRevision) throw new WorldTemplateConflictError();
    if (!isObject(input.template)) throw new Error("缺少世界模板内容");
    const template = clone(input.template) as unknown as WorldTemplate;
    if (template.templateId !== id) throw new Error("模板 ID 不能修改");
    template.rulesVersion = WORLD_RULES_VERSION;
    const name = cleanName(input.name);
    if (!name) throw new Error("模板名称不能为空");
    const description = cleanDescription(input.description);
    const record = createWorldTemplateRecord(template, { name, ...(description ? { description } : {}) });
    entry.name = name;
    if (description) entry.description = description; else delete entry.description;
    entry.draft = clone(record.template);
    entry.draftRevision += 1;
    entry.updatedAt = now();
    this.writeIndex(index);
    return this.editor(entry);
  }

  publish(id: string, expectedRevision: number): WorldTemplateEditorDto {
    const index = this.readIndex();
    const entry = index.templates[id];
    if (!entry) throw new WorldTemplateNotFoundError();
    if (!Number.isInteger(expectedRevision) || entry.draftRevision !== expectedRevision) throw new WorldTemplateConflictError();
    const draftRecord = createWorldTemplateRecord(entry.draft, { name: entry.name, ...(entry.description ? { description: entry.description } : {}) });
    if (entry.publishedHash === draftRecord.contentHash) return this.editor(entry);
    const nextVersion = entry.versions.reduce((max, version) => Math.max(max, version.templateVersion), 0) + 1;
    const template = clone(entry.draft);
    template.templateVersion = nextVersion;
    template.rulesVersion = WORLD_RULES_VERSION;
    const record = createWorldTemplateRecord(template, { name: entry.name, ...(entry.description ? { description: entry.description } : {}) });
    if (entry.versions.some((version) => version.contentHash === record.contentHash)) throw new Error("模板版本哈希重复");
    this.writeVersion(record);
    const createdAt = now();
    entry.versions.push({
      contentHash: record.contentHash, templateVersion: nextVersion, rulesVersion: WORLD_RULES_VERSION,
      createdAt, name: entry.name, ...(entry.description ? { description: entry.description } : {}),
    });
    entry.publishedHash = record.contentHash;
    entry.draft = clone(record.template);
    entry.draftRevision += 1;
    entry.updatedAt = createdAt;
    this.writeIndex(index);
    return this.editor(entry);
  }

  delete(id: string): void {
    const index = this.readIndex();
    if (!index.templates[id]) throw new WorldTemplateNotFoundError();
    delete index.templates[id];
    this.writeIndex(index);
  }

  versions(id: string): WorldTemplateVersionDto[] {
    const entry = this.readIndex().templates[id];
    if (!entry) throw new WorldTemplateNotFoundError();
    return this.versionDtos(entry);
  }

  resolvePublished(id: string, contentHash?: string): WorldTemplateRecord {
    const entry = this.readIndex().templates[id];
    if (!entry) throw new WorldTemplateNotFoundError();
    const hash = contentHash ?? entry.publishedHash;
    if (!hash) throw new WorldTemplateNotFoundError("模板尚未发布");
    const record = this.readVersion(hash);
    if (record.template.templateId !== id) throw new Error("模板版本与模板 ID 不匹配");
    return record;
  }

  /** 按不可变版本哈希读取，供新聊天选择精确版本。 */
  resolveHash(contentHash: string): WorldTemplateRecord {
    return this.readVersion(contentHash);
  }

  latestSummaries(): WorldTemplateSummaryDto[] {
    const index = this.readIndex();
    const summaries: WorldTemplateSummaryDto[] = [];
    for (const entry of Object.values(index.templates)) {
      if (!entry.publishedHash) continue;
      const record = this.readVersion(entry.publishedHash);
      const version = entry.versions.find((item) => item.contentHash === entry.publishedHash);
      summaries.push({
        id: entry.id, name: entry.name, ...(entry.description ? { description: entry.description } : {}),
        templateVersion: version?.templateVersion ?? record.template.templateVersion,
        rulesVersion: record.template.rulesVersion, contentHash: record.contentHash,
        locations: record.template.locations.length, actors: record.template.actors.length, items: record.template.items.length,
        source: "library",
      });
    }
    return summaries.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  }

  exportTemplate(id: string): WorldTemplateExportDto {
    const entry = this.readIndex().templates[id];
    if (!entry) throw new WorldTemplateNotFoundError();
    return {
      format: "pitavern-world-template", version: 1, name: entry.name,
      ...(entry.description ? { description: entry.description } : {}), template: clone(entry.draft),
    };
  }
}
