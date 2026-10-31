import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";
import {
  WORLD_MAX_CLOCK_MINUTES, WORLD_MAX_ITEM_QUANTITY, WORLD_MAX_MONEY, WORLD_MAX_RECENT_EVENTS,
  WORLD_SCHEMA_VERSION, type WorldActorState, type WorldCommand, type WorldSnapshot, type WorldTemplate,
} from "@pitavern/shared/world";

const strict = { additionalProperties: false };
const id = Type.String({ minLength: 1, maxLength: 128, pattern: "^[^\\s\\u0000-\\u001f]+$" });
const hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
const integer = (maximum = Number.MAX_SAFE_INTEGER, minimum = 0) => Type.Integer({ minimum, maximum });
const money = integer(WORLD_MAX_MONEY);
const quantity = integer(WORLD_MAX_ITEM_QUANTITY, 1);
const clock = integer(WORLD_MAX_CLOCK_MINUTES);
const definition = { id, name: Type.String({ minLength: 1 }), description: Type.Optional(Type.String()) };
const inventoryEntry = Type.Object({ ownerId: id, itemId: id, quantity }, strict);
const actor = Type.Object({ id, locationId: id, status: Type.Union([
  Type.Literal("alive"), Type.Literal("dead"), Type.Literal("inactive"),
]) }, strict);
const event = Type.Object({
  id, commandId: id, turn: integer(),
  type: Type.Union([Type.Literal("move"), Type.Literal("purchase"), Type.Literal("transfer"), Type.Literal("advance_time")]),
  actorId: Type.Optional(id), targetId: Type.Optional(id), itemId: Type.Optional(id),
  quantity: Type.Optional(quantity), moneyDelta: Type.Optional(integer(WORLD_MAX_MONEY, -WORLD_MAX_MONEY)),
  worldTimeMinutes: clock, summary: Type.String(),
}, strict);

export const WorldTemplateSchema = Type.Object({
  schemaVersion: Type.Literal(WORLD_SCHEMA_VERSION), templateId: id,
  templateVersion: integer(Number.MAX_SAFE_INTEGER, 1), rulesVersion: integer(Number.MAX_SAFE_INTEGER, 1),
  locations: Type.Array(Type.Object(definition, strict), { minItems: 1 }),
  actors: Type.Array(Type.Object(definition, strict), { minItems: 1 }),
  items: Type.Array(Type.Object({ ...definition, price: money }, strict)),
  initial: Type.Object({ actorId: id, locationId: id, money, inventory: Type.Array(inventoryEntry) }, strict),
}, strict);

export const WorldSnapshotSchema = Type.Object({
  schemaVersion: Type.Literal(WORLD_SCHEMA_VERSION), revision: integer(), templateHash: hash,
  templateVersion: integer(Number.MAX_SAFE_INTEGER, 1), rulesVersion: integer(Number.MAX_SAFE_INTEGER, 1),
  clockMinutes: clock,
  scene: Type.Object({ locationId: id, presentActorIds: Type.Array(id, { uniqueItems: true }) }, strict),
  actors: Type.Record(id, actor, strict), money: Type.Record(id, money, strict),
  inventory: Type.Array(inventoryEntry), recentEvents: Type.Array(event, { maxItems: WORLD_MAX_RECENT_EVENTS }),
}, strict);

const commandSchemas = {
  move_to: Type.Object({ commandId: id, type: Type.Literal("move_to"), actorId: id, locationId: id }, strict),
  transfer_item: Type.Object({ commandId: id, type: Type.Literal("transfer_item"), fromId: id, toId: id, itemId: id, quantity }, strict),
  purchase_item: Type.Object({ commandId: id, type: Type.Literal("purchase_item"), buyerId: id, sellerId: id, itemId: id, quantity }, strict),
  advance_time: Type.Object({ commandId: id, type: Type.Literal("advance_time"), minutes: integer(WORLD_MAX_CLOCK_MINUTES, 1) }, strict),
};
export const WorldCommandSchema = Type.Union(Object.values(commandSchemas));

export class WorldValidationError extends Error {
  constructor(message: string, readonly issues: Array<{ path: string; message: string }> = []) {
    super(message);
    this.name = "WorldValidationError";
  }
}

function invalid(message: string): never { throw new WorldValidationError(message); }

function parse<T>(schema: TSchema, input: unknown, label: string): T {
  let value: unknown;
  try { value = structuredClone(input); }
  catch { return invalid(`${label}必须是可复制的 JSON 数据`); }
  if (!Value.Check(schema, value)) {
    throw new WorldValidationError(`${label}格式不合法`, Value.Errors(schema, value).map((error) => ({
      path: error.instancePath, message: error.message,
    })));
  }
  // 与存档 JSON 表示一致：省略 undefined 可选字段，并把 -0 规范化为 0。
  return JSON.parse(JSON.stringify(value)) as T;
}

