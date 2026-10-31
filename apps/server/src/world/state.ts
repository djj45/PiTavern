import {
  WORLD_SCHEMA_VERSION, type WorldEngineCapability, type WorldSnapshot, type WorldTemplate, type WorldTemplateRecord,
} from "@pitavern/shared/world";
import { worldContentHash } from "./hash.ts";
import { parseWorldSnapshot, parseWorldTemplate, presentActorIds, validateWorldReferences, WorldValidationError } from "./schema.ts";

export const WORLD_RULES_VERSION = 1;

export function createWorldTemplateRecord(input: unknown): WorldTemplateRecord {
  const template = parseWorldTemplate(input);
  return { contentHash: worldContentHash(template), template };
}

export function createInitialWorldSnapshot(input: WorldTemplateRecord): WorldSnapshot {
  const record = createWorldTemplateRecord(input.template);
  if (record.contentHash !== input.contentHash) throw new WorldValidationError("模板内容哈希不匹配");
  const template = record.template;
  if (template.rulesVersion !== WORLD_RULES_VERSION) throw new WorldValidationError("无法使用未知规则版本初始化世界");
  const actors = Object.fromEntries(template.actors.map((entry) => [entry.id, {
    id: entry.id, locationId: template.initial.locationId, status: "alive" as const,
  }]));
  return {
    schemaVersion: WORLD_SCHEMA_VERSION, revision: 0,
    templateHash: record.contentHash, templateVersion: template.templateVersion, rulesVersion: template.rulesVersion,
    clockMinutes: 0,
    scene: { locationId: template.initial.locationId, presentActorIds: presentActorIds(actors, template.initial.locationId) },
    actors, money: Object.fromEntries(template.actors.map((entry) => [entry.id, entry.id === template.initial.actorId ? template.initial.money : 0])),
    inventory: structuredClone(template.initial.inventory), recentEvents: [],
  };
}

/** 不读写存档。输入和读取结果均深拷贝，事务/分支不能共享可变对象。 */
export class WorldState {
  private readonly current: WorldSnapshot;
  private definition?: WorldTemplate;
  private readonly access: WorldEngineCapability;

  constructor(snapshot: unknown, templates: unknown, capability: WorldEngineCapability = { mode: "enabled" }) {
    this.current = parseWorldSnapshot(snapshot);
    this.access = this.resolve(templates) ?? structuredClone(capability);
    if (capability.mode === "disabled") this.access = structuredClone(capability);
  }

  private resolve(templates: unknown): WorldEngineCapability | undefined {
    const snapshot = this.current;
    if (!templates || typeof templates !== "object" || !Object.hasOwn(templates, snapshot.templateHash)) {
      return { mode: "read-only", reason: "世界模板记录缺失" };
    }
    const record: unknown = (templates as Record<string, unknown>)[snapshot.templateHash];
    if (!record || typeof record !== "object" || (record as WorldTemplateRecord).contentHash !== snapshot.templateHash) {
      return { mode: "read-only", reason: "世界模板记录哈希不匹配" };
    }
    try {
      const verified = createWorldTemplateRecord((record as WorldTemplateRecord).template);
      if (verified.contentHash !== snapshot.templateHash) return { mode: "read-only", reason: "世界模板内容哈希不匹配" };
      if (verified.template.templateVersion !== snapshot.templateVersion || verified.template.rulesVersion !== snapshot.rulesVersion) {
        return { mode: "read-only", reason: "世界快照与模板版本不匹配" };
      }
      if (snapshot.rulesVersion !== WORLD_RULES_VERSION) return { mode: "read-only", reason: "未知世界规则版本" };
      validateWorldReferences(snapshot, verified.template);
      this.definition = verified.template;
      return undefined;
    } catch (error) {
      if (!(error instanceof WorldValidationError)) throw error;
      return { mode: "read-only", reason: error.message };
    }
  }

  get snapshot(): WorldSnapshot { return structuredClone(this.current); }
  get template(): WorldTemplate | undefined { return this.definition && structuredClone(this.definition); }
  get capability(): WorldEngineCapability { return structuredClone(this.access); }
}
