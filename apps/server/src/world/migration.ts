import { createHash } from "node:crypto";
import type {
  WorldSnapshot,
  WorldTemplate,
  WorldTemplateChangeDto,
  WorldTemplateChangeEntity,
  WorldTemplateMigrationPreviewDto,
  WorldTemplateMigrationTargetDto,
  WorldTemplateRecord,
} from "@pitavern/shared/world";
import { WORLD_RULES_VERSION, WorldState, createWorldTemplateRecord, parseWorldSnapshot } from "./index.ts";
import { presentActorIds } from "./schema.ts";

export interface MigrationPlanInternal {
  changes: WorldTemplateChangeDto[];
  blocking: WorldTemplateChangeDto[];
  warnings: string[];
  snapshot?: WorldSnapshot;
  applyable: boolean;
  previewHash: string;
}

function target(record: WorldTemplateRecord): WorldTemplateMigrationTargetDto {
  return {
    contentHash: record.contentHash, templateId: record.template.templateId,
    templateVersion: record.template.templateVersion, rulesVersion: record.template.rulesVersion,
    ...(record.name ? { name: record.name } : {}),
  };
}

function hashPlan(from: WorldTemplateRecord, to: WorldTemplateRecord, changes: WorldTemplateChangeDto[], snapshot: WorldSnapshot | undefined): string {
  return createHash("sha256").update(JSON.stringify({
    from: {
      contentHash: from.contentHash, name: from.name ?? "", description: from.description ?? "",
      templateVersion: from.template.templateVersion, rulesVersion: from.template.rulesVersion,
    },
    to: {
      contentHash: to.contentHash, name: to.name ?? "", description: to.description ?? "",
      templateVersion: to.template.templateVersion, rulesVersion: to.template.rulesVersion,
    },
    changes, snapshot,
  })).digest("hex");
}

function addedChange(entity: WorldTemplateChangeEntity, id: string, label: string, detail?: string): WorldTemplateChangeDto {
  return { entity, action: "added", id, label, ...(detail ? { detail } : {}) };
}
function removedChange(entity: WorldTemplateChangeEntity, id: string, label: string, detail?: string): WorldTemplateChangeDto {
  return { entity, action: "removed", id, label, ...(detail ? { detail } : {}), blocking: true };
}
function modifiedChange(entity: WorldTemplateChangeEntity, id: string, label: string, detail: string): WorldTemplateChangeDto {
  return { entity, action: "modified", id, label, detail };
}

type Definition = { id: string; name: string; description?: string };
type ItemDefinition = Definition & { price: number };

function compareDefinitions<T extends Definition>(
  entity: "location" | "actor" | "item",
  from: T[], to: T[],
  changes: WorldTemplateChangeDto[],
  blocking: WorldTemplateChangeDto[],
  detail?: (before: T, after: T) => string,
): void {
  const before = new Map(from.map((entry) => [entry.id, entry]));
  const after = new Map(to.map((entry) => [entry.id, entry]));
  for (const [id, oldEntry] of before) {
    const next = after.get(id);
    if (!next) {
      const change = removedChange(entity, id, oldEntry.name, "目标模板缺少该实体");
      changes.push(change); blocking.push(change);
      continue;
    }
    const beforeValue = JSON.stringify(oldEntry);
    const afterValue = JSON.stringify(next);
    if (beforeValue !== afterValue) changes.push(modifiedChange(entity, id, next.name, detail ? detail(oldEntry, next) : "名称/描述或属性已修改"));
  }
  for (const [id, next] of after) {
    if (!before.has(id)) changes.push(addedChange(entity, id, next.name, "仅加入目录/角色初始状态，不重算历史"));
  }
}

function compareInitial(before: WorldTemplate, after: WorldTemplate, changes: WorldTemplateChangeDto[], blocking: WorldTemplateChangeDto[], warnings: string[]): void {
  if (JSON.stringify(before.initial) === JSON.stringify(after.initial)) return;
  if (before.initial.actorId !== after.initial.actorId) {
    const change = { ...modifiedChange("initial", after.initial.actorId, "初始玩家角色", "初始玩家角色变更首版不支持"), blocking: true };
    changes.push(change); blocking.push(change);
    return;
  }
  changes.push(modifiedChange("initial", after.initial.actorId, "初始状态", "初始金额/位置/库存只影响新聊天，已有世界不重置"));
  warnings.push("初始金额/地点/库存变化只应用于新聊天；当前世界数值保持不变。");
}

