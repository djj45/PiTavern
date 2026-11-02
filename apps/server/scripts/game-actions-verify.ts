import assert from "node:assert/strict";
import fs from "node:fs";
import { createInitialWorldSnapshot, createWorldTemplateRecord, WorldState } from "../src/world/state.ts";
import { buildPlayerWorldView, buildRoleWorldView } from "../src/world/knowledge.ts";
import { WorldTransaction } from "../src/world/transaction.ts";
import { worldStateText } from "../src/world/digest.ts";
import type { WorldTemplate } from "@pitavern/shared/world";

const raw: WorldTemplate = JSON.parse(fs.readFileSync(new URL("./fixtures/knowledge-tavern.json", import.meta.url), "utf8"));
let checks = 0;
function check(name: string) { checks++; console.log("✓ " + name); }
for (const indexes of [[0, 0], [-1], [4], [0.5], Array(17).fill(0)]) {
  const bad = structuredClone(raw); bad.interactions![0].publicConditionIndexes = indexes;
  assert.throws(() => createWorldTemplateRecord(bad));
}
check("公开条件索引拒绝重复、负数、越界、小数与超限");
const template = structuredClone(raw); template.interactions![0].publicConditionIndexes = [0, 1, 2];
const record = createWorldTemplateRecord(template), snapshot = createInitialWorldSnapshot(record);
const initial = buildPlayerWorldView(snapshot, record.template), before = structuredClone(snapshot);
assert.equal(initial.publicInteractions[0].availability?.status, "ready");
assert.deepEqual(snapshot, before);
check("投影只读，条件与知情来源满足时ready，不执行交互");
const transaction = () => new WorldTransaction(new WorldState(snapshot, { [record.contentHash]: record }), 1);
const tx = transaction();
tx.execute({ commandId: "move", type: "move_to", actorId: "player", locationId: "square" });
const moved = buildPlayerWorldView(tx.snapshot, record.template);
assert.equal(moved.publicInteractions[0].availability?.status, "later");
assert.match(moved.publicInteractions[0].availability!.reasons.join("；"), /旧酒馆.*掌柜/);
assert.equal(moved.knowledgeKey, initial.knowledgeKey);
assert.equal(tx.interact({ interactionId: template.interactions![0].id }).status, "rejected");
check("移动后立即计算地点/在场阻塞，执行规则一致；可用性不改变知识授权指纹");
tx.discard(); assert.deepEqual(tx.snapshot, snapshot);
assert.equal(buildPlayerWorldView(tx.snapshot, record.template).publicInteractions[0].availability?.status, "ready");
check("整轮失败丢弃暂存，恢复原可用性，无进度或知识写入");
const absent = structuredClone(snapshot); absent.inventory = absent.inventory.filter(i => i.ownerId !== "player");
assert.match(buildPlayerWorldView(absent, record.template).publicInteractions[0].availability!.reasons.join(), /介绍信×1/);
const privateRecord = createWorldTemplateRecord(raw), privateSnapshot = createInitialWorldSnapshot(privateRecord);
privateSnapshot.inventory = [];
const privateView = buildPlayerWorldView(privateSnapshot, raw);
assert.deepEqual(privateView.publicInteractions[0].availability!.reasons, ["仍有未满足的调查或任务条件，请先推进已公开的目标"]);
check("只有作者主动公开的条件关系显示物品要求；旧模板默认通用阻塞，旧哈希不被改写");
for (const text of [raw.facts![1].id, raw.facts![1].text, raw.facts![1].description!, raw.interactions![0].description!]) {
  assert.ok(!JSON.stringify(initial).includes(text));
  for (const section of ["summary", "actors", "inventory", "events", "catalog", "all"] as const) assert.ok(!worldStateText(snapshot, template, section).includes(text));
}
assert.ok(!buildRoleWorldView(snapshot, template, "innkeeper").publicInteractions[0].availability);
check("所有查询出口不含秘密ID/正文/作者备注，指定角色视图不带玩家执行状态");
const hidden = structuredClone(snapshot); hidden.knowledge = [];
assert.equal(buildPlayerWorldView(hidden, template).publicInteractions[0].availability?.status, "later");
const good = transaction(); assert.equal(good.interact({ interactionId: template.interactions![0].id }).status, "staged");
assert.ok(buildPlayerWorldView(good.snapshot, template).knownFacts.some(f => f.id === raw.facts![1].id));
check("传播来源不足只返回通用阻塞；合法交互才授权事实，未用正文授予知识");
console.log(`${checks} 组行动可用性检查通过`);
