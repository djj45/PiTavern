import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolContext } from "./context.ts";
import { createWorldbookSearchTool } from "./worldbook-search.ts";
import { createRecallHistoryTool } from "./recall-history.ts";
import { createReadVariablesTool } from "./read-variables.ts";
import { createReadSkillReferenceTool } from "./read-skill-reference.ts";
import { createWorldTools } from "./world.ts";

/** 酒馆工具（参数规格照抄 dsh-tavern 请求快照）；世界工具仅在 M3 初始化后追加。 */
export function createTavernTools(ctx: ToolContext): AgentTool<any>[] {
  return [
    createWorldbookSearchTool(ctx),
    createRecallHistoryTool(ctx),
    createReadVariablesTool(ctx),
    createReadSkillReferenceTool(ctx),
    ...createWorldTools(ctx),
  ];
}

export type { ToolContext, RecallEnforcement } from "./context.ts";