/** 比较聊天内嵌模板与目标模板。 */
export function diffWorldTemplateRecords(from: WorldTemplateRecord, to: WorldTemplateRecord): { changes: WorldTemplateChangeDto[]; blocking: WorldTemplateChangeDto[]; warnings: string[] } {
  const changes: WorldTemplateChangeDto[] = [];
  const blocking: WorldTemplateChangeDto[] = [];
  const warnings: string[] = [];
  if (from.template.templateId !== to.template.templateId) {
    const change = { ...modifiedChange("template", to.template.templateId, "模板 ID", from.template.templateId + " → " + to.template.templateId), blocking: true };
    changes.push(change); blocking.push(change);
  }
  if ((from.name ?? "") !== (to.name ?? "") || (from.description ?? "") !== (to.description ?? "")) {
    const descriptionChanged = (from.description ?? "") !== (to.description ?? "");
    changes.push(modifiedChange("template", to.template.templateId, to.name || to.template.templateId,
      "名称/描述：" + (from.name || from.template.templateId) + " → " + (to.name || to.template.templateId)
      + (descriptionChanged ? "；描述已更新" : "")));
  }
  if (from.template.rulesVersion !== to.template.rulesVersion) {
    const supported = to.template.rulesVersion === WORLD_RULES_VERSION;
    const change = { ...modifiedChange("rules", String(to.template.rulesVersion), "规则版本", from.template.rulesVersion + " → " + to.template.rulesVersion), ...(supported ? {} : { blocking: true }) };
    changes.push(change);
    if (!supported) blocking.push(change);
    else warnings.push("规则版本变化已由运行时支持；迁移将使用新规则执行后续命令。");
  }
  compareDefinitions("location", from.template.locations, to.template.locations, changes, blocking);
  compareDefinitions("actor", from.template.actors, to.template.actors, changes, blocking);
  compareDefinitions("item", from.template.items as ItemDefinition[], to.template.items as ItemDefinition[], changes, blocking,
    (before, after) => "固定价格 " + before.price + " → " + after.price + (before.name !== after.name ? "；名称 " + before.name + " → " + after.name : ""));
  compareInitial(from.template, to.template, changes, blocking, warnings);
  return { changes, blocking, warnings };
}

/** 规划单个世界快照的迁移；不写聊天，不调用模型。 */
export function planWorldSnapshotMigration(snapshotInput: unknown, from: WorldTemplateRecord, to: WorldTemplateRecord): MigrationPlanInternal {
  const diff = diffWorldTemplateRecords(from, to);
  const changes = [...diff.changes];
  const blocking = [...diff.blocking];
  const warnings = [...diff.warnings];
  let snapshot: WorldSnapshot | undefined;
  let noOp = false;
  const fail = (detail: string): void => {
    const change = { ...modifiedChange("template", to.template.templateId, "快照迁移", detail), blocking: true };
    changes.push(change); blocking.push(change);
  };
  try {
    const source = parseWorldSnapshot(snapshotInput);
    if (source.templateHash !== from.contentHash) fail("聊天快照引用的模板版本与源记录不一致");
    else {
      // 源记录本身也必须可重建；否则未知/被篡改的旧模板可能绕过目标校验。
      const sourceCheck = createWorldTemplateRecord(from.template, { name: from.name, description: from.description });
      if (sourceCheck.contentHash !== from.contentHash) fail("源模板内容哈希不匹配");
      else {
        // 源世界必须本身可写；未知规则/版本、缺角色、悬空引用都不能靠迁移“修好”。
        const sourceState = new WorldState(source, { [from.contentHash]: from });
        if (sourceState.capability.mode !== "enabled") {
          fail("源世界只读：" + (sourceState.capability.reason ?? "源模板/快照不一致"));
        } else {
          const targetCheck = createWorldTemplateRecord(to.template, { name: to.name, description: to.description });
          if (targetCheck.contentHash !== to.contentHash) fail("目标模板内容哈希不匹配");
          else if (from.contentHash === to.contentHash && diff.changes.length === 0) {
            noOp = true;
            warnings.push("目标版本与当前世界模板相同，无需迁移。");
          } else {
            const next = structuredClone(source);
            next.templateHash = to.contentHash;
            next.templateVersion = to.template.templateVersion;
            next.rulesVersion = to.template.rulesVersion;
            if (from.contentHash !== to.contentHash) {
              // 只补两个模板之间的新角色，避免把源快照里丢失的角色误判为新增。
              const beforeActors = new Set(from.template.actors.map((actor) => actor.id));
              for (const actor of to.template.actors) {
                if (beforeActors.has(actor.id)) continue;
                const locationId = to.template.initial.locationId;
                next.actors[actor.id] = { id: actor.id, locationId, status: "alive" };
                next.money[actor.id] = 0;
                warnings.push("新增角色「" + actor.name + "」以新模板初始地点创建 alive 状态。");
              }
            } else {
              warnings.push("仅更新发布名称/描述/版本元数据，世界数值保持不变。");
            }
            next.scene.presentActorIds = presentActorIds(next.actors, next.scene.locationId);
            const parsed = parseWorldSnapshot(next);
            const table = { [to.contentHash]: to };
            const state = new WorldState(parsed, table);
            if (state.capability.mode !== "enabled") fail("迁移后世界只读：" + (state.capability.reason ?? "模板引用不完整"));
            else snapshot = parsed;
          }
        }
      }
    }
  } catch (error) {
    fail("快照/模板校验失败：" + (error instanceof Error ? error.message : String(error)));
  }
  if (blocking.length) snapshot = undefined;
  return { changes, blocking, warnings, ...(snapshot ? { snapshot } : {}), applyable: !noOp && blocking.length === 0, previewHash: hashPlan(from, to, changes, snapshot) };
}

/** 面向 API 的预览；chatId 由调用方提供，快照数量由聊天层补齐。 */
export function buildMigrationPreview(
  chatId: string, snapshot: unknown, from: WorldTemplateRecord, to: WorldTemplateRecord,
): WorldTemplateMigrationPreviewDto {
  const plan = planWorldSnapshotMigration(snapshot, from, to);
  return {
    chatId, from: target(from), to: target(to), changes: plan.changes, blocking: plan.blocking,
    warnings: plan.warnings, applyable: plan.applyable, snapshotCount: 1, previewHash: plan.previewHash,
    ...(plan.snapshot ? { snapshot: plan.snapshot } : {}),
  };
}