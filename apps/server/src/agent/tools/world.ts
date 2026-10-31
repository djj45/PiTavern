import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { WorldCommand } from "@pitavern/shared/world";
import type { ToolContext } from "./context.ts";
import { worldStateText } from "../../world/digest.ts";

function text(t: string): AgentToolResult["content"] {
  return [{ type: "text", text: t }];
}

const section = Type.Union([
  Type.Literal("summary"), Type.Literal("actors"), Type.Literal("inventory"), Type.Literal("events"),
  Type.Literal("catalog"), Type.Literal("all"),
]);

export function buildWorldQueryParameters() {
  return Type.Object({
    section: Type.Optional(section),
  });
}

export function createWorldQueryTool(ctx: ToolContext): AgentTool<ReturnType<typeof buildWorldQueryParameters>> {
  const parameters = buildWorldQueryParameters();
  return {
    name: "world_query",
    label: "世界状态",
    description:
      "查询当前世界的权威状态：时间、地点、在场人物、金钱、库存、最近事件；summary/catalog/all 同时返回角色、地点、物品的显示名与命令 ID、物品固定价格，便于 world_command。只读，不修改世界。精确账本、命令 ID 或跨轮变化必须查询，不要仅凭叙事猜测硬状态。",
    parameters,
    execute: async (_id, params) => {
      if (!ctx.world) return { content: text("当前聊天没有启用世界状态。"), details: { summary: "世界未启用" }, isError: true };
      const state = ctx.world.state;
      const snapshot = ctx.world.transaction.snapshot;
      const sectionName = params.section ?? "summary";
      const capability = state.capability;
      return {
        content: text(worldStateText(snapshot, state.template, sectionName, capability)),
        details: { summary: `world_query ${sectionName}`, revision: snapshot.revision, mode: capability.mode },
      };
    },
  };
}

export function buildWorldCommandParameters() {
  return Type.Object({
    commandId: Type.String({ minLength: 1, maxLength: 128, description: "本轮唯一命令 ID；同 ID 不同参数会被拒绝" }),
    type: Type.Union([Type.Literal("move_to"), Type.Literal("transfer_item"), Type.Literal("purchase_item"), Type.Literal("advance_time")]),
    actorId: Type.Optional(Type.String({ description: "move_to：移动的角色 ID" })),
    locationId: Type.Optional(Type.String({ description: "move_to：目标地点 ID" })),
    fromId: Type.Optional(Type.String({ description: "transfer_item：转出角色 ID" })),
    toId: Type.Optional(Type.String({ description: "transfer_item：接收角色 ID" })),
    buyerId: Type.Optional(Type.String({ description: "purchase_item：买家 ID" })),
    sellerId: Type.Optional(Type.String({ description: "purchase_item：卖家 ID" })),
    itemId: Type.Optional(Type.String({ description: "物品 ID" })),
    quantity: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000, description: "数量，正整数" })),
    minutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 525_600_000, description: "advance_time：推进分钟数" })),
  }, { additionalProperties: false });
}

export function createWorldCommandTool(ctx: ToolContext): AgentTool<ReturnType<typeof buildWorldCommandParameters>> {
  const parameters = buildWorldCommandParameters();
  return {
    name: "world_command",
    label: "世界命令",
    description:
      "提交世界硬状态命令：move_to / transfer_item / purchase_item / advance_time。先查询再提交；价格由模板决定，不接受定价参数。返回 staged 只表示本轮暂存，整轮成功后才提交，失败或停止会撤销。涉及金钱、物品、位置或时间变化时，必须先调用本工具再叙述结果。",
    parameters,
    execute: async (_id, params) => {
      if (!ctx.world) return { content: text("当前聊天没有启用世界状态。"), details: { summary: "世界未启用" }, isError: true };
      if (ctx.world.state.capability.mode !== "enabled") {
        return { content: text("世界当前只读，不能执行命令。"), details: { summary: "世界只读" }, isError: true };
      }
      const base = { commandId: params.commandId };
      let command: WorldCommand;
      switch (params.type) {
        case "move_to":
          command = { ...base, type: params.type, actorId: params.actorId ?? "", locationId: params.locationId ?? "" };
          break;
        case "transfer_item":
          command = { ...base, type: params.type, fromId: params.fromId ?? "", toId: params.toId ?? "", itemId: params.itemId ?? "", quantity: params.quantity ?? 0 };
          break;
        case "purchase_item":
          command = { ...base, type: params.type, buyerId: params.buyerId ?? "", sellerId: params.sellerId ?? "", itemId: params.itemId ?? "", quantity: params.quantity ?? 0 };
          break;
        case "advance_time":
          command = { ...base, type: params.type, minutes: params.minutes ?? 0 };
          break;
      }
      const result = ctx.world.transaction.execute(command);
      if (result.status === "rejected") {
        return {
          content: text(`世界命令被拒绝 [${result.error.code}]：${result.error.message}\n世界状态没有变化。`),
          details: { summary: `命令被拒 ${result.error.code}`, error: result.error },
          isError: true,
        };
      }
      return {
        content: text(`世界命令已暂存，本轮成功结束后才提交；失败/停止会撤销。\n${result.summary}\n当前暂存 revision：${result.revision}`),
        details: { summary: result.summary, commandId: result.commandId, event: result.event, revision: result.revision },
      };
    },
  };
}

export function createWorldTools(ctx: ToolContext): AgentTool<any>[] {
  if (!ctx.world) return [];
  const mode = ctx.world.state.capability.mode;
  if (mode === "enabled") return [createWorldQueryTool(ctx), createWorldCommandTool(ctx)];
  return mode === "read-only" ? [createWorldQueryTool(ctx)] : [];
}
