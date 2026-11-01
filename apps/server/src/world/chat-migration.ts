import { createHash } from "node:crypto";
import type {
  WorldChatMigrationCountsDto,
  WorldChatMigrationLocationDto,
  WorldChatMigrationLocationKind,
  WorldChatMigrationLocationStatus,
  WorldSnapshot,
  WorldTemplateChangeDto,
  WorldTemplateRecord,
} from "@pitavern/shared/world";
import { WORLD_STATE_KEY, WORLD_TEMPLATES_KEY } from "@pitavern/shared/world";
import { parseChatSource } from "../stdata/replies.ts";
import type { StChatLine } from "../stdata/types.ts";
import { migrationTarget, planWorldSnapshotMigration } from "./migration.ts";

const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_DEPTH = 64;
const MAX_NODES = 50_000;
const MAX_LOCATIONS = 5_000;

export class WorldChatMigrationLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorldChatMigrationLimitError";
  }
}

export interface ChatWorldMigrationPlan {
  sourceHash: string;
  target: WorldTemplateRecord;
  locations: WorldChatMigrationLocationDto[];
  counts: WorldChatMigrationCountsDto;
  blocking: WorldChatMigrationLocationDto[];
  warnings: string[];
  applyable: boolean;
  noop: boolean;
  hasWorld: boolean;
  previewHash: string;
  nextSource?: string;
}

type JsonRecord = Record<string, unknown>;

