/** 0.6.0 世界模板迁移规划：纯函数，不写聊天、不调用模型。 */
import assert from "node:assert/strict";
import type { WorldTemplate, WorldTemplateRecord } from "@pitavern/shared/world";
import { WORLD_RULES_VERSION, createInitialWorldSnapshot, createWorldTemplateRecord, parseWorldSnapshot } from "../src/world/index.ts";
import { buildMigrationPreview, diffWorldTemplateRecords, planWorldSnapshotMigration } from "../src/world/migration.ts";

let checks = 0;
function check(label: string): void { checks += 1; console.log("✓ " + label); }
function clone<T>(value: T): T { return structuredClone(value); }
const baseTemplate: WorldTemplate = {
  schemaVersion: 1, templateId: "migration-world", templateVersion: 1, rulesVersion: WORLD_RULES_VERSION,
  locations: [{ id: "tavern", name: "酒馆" }, { id: "square", name: "集市" }],
  actors: [{ id: "player", name: "旅人" }, { id: "merchant", name: "掌柜" }],
  items: [{ id: "sword", name: "长剑", price: 30 }],
  initial: { actorId: "player", locationId: "tavern", money: 100, inventory: [{ ownerId: "merchant", itemId: "sword", quantity: 2 }] },
};
const base = createWorldTemplateRecord(baseTemplate, { name: "迁移世界", description: "第一版" });
const snapshot = createInitialWorldSnapshot(base);
function target(mutate: (template: WorldTemplate) => void, name = "迁移世界", description = "第二版"): WorldTemplateRecord {
  const template = clone(baseTemplate);
  template.templateVersion = 2;
  mutate(template);
  return createWorldTemplateRecord(template, { name, description });
}

// 价格/描述变化
const priceRecord = target((template) => { template.items[0].price = 40; }, "迁移世界·新价", "第二版");
const pricePlan = planWorldSnapshotMigration(snapshot, base, priceRecord);
assert.equal(pricePlan.applyable, true);
assert.ok(pricePlan.snapshot);
assert.equal(pricePlan.snapshot!.templateHash, priceRecord.contentHash);
assert.equal(pricePlan.snapshot!.templateVersion, 2);
assert.deepEqual(pricePlan.snapshot!.money, snapshot.money);
assert.deepEqual(pricePlan.snapshot!.inventory, snapshot.inventory);
assert.ok(pricePlan.changes.some((change) => change.entity === "item" && change.id === "sword" && change.detail?.includes("30 → 40")));
assert.deepEqual(snapshot, createInitialWorldSnapshot(base), "源快照不能被修改");
check("价格/名称变化：快照只切模板引用，金额与库存不变");

// 新增地点/角色/物品
const addRecord = target((template) => {
  template.locations.push({ id: "forge", name: "铁匠铺" });
  template.actors.push({ id: "smith", name: "铁匠" });
  template.items.push({ id: "shield", name: "盾牌", price: 25 });
});
const addPlan = planWorldSnapshotMigration(snapshot, base, addRecord);
assert.equal(addPlan.applyable, true);
assert.ok(addPlan.snapshot);
assert.equal(addPlan.snapshot!.actors.smith.locationId, "tavern");
assert.equal(addPlan.snapshot!.actors.smith.status, "alive");
assert.equal(addPlan.snapshot!.money.smith, 0);
assert.ok(addPlan.snapshot!.scene.presentActorIds.includes("smith"));
assert.deepEqual(addPlan.snapshot!.inventory, snapshot.inventory);
assert.ok(addPlan.changes.some((change) => change.entity === "location" && change.action === "added"));
assert.ok(addPlan.changes.some((change) => change.entity === "actor" && change.action === "added"));
assert.ok(addPlan.changes.some((change) => change.entity === "item" && change.action === "added"));
assert.ok(addPlan.warnings.some((warning) => warning.includes("铁匠")));
check("新增地点/角色/物品：补 alive 初始状态，不生成库存");

