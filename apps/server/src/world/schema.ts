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

const templateV1 = Type.Object({
  schemaVersion: Type.Literal(WORLD_SCHEMA_VERSION), templateId: id,
  templateVersion: integer(Number.MAX_SAFE_INTEGER, 1), rulesVersion: integer(Number.MAX_SAFE_INTEGER, 1),
  locations: Type.Array(Type.Object(definition, strict), { minItems: 1 }),
  actors: Type.Array(Type.Object(definition, strict), { minItems: 1 }),
  items: Type.Array(Type.Object({ ...definition, price: money }, strict)),
  initial: Type.Object({ actorId: id, locationId: id, money, inventory: Type.Array(inventoryEntry) }, strict),
}, strict);

const snapshotV1 = Type.Object({
  schemaVersion: Type.Literal(WORLD_SCHEMA_VERSION), revision: integer(), templateHash: hash,
  templateVersion: integer(Number.MAX_SAFE_INTEGER, 1), rulesVersion: integer(Number.MAX_SAFE_INTEGER, 1),
  clockMinutes: clock,
  scene: Type.Object({ locationId: id, presentActorIds: Type.Array(id, { uniqueItems: true }) }, strict),
  actors: Type.Record(id, actor, strict), money: Type.Record(id, money, strict),
  inventory: Type.Array(inventoryEntry), recentEvents: Type.Array(event, { maxItems: WORLD_MAX_RECENT_EVENTS }),
}, strict);

const fact = Type.Object({id, text: Type.String({minLength:1,maxLength:2000}), visibility: Type.Union([Type.Literal("public"),Type.Literal("restricted")]), description: Type.Optional(Type.String({maxLength:2000}))}, strict);
const relation = {actorId:id, factId:id};
const source = Type.Union([
  Type.Object({type:Type.Literal("initial"),turn:Type.Literal(0)},strict),
  Type.Object({type:Type.Literal("interaction"),turn:integer(),interactionId:id,fromActorId:Type.Optional(id)},strict),
]);
const condition = Type.Union([
  Type.Object({type:Type.Literal("at_location"),locationId:id},strict),
  Type.Object({type:Type.Literal("npc_present"),actorId:id},strict),
  Type.Object({type:Type.Literal("has_item"),itemId:id,quantity},strict),
  Type.Object({type:Type.Literal("knows_fact"),...relation},strict),
]);
const effect = Type.Union([
  Type.Object({type:Type.Literal("learn"),...relation,fromActorId:Type.Optional(id)},strict),
  Type.Object({type:Type.Literal("publish"),factId:id},strict),
]);
const interaction = Type.Object({id,name:Type.String({minLength:1,maxLength:100}),description:Type.Optional(Type.String({maxLength:2000})),conditions:Type.Array(condition,{maxItems:16}),effects:Type.Array(effect,{minItems:1,maxItems:16})},strict);
const eventV2 = Type.Object({...event.properties, type:Type.Union([...event.properties.type.anyOf,Type.Literal("knowledge_learn"),Type.Literal("knowledge_publish")]),factId:Type.Optional(id),interactionId:Type.Optional(id)},strict);
const templateV2 = Type.Object({...templateV1.properties,
  schemaVersion:Type.Literal(2), facts:Type.Array(fact,{maxItems:256}), interactions:Type.Array(interaction,{maxItems:128}),
  initial:Type.Object({...templateV1.properties.initial.properties,knowledge:Type.Array(Type.Object(relation,strict),{maxItems:2048})},strict),
},strict);
const snapshotV2 = Type.Object({...snapshotV1.properties,
  schemaVersion:Type.Literal(2),knowledge:Type.Array(Type.Object({...relation,source},strict),{maxItems:2048}),
  publishedFactIds:Type.Array(id,{maxItems:256,uniqueItems:true}),recentEvents:Type.Array(eventV2,{maxItems:WORLD_MAX_RECENT_EVENTS}),
},strict);
const questItem = Type.Object({itemId:id,quantity},strict);
const quest = Type.Object({id,name:Type.String({minLength:1,maxLength:100}),description:Type.Optional(Type.String({maxLength:2000})),
  openConditions:Type.Array(condition,{maxItems:16}),stages:Type.Array(Type.Object({id,objective:Type.String({minLength:1,maxLength:1000}),conditions:Type.Array(condition,{maxItems:16}),
    delivery:Type.Optional(Type.Object({toActorId:id,itemId:id,quantity},strict))},strict),{minItems:1,maxItems:8}),
  reward:Type.Object({fromActorId:id,money,items:Type.Array(questItem,{maxItems:16})},strict)},strict);
