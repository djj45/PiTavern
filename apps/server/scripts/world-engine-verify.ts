/** Pure synthetic world fixtures; no chat storage, network, provider or browser dependencies. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  WORLD_MAX_CLOCK_MINUTES, WORLD_MAX_ITEM_QUANTITY, WORLD_MAX_MONEY, WORLD_MAX_RECENT_EVENTS,
  type WorldCommand, type WorldCommandErrorCode, type WorldCommandResult, type WorldSnapshot, type WorldTemplate,
} from "@pitavern/shared/world";
import {
  WorldState, WorldTransaction, WorldValidationError, createInitialWorldSnapshot, createWorldTemplateRecord,
  parseWorldCommand, parseWorldSnapshot, parseWorldTemplate,
} from "../src/world/index.ts";

function template(): WorldTemplate {
  return {
    schemaVersion: 1, templateId: "tavern", templateVersion: 1, rulesVersion: 1,
    locations: [{ id: "tavern", name: "酒馆" }, { id: "square", name: "广场" }],
    actors: [{ id: "player", name: "旅人" }, { id: "shopkeeper", name: "掌柜" }, { id: "guest", name: "客人" }],
    items: [{ id: "sword", name: "剑", price: 30 }, { id: "potion", name: "药水", price: 50 }],
    initial: { actorId: "player", locationId: "tavern", money: 100, inventory: [
      { ownerId: "shopkeeper", itemId: "sword", quantity: 3 }, { ownerId: "player", itemId: "potion", quantity: 1 },
    ] },
  };
}

function fixture(input = template()) {
  const record = createWorldTemplateRecord(input);
  const templates = { [record.contentHash]: record };
  const snapshot = createInitialWorldSnapshot(record);
  return { record, templates, snapshot, state: new WorldState(snapshot, templates) };
}

function purchase(commandId = "buy", quantity = 1): WorldCommand {
  return { commandId, type: "purchase_item", buyerId: "player", sellerId: "shopkeeper", itemId: "sword", quantity };
}

function rejected(result: WorldCommandResult, code: WorldCommandErrorCode) {
  assert.ok(result.status === "rejected", JSON.stringify(result));
  assert.equal(result.error.code, code);
  return result;
}

function staged(result: WorldCommandResult) {
  assert.ok(result.status === "staged", JSON.stringify(result));
  return result;
}

function quantity(snapshot: WorldSnapshot, ownerId: string, itemId = "sword"): number {
  return snapshot.inventory.find((entry) => entry.ownerId === ownerId && entry.itemId === itemId)?.quantity ?? 0;
}

describe("世界模板与快照校验", () => {
  it("初始化完整模板表引用、角色、余额、库存和场景", () => {
    const { snapshot, record } = fixture();
    assert.equal(snapshot.templateHash, record.contentHash);
    assert.equal(snapshot.templateVersion, 1); assert.equal(snapshot.rulesVersion, 1);
    assert.equal(snapshot.revision, 0); assert.equal(snapshot.clockMinutes, 0);
    assert.deepEqual(snapshot.money, { player: 100, shopkeeper: 0, guest: 0 });
    assert.deepEqual(snapshot.scene, { locationId: "tavern", presentActorIds: ["guest", "player", "shopkeeper"] });
    assert.ok(Object.values(snapshot.actors).every((actor) => actor.status === "alive" && actor.locationId === "tavern"));
    assert.deepEqual(parseWorldSnapshot(snapshot), snapshot);
    assert.ok(!Object.hasOwn(snapshot, "recentCommandIds"));
  });

  it("模板哈希不受对象键顺序影响，内容变化产生新身份", () => {
    const input = template(), original = createWorldTemplateRecord(input);
    const reordered = JSON.parse(JSON.stringify(input, (_key, value: unknown) => value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).reverse()) : value));
    assert.equal(createWorldTemplateRecord(reordered).contentHash, original.contentHash);
    input.items[0].price++;
    assert.notEqual(createWorldTemplateRecord(input).contentHash, original.contentHash);
    assert.equal(original.template.items[0].price, 30);
  });

  const invalidTemplates: Array<[string, (value: WorldTemplate) => void]> = [
    ["重复角色", (value) => value.actors.push({ ...value.actors[0] })],
    ["重复地点", (value) => value.locations.push({ ...value.locations[0] })],
    ["重复物品", (value) => value.items.push({ ...value.items[0] })],
    ["缺失玩家", (value) => { value.initial.actorId = "missing"; }],
    ["缺失初始地点", (value) => { value.initial.locationId = "missing"; }],
    ["未声明库存归属", (value) => { value.initial.inventory[0].ownerId = "missing"; }],
    ["未声明库存物品", (value) => { value.initial.inventory[0].itemId = "missing"; }],
    ["重复库存记录", (value) => value.initial.inventory.push({ ...value.initial.inventory[0] })],
    ["负价格", (value) => { value.items[0].price = -1; }],
    ["小数金额", (value) => { value.initial.money = 1.5; }],
    ["无限金额", (value) => { value.initial.money = Infinity; }],
    ["过量库存", (value) => { value.initial.inventory[0].quantity = WORLD_MAX_ITEM_QUANTITY + 1; }],
    ["零库存记录", (value) => { value.initial.inventory[0].quantity = 0; }],
    ["未知字段", (value) => { Object.assign(value, { unsupported: true }); }],
  ];
  for (const [label, edit] of invalidTemplates) it(`拒绝${label}`, () => {
    const input = template(); edit(input);
    assert.throws(() => parseWorldTemplate(input), WorldValidationError);
  });

  it("拒绝无效快照数值和失配的内部引用", () => {
    const { snapshot } = fixture();
    const edits: Array<(value: WorldSnapshot) => void> = [
      (value) => { value.revision = Number.MAX_SAFE_INTEGER + 1; },
      (value) => { value.clockMinutes = -1; },
      (value) => { value.money.player = NaN; },
      (value) => { value.money.player = WORLD_MAX_MONEY + 1; },
      (value) => { delete value.money.player; },
      (value) => { value.actors.player.id = "other"; },
      (value) => { value.scene.presentActorIds = []; },
      (value) => { value.inventory[0].ownerId = "missing"; },
    ];
    for (const edit of edits) {
      const invalid = structuredClone(snapshot); edit(invalid);
      assert.throws(() => parseWorldSnapshot(invalid), WorldValidationError);
    }
  });

  it("拒绝模型价格参数、未知命令和未知 schema", () => {
    assert.throws(() => parseWorldCommand({ ...purchase(), price: 1 }), WorldValidationError);
    assert.throws(() => parseWorldCommand({ commandId: "create", type: "create_item" }), WorldValidationError);
    assert.throws(() => parseWorldTemplate({ ...template(), schemaVersion: 2 }), WorldValidationError);
    const { snapshot } = fixture();
    assert.throws(() => parseWorldSnapshot({ ...snapshot, schemaVersion: 2 }), WorldValidationError);
  });
});

describe("模板版本与只读能力", () => {
  it("模板缺失/记录损坏/内容哈希错误时保留只读快照", () => {
    const { snapshot, record } = fixture();
    for (const templates of [undefined, {}, { [record.contentHash]: null },
      { [record.contentHash]: { ...record, contentHash: "0".repeat(64) } },
      { [record.contentHash]: { ...record, template: { ...record.template, templateVersion: 2 } } },
    ]) {
      const state = new WorldState(snapshot, templates);
      assert.equal(state.capability.mode, "read-only");
      assert.deepEqual(state.snapshot, snapshot);
      const tx = new WorldTransaction(state, 1);
      rejected(tx.execute(purchase()), "READ_ONLY");
      assert.deepEqual(tx.commit(), snapshot);
    }
  });

  it("未知规则和版本不匹配不静默使用当前规则", () => {
    const { snapshot, templates } = fixture();
    assert.equal(new WorldState({ ...snapshot, templateVersion: 2 }, templates).capability.mode, "read-only");
    const future = createWorldTemplateRecord({ ...template(), rulesVersion: 2 });
    const futureSnapshot = { ...snapshot, templateHash: future.contentHash, rulesVersion: 2 };
    const state = new WorldState(futureSnapshot, { [future.contentHash]: future });
    assert.equal(state.capability.mode, "read-only");
    assert.match(state.capability.reason!, /未知/);
    assert.throws(() => createInitialWorldSnapshot(future), WorldValidationError);
    assert.throws(() => createInitialWorldSnapshot({ ...future, contentHash: "0".repeat(64) }), WorldValidationError);
  });

  it("快照中未声明地点/物品/角色只能查看", () => {
    const { snapshot, templates } = fixture();
    for (const edit of [
      (value: WorldSnapshot) => { value.actors.guest.locationId = "missing"; value.scene.presentActorIds = ["player", "shopkeeper"]; },
      (value: WorldSnapshot) => { value.inventory[0].itemId = "missing"; },
      (value: WorldSnapshot) => {
        value.actors.other = { id: "other", locationId: "square", status: "alive" }; value.money.other = 0;
      },
    ]) {
      const changed = structuredClone(snapshot); edit(changed);
      assert.equal(new WorldState(changed, templates).capability.mode, "read-only");
    }
  });

  it("调用者可将合法世界限制为只读或禁用", () => {
    const { snapshot, templates } = fixture();
    for (const mode of ["read-only", "disabled"] as const) {
      const state = new WorldState(snapshot, templates, { mode, reason: "模型无普通工具" });
      const tx = new WorldTransaction(state, 1);
      assert.equal(state.capability.mode, mode);
      rejected(tx.execute(purchase()), "READ_ONLY");
      assert.deepEqual(tx.snapshot, snapshot);
    }
  });

  it("输入与所有公开读取结果均不共享可变对象", () => {
    const { state, snapshot, record, templates } = fixture();
    snapshot.money.player = 0; templates[record.contentHash].template.items[0].price = 0;
    const peek = state.snapshot; peek.inventory[0].quantity = 999;
    const definition = state.template!; definition.items[0].price = 0;
    const capability = state.capability; capability.mode = "disabled";
    const tx = new WorldTransaction(state, 1);
    const result = staged(tx.execute(purchase()));
    assert.equal(tx.snapshot.money.player, 70);
    result.event.summary = "changed";
    const receipts = tx.receipts; receipts[0].argsHash = "changed";
    assert.notEqual(staged(tx.execute(purchase())).event.summary, "changed");
    assert.notEqual(tx.receipts[0].argsHash, "changed");
    assert.equal(state.snapshot.money.player, 100);
    assert.equal(state.snapshot.inventory[0].quantity, 3);
  });
});

describe("固定酒馆规则与单命令原子性", () => {
  it("成功购买原子扣款/入账/转移库存，只生成一个事件", () => {
    const { state, snapshot } = fixture();
    const tx = new WorldTransaction(state, 7), result = staged(tx.execute(purchase("buy-two", 2)));
    const next = tx.snapshot;
    assert.equal(next.money.player, 40); assert.equal(next.money.shopkeeper, 60);
    assert.equal(quantity(next, "player"), 2); assert.equal(quantity(next, "shopkeeper"), 1);
    assert.equal(next.recentEvents.length, 1); assert.equal(next.revision, 1);
    assert.equal(result.event.type, "purchase"); assert.equal(result.event.turn, 7);
    assert.equal(result.event.moneyDelta, -60); assert.equal(result.revision, 1);
    assert.deepEqual(state.snapshot, snapshot);
    assert.deepEqual(parseWorldSnapshot(next), next);
  });

  it("余额不足或库存不足时不改变金钱/库存/事件/revision", () => {
    for (const [money, count, code] of [[10, 1, "INSUFFICIENT_FUNDS"], [1000, 4, "INSUFFICIENT_QUANTITY"]] as const) {
      const input = template(); input.initial.money = money;
      const { state } = fixture(input), tx = new WorldTransaction(state, 1), before = tx.snapshot;
      rejected(tx.execute(purchase("buy", count)), code);
      assert.deepEqual(tx.snapshot, before);
    }
  });

  it("物品转移保留总数量、不改变余额，清除零库存", () => {
    const { state } = fixture(), tx = new WorldTransaction(state, 1);
    staged(tx.execute({ commandId: "give", type: "transfer_item", fromId: "shopkeeper", toId: "player", itemId: "sword", quantity: 3 }));
    const next = tx.snapshot;
    assert.equal(quantity(next, "player"), 3); assert.equal(quantity(next, "shopkeeper"), 0);
    assert.ok(!next.inventory.some((entry) => entry.ownerId === "shopkeeper" && entry.itemId === "sword"));
    assert.deepEqual(next.money, state.snapshot.money);
  });

  it("未知实体/物品/地点及自交易被拒绝", () => {
    const { state } = fixture();
    const commands: Array<[unknown, WorldCommandErrorCode]> = [
      [{ ...purchase(), buyerId: "missing" }, "UNKNOWN_ENTITY"],
      [{ ...purchase(), sellerId: "missing" }, "UNKNOWN_ENTITY"],
      [{ ...purchase(), itemId: "missing" }, "UNKNOWN_ITEM"],
      [{ ...purchase(), sellerId: "player" }, "INVALID_COMMAND"],
      [{ commandId: "move", type: "move_to", actorId: "player", locationId: "missing" }, "UNKNOWN_LOCATION"],
      [{ commandId: "give", type: "transfer_item", fromId: "player", toId: "player", itemId: "potion", quantity: 1 }, "INVALID_COMMAND"],
    ];
    for (const [command, code] of commands) {
      const tx = new WorldTransaction(state, 1); rejected(tx.execute(command), code);
      assert.deepEqual(tx.snapshot, state.snapshot);
    }
  });

  it("拒绝零数、负数、小数、非数值、无限数及过量数量", () => {
    const { state } = fixture();
    for (const count of [0, -1, 0.5, "1", NaN, Infinity, WORLD_MAX_ITEM_QUANTITY + 1, Number.MAX_SAFE_INTEGER + 1]) {
      const tx = new WorldTransaction(state, 1);
      rejected(tx.execute({ ...purchase(), quantity: count }), "INVALID_QUANTITY");
      assert.deepEqual(tx.snapshot, state.snapshot);
    }
  });

  it("拒绝收款余额溢出、总价超限和接收库存超限", () => {
    const base = fixture();
    const funded = base.state.snapshot; funded.money.shopkeeper = WORLD_MAX_MONEY;
    let tx = new WorldTransaction(new WorldState(funded, base.templates), 1);
    rejected(tx.execute(purchase()), "INVALID_AMOUNT"); assert.deepEqual(tx.snapshot, funded);

    const costly = template(); costly.items[0].price = WORLD_MAX_MONEY;
    const highPrice = fixture(costly); tx = new WorldTransaction(highPrice.state, 1);
    rejected(tx.execute(purchase("expensive", WORLD_MAX_ITEM_QUANTITY)), "INVALID_AMOUNT");
    assert.deepEqual(tx.snapshot, highPrice.snapshot);

    const full = base.state.snapshot;
    full.inventory.push({ ownerId: "player", itemId: "sword", quantity: WORLD_MAX_ITEM_QUANTITY });
    tx = new WorldTransaction(new WorldState(full, base.templates), 1);
    rejected(tx.execute(purchase()), "INVALID_QUANTITY"); assert.deepEqual(tx.snapshot, full);
  });

  it("允许固定零价格和恰好到达金额/库存上限", () => {
    const input = template(); input.items[0].price = 0; input.initial.money = 0;
    const free = fixture(input), tx = new WorldTransaction(free.state, 1);
    staged(tx.execute(purchase())); assert.equal(tx.snapshot.money.player, 0);
    assert.deepEqual(JSON.parse(JSON.stringify(tx.snapshot)), tx.snapshot);
    const { snapshot, templates } = fixture();
    snapshot.money.shopkeeper = WORLD_MAX_MONEY - 30;
    snapshot.inventory.push({ ownerId: "player", itemId: "sword", quantity: WORLD_MAX_ITEM_QUANTITY - 1 });
    const exact = new WorldTransaction(new WorldState(snapshot, templates), 1);
    staged(exact.execute(purchase()));
    assert.equal(exact.snapshot.money.shopkeeper, WORLD_MAX_MONEY);
    assert.equal(quantity(exact.snapshot, "player"), WORLD_MAX_ITEM_QUANTITY);
  });

  it("移动玩家更新当前场景，移动其他角色只更新在场列表", () => {
    const { state } = fixture(), tx = new WorldTransaction(state, 1);
    staged(tx.execute({ commandId: "npc-move", type: "move_to", actorId: "shopkeeper", locationId: "square" }));
    assert.deepEqual(tx.snapshot.scene, { locationId: "tavern", presentActorIds: ["guest", "player"] });
    const before = tx.snapshot;
    rejected(tx.execute(purchase()), "INVALID_COMMAND"); assert.deepEqual(tx.snapshot, before);
    staged(tx.execute({ commandId: "player-move", type: "move_to", actorId: "player", locationId: "square" }));
    assert.deepEqual(tx.snapshot.scene, { locationId: "square", presentActorIds: ["player", "shopkeeper"] });
    staged(tx.execute(purchase("buy-at-square")));
  });

  it("死亡或停用角色不能行动", () => {
    const { snapshot, templates } = fixture();
    for (const status of ["dead", "inactive"] as const) {
      const changed = structuredClone(snapshot); changed.actors.player.status = status;
      if (status === "inactive") changed.scene.presentActorIds = ["guest", "shopkeeper"];
      const tx = new WorldTransaction(new WorldState(changed, templates), 1);
      rejected(tx.execute(purchase()), "INVALID_COMMAND");
      rejected(tx.execute({ commandId: "move", type: "move_to", actorId: "player", locationId: "square" }), "INVALID_COMMAND");
      assert.deepEqual(tx.snapshot, changed);
    }
  });

  it("时钟跨日、正向推进至上限；倒退/溢出不能留下变化", () => {
    const { snapshot, templates } = fixture(); snapshot.clockMinutes = 1439;
    const tx = new WorldTransaction(new WorldState(snapshot, templates), 1);
    staged(tx.execute({ commandId: "next-day", type: "advance_time", minutes: 2 }));
    assert.equal(tx.snapshot.clockMinutes, 1441);
    for (const minutes of [0, -1, 0.5, NaN, Infinity, WORLD_MAX_CLOCK_MINUTES + 1]) {
      const before = tx.snapshot;
      rejected(tx.execute({ commandId: "bad-time", type: "advance_time", minutes }), "TIME_LIMIT");
      assert.deepEqual(tx.snapshot, before);
    }
    staged(tx.execute({ commandId: "limit", type: "advance_time", minutes: WORLD_MAX_CLOCK_MINUTES - 1441 }));
    const before = tx.snapshot;
    rejected(tx.execute({ commandId: "overflow", type: "advance_time", minutes: 1 }), "TIME_LIMIT");
    assert.deepEqual(tx.snapshot, before);
    assert.equal(before.recentEvents.length, 2);
  });

  it("revision 到达安全整数上限后不再修改世界", () => {
    const { snapshot, templates } = fixture(); snapshot.revision = Number.MAX_SAFE_INTEGER;
    const tx = new WorldTransaction(new WorldState(snapshot, templates), 1);
    rejected(tx.execute(purchase()), "INVALID_COMMAND"); assert.deepEqual(tx.snapshot, snapshot);
  });
});

describe("事务幂等、隔离和结束", () => {
  it("相同 ID/参数返回原结果，参数键顺序无关", () => {
    const { state } = fixture(), tx = new WorldTransaction(state, 1), command = purchase();
    const first = staged(tx.execute(command)), snapshot = tx.snapshot;
    const reordered = Object.fromEntries(Object.entries(command).reverse());
    assert.deepEqual(tx.execute(reordered), first); assert.deepEqual(tx.snapshot, snapshot);
    assert.equal(tx.receipts.length, 1);
    rejected(tx.execute({ ...command, quantity: 2 }), "COMMAND_CONFLICT");
    rejected(tx.execute({ ...command, quantity: 0 }), "COMMAND_CONFLICT");
    rejected(tx.execute({ ...command, price: 1 }), "COMMAND_CONFLICT");
    assert.deepEqual(tx.execute(command), first); assert.deepEqual(tx.snapshot, snapshot);
  });

  it("被拒命令也返回原收据；改变意图需要新 ID", () => {
    const input = template(); input.initial.money = 0;
    const { snapshot, templates } = fixture(input); snapshot.money.shopkeeper = 100;
    const tx = new WorldTransaction(new WorldState(snapshot, templates), 1), command = purchase();
    const first = rejected(tx.execute(command), "INSUFFICIENT_FUNDS");
    staged(tx.execute({ commandId: "sell", type: "purchase_item", buyerId: "shopkeeper", sellerId: "player", itemId: "potion", quantity: 1 }));
    assert.equal(tx.snapshot.money.player, 50);
    assert.deepEqual(tx.execute(command), first);
    staged(tx.execute(purchase("buy-new")));
  });

  it("一个成功命令后发生失败，保留成功结果且失败没有部分修改", () => {
    const { state } = fixture(), tx = new WorldTransaction(state, 1);
    staged(tx.execute(purchase())); const afterFirst = tx.snapshot;
    rejected(tx.execute(purchase("too-many", 3)), "INSUFFICIENT_FUNDS");
    assert.deepEqual(tx.snapshot, afterFirst);
    assert.deepEqual(tx.commit(), afterFirst);
    assert.equal(state.snapshot.money.player, 100);
  });

  it("审计裁剪到 100 条后，事务内旧命令仍不会重执行", () => {
    const { state } = fixture(), tx = new WorldTransaction(state, 1);
    const firstCommand: WorldCommand = { commandId: "tick-0", type: "advance_time", minutes: 1 };
    const first = staged(tx.execute(firstCommand));
    for (let index = 1; index <= WORLD_MAX_RECENT_EVENTS; index++) staged(tx.execute({ ...firstCommand, commandId: `tick-${index}` }));
    const before = tx.snapshot;
    assert.equal(before.recentEvents.length, WORLD_MAX_RECENT_EVENTS);
    assert.equal(before.clockMinutes, 101); assert.equal(before.revision, 101);
    assert.ok(!before.recentEvents.some((event) => event.commandId === firstCommand.commandId));
    assert.deepEqual(tx.execute(firstCommand), first); assert.deepEqual(tx.snapshot, before);
    assert.equal(tx.receipts.length, 101);
    assert.deepEqual(parseWorldSnapshot(before), before);
  });

  it("提交只返回独立快照；新事务不继承上轮幂等收据", () => {
    const { state, templates } = fixture(), tx = new WorldTransaction(state, 1);
    staged(tx.execute(purchase())); const committed = tx.commit();
    assert.equal(tx.status, "committed"); assert.equal(state.snapshot.money.player, 100);
    const restored = new WorldState(committed, templates), next = new WorldTransaction(restored, 2);
    staged(next.execute(purchase())); assert.equal(next.snapshot.money.player, 40);
    assert.equal(next.snapshot.recentEvents.length, 2);
    committed.money.player = 0; assert.equal(tx.snapshot.money.player, 70);
    rejected(tx.execute(purchase("closed")), "INVALID_COMMAND");
    assert.throws(() => tx.commit(), WorldValidationError);
    assert.throws(() => tx.discard(), WorldValidationError);
  });

  it("丢弃全部暂存变化和收据，不影响另一事务", () => {
    const { state } = fixture(), left = new WorldTransaction(state, 1), right = new WorldTransaction(state, 1);
    staged(left.execute(purchase()));
    assert.deepEqual(right.snapshot, state.snapshot);
    staged(right.execute({ commandId: "tick", type: "advance_time", minutes: 5 }));
    left.discard(); assert.equal(left.status, "discarded");
    assert.deepEqual(left.snapshot, state.snapshot); assert.deepEqual(left.receipts, []);
    assert.equal(right.snapshot.clockMinutes, 5); assert.equal(right.snapshot.money.player, 100);
    rejected(left.execute(purchase()), "INVALID_COMMAND");
    assert.throws(() => left.commit(), WorldValidationError);
  });

  it("快照和模板表经 JSON 往返后可继续执行固定规则", () => {
    const { state, templates } = fixture(), tx = new WorldTransaction(state, 1);
    staged(tx.execute(purchase()));
    const json = JSON.stringify({ _pitavernWorld: tx.commit(), _pitavernWorldTemplates: templates });
    const parsed = JSON.parse(json), restored = new WorldState(parsed._pitavernWorld, parsed._pitavernWorldTemplates);
    assert.equal(restored.capability.mode, "enabled"); assert.deepEqual(restored.snapshot, tx.snapshot);
    const next = new WorldTransaction(restored, 2);
    staged(next.execute(purchase())); assert.equal(next.snapshot.money.player, 40);
    assert.deepEqual(parseWorldSnapshot(next.snapshot), next.snapshot);
  });

  it("拒绝无效回合号和无法解析的命令", () => {
    const { state } = fixture();
    for (const turn of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => new WorldTransaction(state, turn), WorldValidationError);
    const tx = new WorldTransaction(state, 1);
    for (const input of [null, undefined, [], {}, { type: "missing", commandId: "x" }, { ...purchase(), commandId: "" }, { ...purchase(), price: 1 }]) {
      rejected(tx.execute(input), "INVALID_COMMAND"); assert.deepEqual(tx.snapshot, state.snapshot);
    }
  });
});
