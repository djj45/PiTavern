import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { WorldTemplate } from "@pitavern/shared/world";
import { createTavernTools } from "../src/agent/tools/index.ts";
import type { ToolContext } from "../src/agent/tools/context.ts";
import { ChatStore } from "../src/stdata/chats.ts";
import { worldDigest } from "../src/world/digest.ts";
import { WorldTransaction } from "../src/world/index.ts";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const template: WorldTemplate = {
  schemaVersion: 1, templateId: "tool-tavern", templateVersion: 1, rulesVersion: 1,
  locations: [{ id: "tavern", name: "酒馆" }],
  actors: [{ id: "player", name: "旅人" }, { id: "merchant", name: "掌柜" }],
  items: [{ id: "sword", name: "长剑", price: 10 }],
  initial: { actorId: "player", locationId: "tavern", money: 20, inventory: [{ ownerId: "merchant", itemId: "sword", quantity: 2 }] },
};

function fixture(readOnly = false, input = template) {
  fs.mkdirSync(path.join(ROOT, "data/test-runs"), { recursive: true });
  const root = fs.mkdtempSync(path.join(ROOT, "data/test-runs/world-tools-"));
  const store = new ChatStore(path.join(root, "st"));
  const chat = store.createChat("工具向导", null);
  store.initializeWorld(chat.id, input);
  const state = store.readWorld(chat.id, readOnly ? { mode: "read-only", reason: "测试只读" } : { mode: "enabled" })!;
  const transaction = new WorldTransaction(state, 1);
  const ctx: ToolContext = {
    chatId: chat.id, lines: [], worldEntries: [], variables: {}, skillsDir: "",
    substitute: (text) => text,
    enforcement: { turn: 1, usedThisTurn: 0, cooldownUntilTurn: 0 },
    maxRecallsPerTurn: 6, recallCooldownTurns: 10,
    world: { state, transaction },
    worldDigest: worldDigest(transaction.snapshot, state.template, state.capability),
  };
  return { store, chat, state, transaction, ctx };
}

function content(result: any): string {
  return result.content.map((item: any) => item.type === "text" ? item.text : "").join("");
}

test("世界 Digest 只注入摘要，并标明只读模式", () => {
  const { transaction, state } = fixture();
  const digest = worldDigest(transaction.snapshot, state.template, state.capability);
  assert.match(digest, /酒馆/);
  assert.match(digest, /旅人/);
  assert.match(digest, /金钱：20/);
  assert.doesNotMatch(digest, /revision/);
  const readOnly = fixture(true);
  const readOnlyDigest = worldDigest(readOnly.transaction.snapshot, readOnly.state.template, readOnly.state.capability);
  assert.match(readOnlyDigest, /世界为只读模式（测试只读）/);
  assert.match(readOnlyDigest, /金钱：20/);
  assert.match(readOnlyDigest, /world_query/);
  assert.match(readOnlyDigest, /不能执行 world_command/);
  const noTools = worldDigest(readOnly.transaction.snapshot, readOnly.state.template, readOnly.state.capability, { toolsAvailable: false });
  assert.doesNotMatch(noTools, /world_query|world_command/);
  assert.match(noTools, /没有可用的世界工具/);

  // 角色和地点可以使用相同 ID；Digest 必须按实体类型取名字。
  const collisionTemplate: WorldTemplate = {
    ...template,
    locations: [{ id: "player", name: "同名地点" }],
    initial: { ...template.initial, locationId: "player" },
  };
  const collision = fixture(false, collisionTemplate);
  const collisionDigest = worldDigest(collision.transaction.snapshot, collision.state.template, collision.state.capability);
  assert.match(collisionDigest, /地点：同名地点/);
  assert.match(collisionDigest, /在场：掌柜、旅人/);
});

test("world_query 返回按场景/库存查询的权威状态", async () => {
  const { ctx } = fixture();
  const query = createTavernTools(ctx).find((tool) => tool.name === "world_query");
  assert.ok(query);
  const summary = content(await query.execute("q1", { section: "summary" }));
  assert.match(summary, /金钱：20/);
  assert.match(summary, /随身物品：无/);
  const all = content(await query.execute("q2", { section: "all" }));
  assert.match(all, /掌柜：长剑×2/);
});

test("world_command 暂存购买，重复/非法命令不重复应用", async () => {
  const { ctx, transaction } = fixture();
  const tools = createTavernTools(ctx);
  const command = tools.find((tool) => tool.name === "world_command");
  assert.ok(command);
  const result = content(await command.execute("c1", {
    commandId: "buy-tool-1", type: "purchase_item", buyerId: "player", sellerId: "merchant", itemId: "sword", quantity: 1,
  }));
  assert.match(result, /已暂存/);
  const snapshot = transaction.snapshot;
  assert.equal(snapshot.money.player, 10);
  assert.equal(snapshot.inventory.find((entry) => entry.ownerId === "player")?.quantity, 1);
  const conflict = await command.execute("c2", {
    commandId: "buy-tool-1", type: "purchase_item", buyerId: "player", sellerId: "merchant", itemId: "sword", quantity: 2,
  });
  assert.equal(conflict.isError, true);
  assert.match(content(conflict), /COMMAND_CONFLICT/);
  const invalid = await command.execute("c3", {
    commandId: "buy-tool-2", type: "purchase_item", buyerId: "player", sellerId: "merchant", itemId: "missing", quantity: 1,
  });
  assert.equal(invalid.isError, true);
  assert.match(content(invalid), /UNKNOWN_ITEM/);
  const events = content(await tools.find((tool) => tool.name === "world_query")!.execute("q-events", { section: "events" }));
  assert.match(events, /旅人 花费 10 向 掌柜 购买 1 件长剑/);
});

test("只读世界只暴露 world_query，不暴露 world_command", async () => {
  const { ctx } = fixture(true);
  const tools = createTavernTools(ctx);
  const names = tools.map((tool) => tool.name);
  assert.ok(names.includes("world_query"));
  assert.ok(!names.includes("world_command"));
  const summary = content(await tools.find((tool) => tool.name === "world_query")!.execute("q-readonly", { section: "summary" }));
  assert.match(summary, /只读/);
  assert.match(summary, /金钱：20/);
});
