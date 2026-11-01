/** M2: 整份聊天世界迁移计划（纯内存，不写文件）。 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { WorldTemplate, WorldTemplateRecord } from "@pitavern/shared/world";
import { WORLD_STATE_KEY, WORLD_TEMPLATES_KEY } from "@pitavern/shared/world";
import { createInitialWorldSnapshot, createWorldTemplateRecord } from "../src/world/index.ts";
import { planChatWorldMigration, WorldChatMigrationLimitError } from "../src/world/chat-migration.ts";

const baseTemplate: WorldTemplate = {
  schemaVersion: 1, templateId: "tavern-sword", templateVersion: 1, rulesVersion: 1,
  locations: [{ id: "tavern", name: "酒馆" }, { id: "square", name: "集市" }],
  actors: [{ id: "player", name: "旅人" }, { id: "merchant", name: "掌柜" }],
  items: [{ id: "sword", name: "长剑", price: 30 }],
  initial: { actorId: "player", locationId: "tavern", money: 100, inventory: [{ ownerId: "merchant", itemId: "sword", quantity: 2 }] },
};
const base = createWorldTemplateRecord(baseTemplate, { name: "酒馆旧版", description: "旧描述" });
const v2Template: WorldTemplate = { ...structuredClone(baseTemplate), templateVersion: 2, items: [{ id: "sword", name: "长剑", price: 35 }] };
const v2 = createWorldTemplateRecord(v2Template, { name: "酒馆旧版", description: "旧描述" });
const targetTemplate: WorldTemplate = { ...structuredClone(baseTemplate), templateVersion: 3, items: [{ id: "sword", name: "长剑", price: 40 }] };
const target = createWorldTemplateRecord(targetTemplate, { name: "酒馆买剑", description: "新描述" });
const activeSnapshot = createInitialWorldSnapshot(base);
const v2Snapshot = createInitialWorldSnapshot(v2);
const assistant = { name: "掌柜", is_user: false, is_system: false, send_date: "2026-11-01T00:00:00.000Z", mes: "掌柜抬起眼。" };
const nestedUser = {
  name: "旅人", is_user: true, is_system: false, send_date: "2026-11-01T00:00:01.000Z", mes: "我要那把剑。",
  extra: { _pitavernBeforeTurn: { metadata: { _pitavernWorld: v2Snapshot } } },
};
const user = {
  name: "旅人", is_user: true, is_system: false, send_date: "2026-11-01T00:00:02.000Z", mes: "买一把剑。",
  extra: {
    _pitavernBeforeTurn: { metadata: { _pitavernWorld: activeSnapshot } },
    _pitavernReplies: { selected: 0, versions: [
      { state: { _pitavernWorld: v2Snapshot }, messages: [assistant], continuation: [JSON.stringify(nestedUser)] },
      { state: { _pitavernWorld: activeSnapshot }, messages: [assistant] },
    ] },
  },
};
const assistantWithSwipe = {
  ...assistant, extra: { messageId: "assistant-1" },
  swipe_info: [{ extra: { _pitavernWorld: v2Snapshot } }],
};
const source = [
  JSON.stringify({ user_name: "旅人", character_name: "掌柜", chat_metadata: {
    [WORLD_STATE_KEY]: activeSnapshot,
    [WORLD_TEMPLATES_KEY]: { [base.contentHash]: base, [v2.contentHash]: v2 },
  } }),
  JSON.stringify(user),
  JSON.stringify(assistantWithSwipe),
].join("\n") + "\n";

let checks = 0;
function check(label: string): void { checks += 1; console.log("✓ " + label); }
const sourceBefore = createHash("sha256").update(source).digest("hex");
const plan = planChatWorldMigration(source, target);
assert.equal(plan.applyable, true);
assert.equal(plan.noop, false);
assert.equal(plan.hasWorld, true);
assert.equal(plan.counts.blocked, 0);
assert.ok(plan.counts.migrated >= 5, JSON.stringify(plan.counts));
assert.ok(plan.locations.some((location) => location.kind === "active"));
assert.ok(plan.locations.some((location) => location.kind === "checkpoint"));
assert.ok(plan.locations.some((location) => location.kind === "candidate"));
assert.ok(plan.locations.some((location) => location.kind === "native"));
assert.ok(plan.locations.some((location) => location.kind === "continuation"));
assert.ok(plan.locations.every((location) => location.status === "migrated"));
assert.ok(plan.nextSource);
assert.equal(createHash("sha256").update(source).digest("hex"), sourceBefore, "纯规划不能修改源字符串");
const reparsed = JSON.parse(plan.nextSource!.split("\n")[0]);
assert.equal(reparsed.chat_metadata[WORLD_TEMPLATES_KEY][target.contentHash].name, "酒馆买剑");
assert.ok(reparsed.chat_metadata[WORLD_TEMPLATES_KEY][base.contentHash], "旧模板记录保留");
assert.equal(reparsed.chat_metadata[WORLD_TEMPLATES_KEY][base.contentHash].name, "酒馆旧版");
const nextMessages = plan.nextSource!.split("\n").filter(Boolean).slice(1).map((line) => JSON.parse(line));
for (const line of nextMessages) {
  const raw = JSON.stringify(line);
  if (raw.includes(WORLD_STATE_KEY)) assert.ok(raw.includes(target.contentHash), "每个迁移后的快照都使用目标 hash");
}
assert.ok(plan.previewHash.match(/^[\da-f]{64}$/));
const repeated = planChatWorldMigration(source, target);
assert.equal(repeated.previewHash, plan.previewHash, "同样输入的计划哈希稳定");
const targetOther = createWorldTemplateRecord(targetTemplate, { name: "酒馆买剑", description: "另一个描述" });
assert.notEqual(planChatWorldMigration(source, targetOther).previewHash, plan.previewHash, "目标描述变化必须改变 previewHash");
check("活动世界、回合检查点、候选、原生 swipe、隐藏 continuation 全部迁移");

// 隐藏 continuation 中任一坏快照必须阻断整份计划，且不产生 nextSource。
const badNested = { ...nestedUser, extra: { _pitavernBeforeTurn: { metadata: { _pitavernWorld: { ...v2Snapshot, rulesVersion: 999 } } } } };
const badUser = structuredClone(user);
badUser.extra._pitavernReplies.versions[0].continuation = [JSON.stringify(badNested)];
const badSource = [source.split("\n")[0], JSON.stringify(badUser), JSON.stringify(assistantWithSwipe)].join("\n") + "\n";
const badPlan = planChatWorldMigration(badSource, target);
assert.equal(badPlan.applyable, false);
assert.equal(badPlan.nextSource, undefined);
assert.equal(badPlan.counts.blocked, 1);
assert.ok(badPlan.blocking[0]!.path.includes("continuation[0]"));
assert.ok(badPlan.blocking[0]!.blocking.some((change) => change.detail?.includes("源世界只读")));
check("隐藏分支坏快照阻断整份计划，不返回部分结果");

// 混合模板 ID 阻断；无世界状态不初始化、只计数。
const otherTemplate = { ...structuredClone(baseTemplate), templateId: "other-world", templateVersion: 4 };
const other = createWorldTemplateRecord(otherTemplate, { name: "异模板" });
const mixedVersion = structuredClone(user);
mixedVersion.extra._pitavernReplies.versions[0].state = { _pitavernWorld: createInitialWorldSnapshot(other) };
const mixedSource = [JSON.stringify({ user_name: "旅人", character_name: "掌柜", chat_metadata: {
  [WORLD_STATE_KEY]: activeSnapshot, [WORLD_TEMPLATES_KEY]: { [base.contentHash]: base, [v2.contentHash]: v2, [other.contentHash]: other },
} }), JSON.stringify(mixedVersion), JSON.stringify(assistantWithSwipe)].join("\n") + "\n";
const mixedPlan = planChatWorldMigration(mixedSource, target);
assert.equal(mixedPlan.applyable, false);
assert.ok(mixedPlan.blocking.some((location) => location.blocking.some((change) => change.label === "模板 ID")));
const noWorldVersion = structuredClone(user);
(noWorldVersion.extra._pitavernReplies.versions[1] as { state?: unknown }).state = {};
const noWorldPlan = planChatWorldMigration([source.split("\n")[0], JSON.stringify(noWorldVersion), JSON.stringify(assistantWithSwipe)].join("\n") + "\n", target);
assert.ok(noWorldPlan.counts.noWorld >= 1);
assert.ok(noWorldPlan.nextSource?.includes(target.contentHash));
check("异模板阻断；无世界候选不凭空初始化");

// 同一模板的两个源版本分别使用自己的记录；源记录缺失则阻断。
const missingSource = [JSON.stringify({ user_name: "旅人", character_name: "掌柜", chat_metadata: {
  [WORLD_STATE_KEY]: activeSnapshot, [WORLD_TEMPLATES_KEY]: { [base.contentHash]: base },
} }), JSON.stringify(user), JSON.stringify(assistantWithSwipe)].join("\n") + "\n";
const missingPlan = planChatWorldMigration(missingSource, target);
assert.equal(missingPlan.applyable, false);
assert.ok(missingPlan.blocking.some((location) => location.blocking.some((change) => change.detail?.includes("源模板记录不存在"))));
check("缺失源模板记录阻断；同模板版本按各自记录规划");

// 写入目标记录不能修复后续候选缺失/损坏的源记录；候选顺序不影响判断。
for (const corrupt of [false, true]) {
  for (const reverse of [false, true]) {
    const table = {
      [base.contentHash]: base,
      ...(corrupt ? { [target.contentHash]: { ...target, template: { ...target.template, items: [] } } } : {}),
    };
    const versions = [
      { state: { [WORLD_STATE_KEY]: activeSnapshot }, messages: [assistant] },
      { state: { [WORLD_STATE_KEY]: createInitialWorldSnapshot(target) }, messages: [assistant] },
    ];
    if (reverse) versions.reverse();
    const invalidSource = [
      { user_name: "旅人", chat_metadata: { [WORLD_STATE_KEY]: activeSnapshot, [WORLD_TEMPLATES_KEY]: table } },
      { ...user, extra: { _pitavernReplies: { selected: 0, versions } } },
    ].map((line) => JSON.stringify(line)).join("\n") + "\n";
    const invalidPlan = planChatWorldMigration(invalidSource, target);
    assert.equal(invalidPlan.applyable, false, `损坏=${corrupt}，反序=${reverse}`);
    assert.equal(invalidPlan.counts.blocked, 1);
    assert.equal(invalidPlan.nextSource, undefined);
    assert.equal(invalidPlan.blocking[0]!.sourceHash, target.contentHash);
    assert.equal(invalidPlan.blocking[0]!.kind, "candidate");
  }
}
check("缺失/损坏的目标同哈希源记录始终阻断，不受活动世界写入及候选顺序影响");

// 同哈希元数据更新也必须让每个候选读取原始源记录。
const renamed = createWorldTemplateRecord(baseTemplate, { name: "新名称", description: "新描述" });
const metadataSource = [
  { user_name: "旅人", chat_metadata: { [WORLD_STATE_KEY]: activeSnapshot, [WORLD_TEMPLATES_KEY]: { [base.contentHash]: base } } },
  { ...user, extra: { _pitavernReplies: { selected: 0, versions: [
    { state: { [WORLD_STATE_KEY]: activeSnapshot }, messages: [assistant] },
    { state: { [WORLD_STATE_KEY]: activeSnapshot, [WORLD_TEMPLATES_KEY]: { [base.contentHash]: base } }, messages: [assistant] },
  ] } } },
].map((line) => JSON.stringify(line)).join("\n") + "\n";
const renamedPlan = planChatWorldMigration(metadataSource, renamed);
assert.equal(renamedPlan.applyable, true);
assert.equal(renamedPlan.counts.migrated, 3);
assert.ok(renamedPlan.locations.every((location) => location.sourceName === base.name));
assert.ok(renamedPlan.locations.every((location) => location.changes.some((change) => change.entity === "template")));
assert.equal(planChatWorldMigration(renamedPlan.nextSource!, renamed).noop, true);
check("同哈希名称/描述迁移使用各自原始记录，所有候选均报告差异，再次规划为 no-op");

// 无 world 的聊天不返回可应用计划。
const noWorld = [JSON.stringify({ user_name: "旅人", character_name: "掌柜", chat_metadata: {} }), JSON.stringify({ ...assistant, extra: {} })].join("\n") + "\n";
const noWorldChat = planChatWorldMigration(noWorld, target);
assert.equal(noWorldChat.hasWorld, false);
assert.equal(noWorldChat.applyable, false);
assert.equal(noWorldChat.nextSource, undefined);
check("没有世界的聊天不初始化，不可应用");

// 嵌套深度预算：超限明确失败，不返回部分计划。用对象 nesting，避免测试构造时字符串指数膨胀。
let nested: Record<string, unknown> = { name: "旅人", is_user: true, is_system: false, mes: "底层", send_date: "", extra: {} };
for (let index = 0; index < 70; index++) {
  nested = {
    name: "旅人", is_user: true, is_system: false, mes: "第" + index + "层", send_date: "",
    extra: { _pitavernReplies: { selected: 0, versions: [{ messages: [nested], continuation: [] }] } },
  };
}
const deepSource = [JSON.stringify({ user_name: "旅人", character_name: "掌柜", chat_metadata: {} }), JSON.stringify(nested)].join("\n") + "\n";
assert.throws(() => planChatWorldMigration(deepSource, target), WorldChatMigrationLimitError);
check("嵌套深度超限明确失败");


console.log("\n" + checks + " 项检查全部通过。");
