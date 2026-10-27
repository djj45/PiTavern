import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ToolContext } from "./context.ts";

function text(t: string): AgentToolResult["content"] {
  return [{ type: "text", text: t }];
}

/**
 * tavern_set_state —— 接管模式的状态投影（M5）：
 * 模型每轮结算现场快照（人物/地点/关键物品与变化），覆盖写入 chat_metadata.projection，
 * 下一轮组装时回注 system 的 projection section（新快照自然取代旧快照）。
 */
export function createSetStateTool(ctx: ToolContext): AgentTool<ReturnType<typeof buildParameters>> {
  const parameters = buildParameters();
  return {
    name: "tavern_set_state",
    label: "状态投影",
    description:
      "更新现场状态投影（人物、地点、关键物品与最新变化的简洁快照，不超过 150 字）。这是存档的权威状态，下一轮会作为【现场·主要人物状态】注入；剧情推进导致状态变化时必须调用更新。仅本轮调用一次即可。",
    parameters,
    execute: async (_id, params) => {
      const state = params.state.trim();
      if (!state) {
        return { content: text("状态不能为空。"), details: { summary: "空状态被拒" }, isError: true };
      }
      if (!ctx.setState) {
        return { content: text("当前模式未启用状态投影。"), details: { summary: "模式未启用" }, isError: true };
      }
      ctx.setState(state.slice(0, 2000));
      return {
        content: text("（状态投影已更新，下一轮生效）"),
        details: { summary: `更新投影 ${state.length} 字`, projection: state.slice(0, 80) },
      };
    },
  };
}

function buildParameters() {
  return Type.Object({
    state: Type.String({ description: "现场状态快照：主要人物及其状态、所在地点、关键物品与最新变化" }),
  });
}