function object(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function recordFrom(table: JsonRecord | undefined, contentHash: string): WorldTemplateRecord | undefined {
  const value = table?.[contentHash];
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Partial<WorldTemplateRecord>;
  if (typeof record.contentHash !== "string" || !record.template || typeof record.template !== "object") return undefined;
  return record as WorldTemplateRecord;
}

function blockingChange(detail: string, label = "源模板"): WorldTemplateChangeDto {
  return { entity: "template", action: "modified", label, detail, blocking: true };
}

function sourceHashOf(snapshot: JsonRecord): string {
  return typeof snapshot.templateHash === "string" ? snapshot.templateHash : "unknown";
}

export function planChatWorldMigration(source: string, target: WorldTemplateRecord): ChatWorldMigrationPlan {
  if (Buffer.byteLength(source, "utf8") > MAX_SOURCE_BYTES) {
    throw new WorldChatMigrationLimitError("聊天文件超过 64 MiB，不能生成整份迁移计划");
  }
  const parsed = parseChatSource(source);
  const header = parsed.header;
  const metadata = object(header.chat_metadata) ?? {};
  const headerTable = object(metadata[WORLD_TEMPLATES_KEY]);
  const headerTableMutable: JsonRecord = headerTable ?? {};
  const locations: WorldChatMigrationLocationDto[] = [];
  const warnings: string[] = [];
  const seenStates = new WeakSet<object>();
  const seenLines = new WeakSet<object>();
  let nodes = 0;
  let turns = 0;
  let migrated = 0;
  let unchanged = 0;
  let blocked = 0;
  let noWorld = 0;
  let headerDirty = false;
  let targetTableUpdated = false;
  const targetDto = migrationTarget(target);

  const bumpNode = (depth: number): void => {
    if (depth > MAX_DEPTH) throw new WorldChatMigrationLimitError("聊天分支嵌套超过 64 层，不能生成整份迁移计划");
    nodes += 1;
    if (nodes > MAX_NODES) throw new WorldChatMigrationLimitError("聊天分支节点超过 50000 个，不能生成整份迁移计划");
  };

  const updateTargetTable = (localTable: JsonRecord | undefined): void => {
    // 头部表是聊天的权威表；局部表（旧/导入结构）若原本有源记录也同步更新。
    headerTableMutable[target.contentHash] = target;
    if (!targetTableUpdated) {
      metadata[WORLD_TEMPLATES_KEY] = headerTableMutable;
      headerDirty = true;
      targetTableUpdated = true;
    }
    if (localTable && localTable !== headerTableMutable) localTable[target.contentHash] = target;
  };

  const visitState = (
    container: JsonRecord,
    path: string,
    kind: WorldChatMigrationLocationKind,
    label: string,
    depth: number,
    markDirty: () => void,
  ): void => {
    bumpNode(depth);
    if (seenStates.has(container)) return;
    seenStates.add(container);
    if (!Object.hasOwn(container, WORLD_STATE_KEY)) {
      noWorld += 1;
      return;
    }
    if (locations.length >= MAX_LOCATIONS) {
      throw new WorldChatMigrationLimitError("聊天世界恢复点超过 5000 个，不能生成整份迁移计划");
    }
    const snapshot = object(container[WORLD_STATE_KEY]);
    if (!snapshot) {
      const change = blockingChange("世界快照不是对象", "世界快照");
      locations.push({
        path, kind, label, sourceHash: "unknown", sourceTemplateVersion: 0, sourceRulesVersion: 0,
        target: targetDto, status: "blocked", changes: [], blocking: [change], warnings: [],
      });
      blocked += 1;
      return;
    }
    const sourceHash = sourceHashOf(snapshot);
    const localTable = object(container[WORLD_TEMPLATES_KEY]);
    const sourceRecord = recordFrom(localTable, sourceHash) ?? recordFrom(headerTableMutable, sourceHash);
    if (!sourceRecord) {
      const change = blockingChange("聊天快照引用的源模板记录不存在", "源模板缺失");
      locations.push({
        path, kind, label, sourceHash,
        sourceTemplateVersion: typeof snapshot.templateVersion === "number" ? snapshot.templateVersion : 0,
        sourceRulesVersion: typeof snapshot.rulesVersion === "number" ? snapshot.rulesVersion : 0,
        target: targetDto, status: "blocked", changes: [], blocking: [change], warnings: [],
      });
      blocked += 1;
      return;
    }
    const sourceVersion = sourceRecord.template.templateVersion;
    const sourceRules = sourceRecord.template.rulesVersion;
    let plan;
    try {
      plan = planWorldSnapshotMigration(snapshot, sourceRecord, target);
    } catch (error) {
      const change = blockingChange("迁移规划异常：" + (error instanceof Error ? error.message : String(error)), "迁移规划");
      locations.push({
        path, kind, label, sourceHash, sourceName: sourceRecord.name, sourceDescription: sourceRecord.description,
        sourceTemplateVersion: sourceVersion, sourceRulesVersion: sourceRules,
        target: targetDto, status: "blocked", changes: [], blocking: [change], warnings: [],
      });
      blocked += 1;
      return;
    }
    if (plan.applyable && plan.snapshot) {
      container[WORLD_STATE_KEY] = plan.snapshot;
      markDirty();
      updateTargetTable(localTable);
      migrated += 1;
      locations.push({
        path, kind, label, sourceHash, sourceName: sourceRecord.name, sourceDescription: sourceRecord.description,
        sourceTemplateVersion: sourceVersion, sourceRulesVersion: sourceRules,
        target: targetDto, status: "migrated", changes: plan.changes, blocking: [], warnings: plan.warnings,
      });
      for (const warning of plan.warnings) if (!warnings.includes(warning)) warnings.push(warning);
      return;
    }
    if (plan.blocking.length) {
      blocked += 1;
      locations.push({
        path, kind, label, sourceHash, sourceName: sourceRecord.name, sourceDescription: sourceRecord.description,
        sourceTemplateVersion: sourceVersion, sourceRulesVersion: sourceRules,
        target: targetDto, status: "blocked", changes: plan.changes, blocking: plan.blocking, warnings: plan.warnings,
      });
      return;
    }
    // 合法 no-op：内容与元数据都没有变化。
    unchanged += 1;
    locations.push({
      path, kind, label, sourceHash, sourceName: sourceRecord.name, sourceDescription: sourceRecord.description,
      sourceTemplateVersion: sourceVersion, sourceRulesVersion: sourceRules,
      target: targetDto, status: "unchanged", changes: plan.changes, blocking: [], warnings: plan.warnings,
    });
  };

  const continuationLine = (raw: unknown): StChatLine | undefined => {
    if (typeof raw !== "string") return undefined;
    try {
      const value = JSON.parse(raw);
      return value && typeof value === "object" && typeof value.mes === "string" && typeof value.name === "string"
        ? value as StChatLine : undefined;
    } catch {
      return undefined;
    }
  };

  const processExtra = (extra: JsonRecord, path: string, label: string, depth: number, markDirty: () => void, kind: WorldChatMigrationLocationKind): void => {
    bumpNode(depth);
    if (Object.hasOwn(extra, WORLD_STATE_KEY)) visitState(extra, path + ".extra", kind, label + " · 状态", depth + 1, markDirty);
    const before = object(extra._pitavernBeforeTurn);
    const beforeMetadata = object(before?.metadata);
    if (beforeMetadata) {
      visitState(beforeMetadata, path + ".extra._pitavernBeforeTurn.metadata", kind, label + " · 回合前", depth + 1, markDirty);
    }
    const catalog = object(extra._pitavernReplies);
    if (!catalog || !Array.isArray(catalog.versions)) return;
    catalog.versions.forEach((entry, index) => {
      const version = object(entry);
      if (!version) return;
      bumpNode(depth + 1);
      const state = object(version.state);
      const stateKind: WorldChatMigrationLocationKind = kind === "native" ? "native" : kind === "continuation" ? "continuation" : "candidate";
      if (state) visitState(state, path + ".extra._pitavernReplies.versions[" + index + "].state", stateKind, label + " · 候选 " + (index + 1), depth + 2, markDirty);
      if (Array.isArray(version.messages)) {
        version.messages.forEach((message, messageIndex) => {
          const nested = object(message) as StChatLine | undefined;
          if (nested && typeof nested.mes === "string") {
            processMessage(nested, path + ".extra._pitavernReplies.versions[" + index + "].messages[" + messageIndex + "]", "candidate", label + " · 候选 " + (index + 1), depth + 2, markDirty);
          }
        });
      }
      const continuation = version.continuation;
      if (Array.isArray(continuation)) {
        continuation.forEach((raw, continuationIndex) => {
          const nested = continuationLine(raw);
          if (!nested) return;
          const before = JSON.stringify(nested);
          processMessage(nested, path + ".extra._pitavernReplies.versions[" + index + "].continuation[" + continuationIndex + "]", "continuation", label + " · 隐藏后续", depth + 2, markDirty);
          if (JSON.stringify(nested) !== before) {
            continuation[continuationIndex] = JSON.stringify(nested);
            markDirty();
          }
        });
      }
    });
  };

  const processMessage = (line: StChatLine, path: string, kind: WorldChatMigrationLocationKind, label: string, depth: number, markDirty: () => void): void => {
    bumpNode(depth);
    if (seenLines.has(line)) return;
    seenLines.add(line);
    const extra = object(line.extra);
    if (extra) processExtra(extra, path, label, depth, markDirty, kind);
    if (Array.isArray(line.swipe_info)) {
      line.swipe_info.forEach((entry, index) => {
        const info = object(entry);
        const swipeExtra = object(info?.extra);
        if (!swipeExtra) return;
        processExtra(swipeExtra, path + ".swipe_info[" + index + "]", label + " · 原生候选 " + (index + 1), depth + 1, markDirty, "native");
      });
    }
  };

  visitState(metadata, "header.chat_metadata", "active", "活动世界", 0, () => { headerDirty = true; });

  for (const record of parsed.records) {
    if (record.line.is_user && !record.line.is_system && record.line.mes.trim()) turns += 1;
    // 记录级脏标记在重建时通过 JSON.stringify 对比完成；这里只保证对象被就地修改。
    processMessage(record.line, "message[" + record.rawIndex + "]", "checkpoint", "第 " + Math.max(1, turns) + " 轮", 0, () => {});
  }

  const counts: WorldChatMigrationCountsDto = {
    worlds: locations.length, migrated, unchanged, blocked, noWorld,
  };
  const blockingLocations = locations.filter((location) => location.status === "blocked");
  const hasWorld = locations.length > 0;
  const applyable = hasWorld && blockingLocations.length === 0 && migrated > 0;
  const noop = hasWorld && blockingLocations.length === 0 && migrated === 0;
  const previewHash = createHash("sha256").update(JSON.stringify({
    sourceHash: createHash("sha256").update(source).digest("hex"),
    target: targetDto,
    locations, counts,
  })).digest("hex");

  let nextSource: string | undefined;
  if (applyable) {
    const raw = [...parsed.raw];
    const offset = parsed.hasHeader ? 0 : 1;
    if (headerDirty || !parsed.hasHeader) {
      if (parsed.hasHeader) raw[0] = JSON.stringify(header);
      else raw.unshift(JSON.stringify(header));
    }
    for (const record of parsed.records) {
      const serialized = JSON.stringify(record.line);
      if (raw[record.rawIndex + offset] !== serialized) raw[record.rawIndex + offset] = serialized;
    }
    nextSource = raw.join("\n");
    if (nextSource === source) nextSource = undefined;
  }

  return {
    sourceHash: createHash("sha256").update(source).digest("hex"),
    target, locations, counts, blocking: blockingLocations, warnings,
    applyable, noop, hasWorld, previewHash,
    ...(nextSource ? { nextSource } : {}),
  };
}