function unique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) invalid(`${label}不能重复`);
}

function checkInventory(inventory: WorldSnapshot["inventory"], actorIds: Set<string>, itemIds?: Set<string>): void {
  unique(inventory.map(({ ownerId, itemId }) => JSON.stringify([ownerId, itemId])), "同一归属的物品记录");
  for (const entry of inventory) {
    if (!actorIds.has(entry.ownerId)) invalid(`库存归属角色未声明：${entry.ownerId}`);
    if (itemIds && !itemIds.has(entry.itemId)) invalid(`库存物品未声明：${entry.itemId}`);
  }
}

/** 场景随玩家所在地点；停用角色不计入在场列表，死亡角色仍可在场。 */
export function presentActorIds(actors: Record<string, WorldActorState>, locationId: string): string[] {
  return Object.values(actors).filter((entry) => entry.locationId === locationId && entry.status !== "inactive")
    .map((entry) => entry.id).sort();
}

export function parseWorldTemplate(input: unknown): WorldTemplate {
  const template = parse<WorldTemplate>(WorldTemplateSchema, input, "世界模板");
  unique(template.locations.map((entry) => entry.id), "地点 ID");
  unique(template.actors.map((entry) => entry.id), "角色 ID");
  unique(template.items.map((entry) => entry.id), "物品 ID");
  const actors = new Set(template.actors.map((entry) => entry.id));
  if (!actors.has(template.initial.actorId)) invalid("初始玩家角色未声明");
  if (!template.locations.some((entry) => entry.id === template.initial.locationId)) invalid("初始地点未声明");
  checkInventory(template.initial.inventory, actors, new Set(template.items.map((entry) => entry.id)));
  return template;
}

export function parseWorldSnapshot(input: unknown): WorldSnapshot {
  const snapshot = parse<WorldSnapshot>(WorldSnapshotSchema, input, "世界快照");
  const actorIds = Object.keys(snapshot.actors);
  if (!actorIds.length) invalid("世界快照必须包含角色");
  for (const [key, entry] of Object.entries(snapshot.actors)) {
    if (key !== entry.id) invalid("角色表键必须与角色 ID 一致");
  }
  if (Object.keys(snapshot.money).length !== actorIds.length || actorIds.some((key) => !Object.hasOwn(snapshot.money, key))) {
    invalid("金钱表必须与角色表一一对应");
  }
  const present = presentActorIds(snapshot.actors, snapshot.scene.locationId);
  if (present.length !== snapshot.scene.presentActorIds.length || present.some((key) => !snapshot.scene.presentActorIds.includes(key))) {
    invalid("场景在场列表与角色位置不一致");
  }
  checkInventory(snapshot.inventory, new Set(actorIds));
  unique(snapshot.recentEvents.map((entry) => entry.id), "事件 ID");
  for (const entry of snapshot.recentEvents) {
    if (entry.worldTimeMinutes > snapshot.clockMinutes) invalid("审计事件不能晚于当前世界时钟");
    for (const key of [entry.actorId, entry.targetId]) {
      if (key !== undefined && !Object.hasOwn(snapshot.actors, key)) invalid("事件引用了未声明角色");
    }
  }
  return snapshot;
}

/** 模板可用时再检查跨文档引用；模板缺失时仍允许读取结构合法的快照。 */
export function validateWorldReferences(snapshot: WorldSnapshot, template: WorldTemplate): void {
  const actors = new Set(template.actors.map((entry) => entry.id));
  const locations = new Set(template.locations.map((entry) => entry.id));
  const items = new Set(template.items.map((entry) => entry.id));
  if (Object.keys(snapshot.actors).length !== actors.size || Object.keys(snapshot.actors).some((key) => !actors.has(key))) {
    invalid("快照角色与模板不一致");
  }
  for (const entry of Object.values(snapshot.actors)) {
    if (!locations.has(entry.locationId)) invalid("快照角色引用了未声明地点");
  }
  if (snapshot.scene.locationId !== snapshot.actors[template.initial.actorId].locationId) invalid("当前场景必须跟随玩家位置");
  checkInventory(snapshot.inventory, actors, items);
  if (snapshot.recentEvents.some((entry) => entry.itemId !== undefined && !items.has(entry.itemId))) invalid("事件物品与模板不一致");
}

export function parseWorldCommand(input: unknown): WorldCommand {
  const type = input && typeof input === "object" ? (input as { type?: unknown }).type : undefined;
  if (typeof type !== "string" || !Object.hasOwn(commandSchemas, type)) return invalid("未知世界命令");
  return parse<WorldCommand>(commandSchemas[type as keyof typeof commandSchemas], input, "世界命令");
}
