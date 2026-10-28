import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { ChatActivityDto, GenerationPageDto, GenerationRecordDto, GenerationUsageDto } from "@pitavern/shared";

export const emptyUsage = (): GenerationUsageDto => ({
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costTotal: 0, responses: 0, responsesWithUsage: 0,
});

interface Index {
  names: string[];
  revision: number;
  usage: GenerationUsageDto;
  toolCounts: Record<string, number>;
  recent: Map<string, GenerationRecordDto>;
}

/** Separate from chat revisions: changing a reply or restoring a backup cannot undo incurred usage. */
export class ActivityStore {
  private readonly indexes = new Map<string, Index>();
  constructor(private readonly stDataDir: string) {}

  createId(chatId: string): string {
    const last = Number(this.index(chatId).names[0]?.split("-")[0] ?? 0);
    return `${Math.max(Date.now(), last + 1)}-${randomUUID()}`;
  }

  private dir(chatId: string): string {
    return path.join(this.stDataDir, ".pitavern", "activity", createHash("sha256").update(chatId).digest("hex"));
  }

  private write(chatId: string, record: GenerationRecordDto): void {
    const dir = this.dir(chatId);
    fs.mkdirSync(dir, { recursive: true });
    const destination = path.join(dir, record.id + ".json");
    const temporary = destination + "." + randomUUID() + ".tmp";
    try {
      fs.writeFileSync(temporary, JSON.stringify(record), { flag: "wx", mode: 0o600 });
      fs.renameSync(temporary, destination);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }

  private read(chatId: string, id: string): GenerationRecordDto {
    const value = JSON.parse(fs.readFileSync(path.join(this.dir(chatId), id + ".json"), "utf8")) as GenerationRecordDto;
    if (value.id !== id || !Number.isInteger(value.version) || !value.usage || !Array.isArray(value.tools)) {
      throw new Error("生成记录格式损坏：" + id);
    }
    return value;
  }

  private account(index: Index, record: GenerationRecordDto, sign: 1 | -1): void {
    index.revision += sign * record.version;
    for (const key of Object.keys(index.usage) as (keyof GenerationUsageDto)[]) index.usage[key] += sign * record.usage[key];
    for (const tool of record.tools) {
      index.toolCounts[tool.toolName] = (index.toolCounts[tool.toolName] ?? 0) + sign;
      if (!index.toolCounts[tool.toolName]) delete index.toolCounts[tool.toolName];
    }
  }

  private index(chatId: string): Index {
    const cached = this.indexes.get(chatId);
    if (cached) return cached;
    const dir = this.dir(chatId);
    const names = fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => /^\d{13}-[\da-f-]+\.json$/.test(name))
      .map((name) => name.slice(0, -5)).sort().reverse() : [];
    const index: Index = { names, revision: 0, usage: emptyUsage(), toolCounts: Object.create(null), recent: new Map() };
    for (const id of names) {
      const record = this.read(chatId, id);
      if (record.status === "running") {
        record.status = "interrupted";
        record.finishedAt = new Date().toISOString();
        record.error = "服务重启，上一轮未正常结束；已保留收到的用量和工具记录";
        record.version++;
        for (const tool of record.tools) if (tool.status === "running") {
          tool.status = "error";
          tool.summary = "服务中断";
        }
        this.write(chatId, record);
      }
      this.account(index, record, 1);
      if (index.recent.size < 20) index.recent.set(id, record);
    }
    this.indexes.set(chatId, index);
    return index;
  }

  save(chatId: string, record: GenerationRecordDto): void {
    const index = this.index(chatId);
    const previous = index.recent.get(record.id) ?? (index.names.includes(record.id) ? this.read(chatId, record.id) : undefined);
    const next = structuredClone({ ...record, version: (previous?.version ?? 0) + 1 });
    this.write(chatId, next);
    if (previous) this.account(index, previous, -1);
    else { index.names.push(next.id); index.names.sort().reverse(); }
    this.account(index, next, 1);
    index.recent.set(next.id, next);
    for (const id of index.recent.keys()) if (!index.names.slice(0, 20).includes(id)) index.recent.delete(id);
    record.version = next.version;
  }

  page(chatId: string, before?: string, limit = 20): GenerationPageDto {
    const index = this.index(chatId);
    if (before && !index.names.includes(before)) throw new Error("生成记录分页位置无效");
    const names = before ? index.names.filter((id) => id < before) : index.names;
    const batch = names.slice(0, limit);
    return { records: batch.map((id) => structuredClone(index.recent.get(id) ?? this.read(chatId, id))),
      before: names.length > batch.length ? batch.at(-1)! : null };
  }

  snapshot(chatId: string, turns: number): ChatActivityDto {
    const index = this.index(chatId);
    return { ...this.page(chatId, undefined, 5), revision: index.revision, turns,
      totalGenerations: index.names.length, usage: { ...index.usage }, toolCounts: { ...index.toolCounts } };
  }
}