const questState = Type.Object({questId:id,status:Type.Union([Type.Literal("active"),Type.Literal("completed")]),acceptedTurn:integer(),
  completedStages:Type.Array(Type.Object({stageId:id,turn:integer()},strict),{maxItems:8}),completedTurn:Type.Optional(integer())},strict);
const eventV3 = Type.Object({...eventV2.properties,type:Type.Union([...eventV2.properties.type.anyOf,Type.Literal("quest_accept"),Type.Literal("quest_advance"),Type.Literal("quest_complete")]),questId:Type.Optional(id),stageId:Type.Optional(id)},strict);
export const WorldTemplateSchema = Type.Union([templateV1,templateV2,Type.Object({...templateV2.properties,schemaVersion:Type.Literal(3),quests:Type.Array(quest,{maxItems:64}),
  initial:Type.Object({...templateV2.properties.initial.properties,actorMoney:Type.Array(Type.Object({actorId:id,money},strict),{maxItems:256})},strict)},strict)]);
export const WorldSnapshotSchema = Type.Union([snapshotV1,snapshotV2,Type.Object({...snapshotV2.properties,schemaVersion:Type.Literal(3),questStates:Type.Array(questState,{maxItems:64}),recentEvents:Type.Array(eventV3,{maxItems:WORLD_MAX_RECENT_EVENTS})},strict)]);

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
  if (template.schemaVersion >= 2) {
    const facts = new Set(template.facts!.map(f => f.id));
    const interactions = template.interactions!;
    unique(template.facts!.map(f=>f.id), "事实 ID"); unique(interactions.map(i=>i.id), "交互 ID");
    checkKnowledge(template.initial.knowledge!, actors, facts);
    for (const i of interactions) {
      for (const c of i.conditions) {
        if ("actorId" in c && !actors.has(c.actorId)) invalid("交互角色引用无效");
        if ("factId" in c && !facts.has(c.factId)) invalid("交互事实引用无效");
        if ("itemId" in c && !template.items.some(x=>x.id===c.itemId)) invalid("交互物品引用无效");
        if ("locationId" in c && !template.locations.some(x=>x.id===c.locationId)) invalid("交互地点引用无效");
        if (c.type === "npc_present" && c.actorId === template.initial.actorId) invalid("在场 NPC 不能是玩家");
      }
      for (const e of i.effects) {
        if (!facts.has(e.factId) || ("actorId" in e && !actors.has(e.actorId)) || ("fromActorId" in e && e.fromActorId !== undefined && !actors.has(e.fromActorId))) invalid("交互效果引用无效");
      }
    }
  }
  if (template.schemaVersion === 3) {
    unique(template.quests!.map(q=>q.id),"任务 ID");
    unique(template.initial.actorMoney!.map(m=>m.actorId),"初始金额角色");
    for (const m of template.initial.actorMoney!) if (!actors.has(m.actorId) || m.actorId === template.initial.actorId) invalid("初始NPC金额角色无效");
    const npc = (id:string) => {if (!actors.has(id) || id === template.initial.actorId) invalid("任务NPC引用无效");};
    const item = (id:string) => {if (!template.items.some(i=>i.id===id)) invalid("任务物品引用无效");};
    for (const q of template.quests!) {
      npc(q.reward.fromActorId); unique(q.stages.map(s=>s.id),"任务阶段 ID");unique(q.reward.items.map(i=>i.itemId),"奖励物品");q.reward.items.forEach(i=>item(i.itemId));
      for (const c of [...q.openConditions,...q.stages.flatMap(s=>s.conditions)]) {
        if ("actorId" in c && !actors.has(c.actorId)) invalid("任务角色引用无效");
        if ("factId" in c && !template.facts!.some(f=>f.id===c.factId)) invalid("任务事实引用无效");
        if ("itemId" in c) item(c.itemId);
        if ("locationId" in c && !template.locations.some(l=>l.id===c.locationId)) invalid("任务地点引用无效");
        if (c.type === "npc_present") npc(c.actorId);
      }
      q.stages.forEach((s,i)=>{if(s.delivery){if(i!==q.stages.length-1) invalid("只有最终阶段可交付");npc(s.delivery.toActorId);item(s.delivery.itemId);}});
    }
  }
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
  if (snapshot.schemaVersion >= 2) {
    checkKnowledge(snapshot.knowledge!,new Set(actorIds));
    for (const entry of snapshot.knowledge!) if (entry.source.turn < 0 || (entry.source.fromActorId && !snapshot.actors[entry.source.fromActorId])) invalid("获知来源无效");
    for (const e of snapshot.recentEvents) {
      if (e.type.startsWith("knowledge_") && (!e.factId || !e.interactionId || (e.type === "knowledge_learn" && !e.actorId))) invalid("知识事件缺少来源");
      if (!e.type.startsWith("knowledge_") && (e.factId !== undefined || e.interactionId !== undefined)) invalid("普通事件不能携带知识引用");
    }
  }
  if (snapshot.schemaVersion === 3) {
    unique(snapshot.questStates!.map(q=>q.questId),"任务进度");
    for (const q of snapshot.questStates!) {
      unique(q.completedStages.map(s=>s.stageId),"完成阶段");
      let turn=q.acceptedTurn;for(const s of q.completedStages){if(s.turn<turn)invalid("任务阶段回合倒退");turn=s.turn;}
      if ((q.status === "completed") !== (q.completedTurn !== undefined) || (q.completedTurn !== undefined && q.completedTurn !== turn)) invalid("任务完成记录无效");
    }
    for(const e of snapshot.recentEvents) if(e.type.startsWith("quest_") ? (!e.questId || !e.actorId || (e.type!=="quest_accept" && !e.stageId)) : (e.questId!==undefined || e.stageId!==undefined)) invalid("任务事件来源无效");
  }
  return snapshot;
}

