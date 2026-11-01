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

// 仅发布名称/描述：内容哈希不变，但迁移仍应可应用并更新元数据。
const metadataRecord = createWorldTemplateRecord(baseTemplate, { name: "迁移世界·元数据", description: "描述第二版" });
assert.equal(metadataRecord.contentHash, base.contentHash);
const metadataPlan = planWorldSnapshotMigration(snapshot, base, metadataRecord);
assert.equal(metadataPlan.applyable, true);
assert.ok(metadataPlan.snapshot);
assert.equal(metadataPlan.snapshot!.templateHash, base.contentHash);
assert.equal(metadataPlan.blocking.length, 0);
assert.ok(metadataPlan.changes.some((change) => change.entity === "template" && change.detail?.includes("描述已更新")));
const descriptionA = createWorldTemplateRecord(baseTemplate, { name: "迁移世界", description: "描述 A" });
const descriptionB = createWorldTemplateRecord(baseTemplate, { name: "迁移世界", description: "描述 B" });
assert.notEqual(
  buildMigrationPreview("chats/world.jsonl", snapshot, base, descriptionA).previewHash,
  buildMigrationPreview("chats/world.jsonl", snapshot, base, descriptionB).previewHash,
  "仅描述变化也必须改变预览哈希",
);
check("仅名称/描述发布：同内容哈希仍可迁移，预览哈希随描述变化");

// 源规则未知 / 源模板正文被篡改：必须在读取目标前阻断。
const sourceUnknownTemplate = clone(baseTemplate);
sourceUnknownTemplate.templateVersion = 2; sourceUnknownTemplate.rulesVersion = 999;
const sourceUnknown = createWorldTemplateRecord(sourceUnknownTemplate, { name: "旧版未知规则" });
const sourceUnknownSnapshot = { ...snapshot, templateHash: sourceUnknown.contentHash, templateVersion: 2, rulesVersion: 999 };
const sourceUnknownPlan = planWorldSnapshotMigration(sourceUnknownSnapshot, sourceUnknown, priceRecord);
assert.equal(sourceUnknownPlan.applyable, false);
assert.equal(sourceUnknownPlan.snapshot, undefined);
assert.ok(sourceUnknownPlan.blocking.some((change) => change.entity === "rules" && change.detail?.includes("999")));
const sourceBroken: WorldTemplateRecord = {
  ...base,
  template: { ...base.template, locations: base.template.locations.map((location, index) => index === 0 ? { ...location, name: "被篡改的酒馆" } : location) },
};
assert.equal(sourceBroken.contentHash, base.contentHash);
const sourceBrokenPlan = planWorldSnapshotMigration(snapshot, sourceBroken, priceRecord);
assert.equal(sourceBrokenPlan.applyable, false);
assert.ok(sourceBrokenPlan.blocking.some((change) => change.detail?.includes("源模板内容哈希不匹配")));
check("源规则未知或源模板正文与哈希不符：阻断，不信任源记录");

// 完全相同的记录是 no-op，不再用阻断项表示。
const noopPlan = planWorldSnapshotMigration(snapshot, base, base);
assert.equal(noopPlan.applyable, false);
assert.equal(noopPlan.snapshot, undefined);
assert.equal(noopPlan.blocking.length, 0);
assert.ok(noopPlan.warnings.some((warning) => warning.includes("无需迁移")));
check("目标与当前完全一致：仅提示无需迁移，不产生阻断项");

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