// 新增角色在非当前初始地点时不加入在场
const addRemote = target((template) => {
  template.actors.push({ id: "wanderer", name: "旅人乙" });
  template.initial.locationId = "square";
});
const remotePlan = planWorldSnapshotMigration(snapshot, base, addRemote);
assert.equal(remotePlan.applyable, true);
assert.equal(remotePlan.snapshot!.actors.wanderer.locationId, "square");
assert.ok(!remotePlan.snapshot!.scene.presentActorIds.includes("wanderer"));
assert.deepEqual(remotePlan.snapshot!.money, { ...snapshot.money, wanderer: 0 });
check("新增角色按新模板初始地点创建，不在当前场景时不加入在场");

// 删除/改 ID 阻断
for (const mutate of [
  (template: WorldTemplate) => { template.actors = template.actors.filter((actor) => actor.id !== "merchant"); template.initial.inventory = []; },
  (template: WorldTemplate) => { template.locations = template.locations.filter((location) => location.id !== "square"); },
  (template: WorldTemplate) => { template.items = []; template.initial.inventory = []; },
  (template: WorldTemplate) => { template.actors[1].id = "merchant2"; template.initial.inventory[0].ownerId = "merchant2"; },
] as Array<(template: WorldTemplate) => void>) {
  const removed = target(mutate);
  const plan = planWorldSnapshotMigration(snapshot, base, removed);
  assert.equal(plan.applyable, false);
  assert.equal(plan.snapshot, undefined);
  assert.ok(plan.blocking.length > 0);
}
check("删除地点/角色/物品或修改实体 ID：阻断且不生成迁移快照");

// 初始状态变化
const initialMoney = target((template) => { template.initial.money = 250; template.initial.inventory = []; template.initial.locationId = "square"; });
const initialPlan = planWorldSnapshotMigration(snapshot, base, initialMoney);
assert.equal(initialPlan.applyable, true);
assert.equal(initialPlan.snapshot!.money.player, 100);
assert.equal(initialPlan.snapshot!.scene.locationId, "tavern");
assert.deepEqual(initialPlan.snapshot!.inventory, snapshot.inventory);
assert.ok(initialPlan.warnings.some((warning) => warning.includes("只应用于新聊天")));
const initialActor = target((template) => { template.initial.actorId = "merchant"; });
assert.equal(planWorldSnapshotMigration(snapshot, base, initialActor).applyable, false);
check("初始金额/位置/库存变化只警告不影响旧世界；切换初始玩家阻断");

// 规则版本
const unknownRules = createWorldTemplateRecord({ ...baseTemplate, templateVersion: 2, rulesVersion: 2 }, { name: "未知规则" });
const rulesPlan = planWorldSnapshotMigration(snapshot, base, unknownRules);
assert.equal(rulesPlan.applyable, false);
assert.ok(rulesPlan.blocking.some((change) => change.entity === "rules"));
check("未支持规则版本阻断迁移");

// 源/目标不一致与预览哈希
const mismatch = planWorldSnapshotMigration({ ...snapshot, templateHash: "0".repeat(64) }, base, priceRecord);
assert.equal(mismatch.applyable, false);
const previewA = buildMigrationPreview("chats/world.jsonl", snapshot, base, priceRecord);
const previewB = buildMigrationPreview("chats/world.jsonl", snapshot, base, priceRecord);
assert.equal(previewA.previewHash, previewB.previewHash);
assert.equal(previewA.snapshot?.templateHash, priceRecord.contentHash);
const price41 = target((template) => { template.items[0].price = 41; });
assert.notEqual(buildMigrationPreview("chats/world.jsonl", snapshot, base, price41).previewHash, previewA.previewHash);
assert.deepEqual(parseWorldSnapshot(previewA.snapshot), previewA.snapshot);
check("源模板 hash 不一致阻断；预览哈希稳定且随目标变化");

const diff = diffWorldTemplateRecords(base, priceRecord);
assert.ok(diff.changes.some((change) => change.entity === "template" && change.detail?.includes("迁移世界")));
check("模板名称/描述差异可独立展示");

console.log("\n" + checks + " 项检查全部通过。");