/** 模板可用时再检查跨文档引用；模板缺失时仍允许读取结构合法的快照。 */
export function validateWorldReferences(snapshot: WorldSnapshot, template: WorldTemplate): void {
  if (snapshot.schemaVersion !== template.schemaVersion) invalid("快照与模板 schema 版本不一致");
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
  if (snapshot.schemaVersion >= 2) {
    const facts = new Set(template.facts!.map(f=>f.id)), interactions = new Set(template.interactions!.map(i=>i.id));
    checkKnowledge(snapshot.knowledge!,actors,facts);
    if (snapshot.publishedFactIds!.some(id=>!facts.has(id))) invalid("公开事实引用无效");
    for (const k of snapshot.knowledge!) if (k.source.interactionId && !interactions.has(k.source.interactionId)) invalid("获知交互来源不存在");
    for (const e of snapshot.recentEvents) if ((e.factId && !facts.has(e.factId)) || (e.interactionId && !interactions.has(e.interactionId))) invalid("知识事件引用无效");
  }
  if (snapshot.schemaVersion === 3) {
    for(const state of snapshot.questStates!){
      const q=template.quests!.find(q=>q.id===state.questId);
      if(!q || state.completedStages.some((s,i)=>s.stageId!==q.stages[i]?.id) || (state.status === "completed" ? state.completedStages.length!==q.stages.length : state.completedStages.length>=q.stages.length)) invalid("任务进度与模板不一致");
    }
    for(const e of snapshot.recentEvents) if(e.questId){const q=template.quests!.find(q=>q.id===e.questId);if(!q || (e.stageId && !q.stages.some(s=>s.id===e.stageId)) || e.actorId!==template.initial.actorId) invalid("任务事件引用无效");}
  }
  if (snapshot.recentEvents.some((entry) => entry.itemId !== undefined && !items.has(entry.itemId))) invalid("事件物品与模板不一致");
}

export function parseWorldCommand(input: unknown): WorldCommand {
  const type = input && typeof input === "object" ? (input as { type?: unknown }).type : undefined;
  if (typeof type !== "string" || !Object.hasOwn(commandSchemas, type)) return invalid("未知世界命令");
  return parse<WorldCommand>(commandSchemas[type as keyof typeof commandSchemas], input, "世界命令");
}

function checkKnowledge(entries: Array<{actorId:string;factId:string}>, actors:Set<string>, facts?:Set<string>):void {
  unique(entries.map(e=>JSON.stringify([e.actorId,e.factId])),"知情关系");
  if(entries.some(e=>!actors.has(e.actorId) || (facts && !facts.has(e.factId)))) invalid("知情关系引用无效");
}
