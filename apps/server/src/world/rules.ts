import { randomUUID } from "node:crypto";
import {
  WORLD_MAX_CLOCK_MINUTES, WORLD_MAX_ITEM_QUANTITY, WORLD_MAX_MONEY, WORLD_MAX_RECENT_EVENTS,
  type WorldActorState, type WorldCommand, type WorldCommandError, type WorldCommandErrorCode,
  type WorldCommandStaged, type WorldEvent, type WorldSnapshot, type WorldTemplate,
} from "@pitavern/shared/world";
import { presentActorIds } from "./schema.ts";

export class WorldRuleError extends Error {
  constructor(readonly error: WorldCommandError) { super(error.message); }
}

function reject(code: WorldCommandErrorCode, message: string): never { throw new WorldRuleError({ code, message }); }

function add(left: number, right: number, maximum: number, code: WorldCommandErrorCode): number {
  if (right > maximum - left) reject(code, "结算结果超过数值上限");
  return left + right;
}

function activeActor(snapshot: WorldSnapshot, id: string): WorldActorState {
  if (!Object.hasOwn(snapshot.actors, id)) reject("UNKNOWN_ENTITY", `角色未声明：${id}`);
  const actor = snapshot.actors[id];
  if (actor.status !== "alive") reject("INVALID_COMMAND", `角色当前不能行动：${id}`);
  return actor;
}

function transfer(snapshot: WorldSnapshot, fromId: string, toId: string, itemId: string, quantity: number): void {
  if (fromId === toId) reject("INVALID_COMMAND", "物品来源与目标不能相同");
  const source = snapshot.inventory.find((entry) => entry.ownerId === fromId && entry.itemId === itemId);
  if (!source || source.quantity < quantity) reject("INSUFFICIENT_QUANTITY", "来源库存不足");
  const target = snapshot.inventory.find((entry) => entry.ownerId === toId && entry.itemId === itemId);
  const next = add(target?.quantity ?? 0, quantity, WORLD_MAX_ITEM_QUANTITY, "INVALID_QUANTITY");
  source.quantity -= quantity;
  if (target) target.quantity = next;
  else snapshot.inventory.push({ ownerId: toId, itemId, quantity: next });
  snapshot.inventory = snapshot.inventory.filter((entry) => entry.quantity > 0);
}

/** 仅在事务的单命令私有副本上执行；异常时由事务丢弃此副本。 */
export function applyWorldCommand(snapshot: WorldSnapshot, template: WorldTemplate, command: WorldCommand, turn: number): WorldCommandStaged {
  const revision = add(snapshot.revision, 1, Number.MAX_SAFE_INTEGER, "INVALID_COMMAND");
  let effect: Omit<WorldEvent, "id" | "commandId" | "turn" | "worldTimeMinutes">;
  if (command.type === "advance_time") {
    snapshot.clockMinutes = add(snapshot.clockMinutes, command.minutes, WORLD_MAX_CLOCK_MINUTES, "TIME_LIMIT");
    effect = { type: "advance_time", summary: `时间推进 ${command.minutes} 分钟` };
  } else if (command.type === "move_to") {
    const actor = activeActor(snapshot, command.actorId);
    const location = template.locations.find((entry) => entry.id === command.locationId);
    if (!location) reject("UNKNOWN_LOCATION", `地点未声明：${command.locationId}`);
    actor.locationId = location.id;
    snapshot.scene.locationId = snapshot.actors[template.initial.actorId].locationId;
    snapshot.scene.presentActorIds = presentActorIds(snapshot.actors, snapshot.scene.locationId);
    effect = { type: "move", actorId: actor.id, summary: `${actor.id} 移动到 ${location.name}` };
  } else {
    const fromId = command.type === "purchase_item" ? command.sellerId : command.fromId;
    const toId = command.type === "purchase_item" ? command.buyerId : command.toId;
    const from = activeActor(snapshot, fromId), to = activeActor(snapshot, toId);
    if (from.locationId !== to.locationId) reject("INVALID_COMMAND", "物品交接双方必须在同一地点");
    const item = template.items.find((entry) => entry.id === command.itemId);
    if (!item) reject("UNKNOWN_ITEM", `物品未声明：${command.itemId}`);
    if (command.type === "purchase_item") {
      if (fromId === toId) reject("INVALID_COMMAND", "买家与卖家不能相同");
      if (item.price > Math.floor(WORLD_MAX_MONEY / command.quantity)) reject("INVALID_AMOUNT", "交易总额超过金额上限");
      const cost = item.price * command.quantity;
      if (snapshot.money[toId] < cost) reject("INSUFFICIENT_FUNDS", "买家余额不足");
      const sellerMoney = add(snapshot.money[fromId], cost, WORLD_MAX_MONEY, "INVALID_AMOUNT");
      transfer(snapshot, fromId, toId, item.id, command.quantity);
      snapshot.money[toId] -= cost;
      snapshot.money[fromId] = sellerMoney;
      effect = { type: "purchase", actorId: toId, targetId: fromId, itemId: item.id, quantity: command.quantity,
        moneyDelta: cost === 0 ? 0 : -cost, summary: `${toId} 花费 ${cost} 向 ${fromId} 购买 ${command.quantity} 件${item.name}` };
    } else {
      transfer(snapshot, fromId, toId, item.id, command.quantity);
      effect = { type: "transfer", actorId: fromId, targetId: toId, itemId: item.id, quantity: command.quantity,
        summary: `${fromId} 向 ${toId} 转移 ${command.quantity} 件${item.name}` };
    }
  }
  const event: WorldEvent = { ...effect, id: randomUUID(), commandId: command.commandId, turn, worldTimeMinutes: snapshot.clockMinutes };
  snapshot.revision = revision;
  snapshot.recentEvents = [...snapshot.recentEvents, event].slice(-WORLD_MAX_RECENT_EVENTS);
  return { status: "staged", commandId: command.commandId, summary: event.summary, event, revision };
}
