import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolContext } from "./context.ts";
import { createWorldbookSearchTool } from "./worldbook-search.ts";
import { createRecallHistoryTool } from "./recall-history.ts";
import { createReadVariablesTool } from "./read-variables.ts";
import { createReadSkillReferenceTool } from "./read-skill-reference.ts";

/** 酒馆工具四件套（参数规格照抄 dsh-tavern 请求快照） */
export function createTavernTools(ctx: ToolContext): AgentTool<any>[] {
  return [
    createWorldbookSearchTool(ctx),
    createRecallHistoryTool(ctx),
    createReadVariablesTool(ctx),
    createReadSkillReferenceTool(ctx),
  ];
}

export type { ToolContext, RecallEnforcement } from "./context.ts";
