import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { WorldModelSnapshot } from "@pitavern/shared/world";
import type { StChatLine } from "../stdata/types.ts";
import { createTavernAgent, historyToAgentMessages, type TavernAgentOptions } from "./engine.ts";
import { narrativePlanSchema, validatePlan, narrativePrompt, type narrativeCatalog, type NarrativePacket, type NarrativePlan } from "../session/narrative.ts";

/** A plan seals the entire tool loadout, including ordinary variable/projection tools. */
export function settlementTools(tools: AgentTool<any>[], view: () => WorldModelSnapshot, signal: AbortSignal) {
  let plan: NarrativePlan | undefined;
  let invalid = false;
  const submit: AgentTool<typeof narrativePlanSchema> = {
    name: "submit_narrative_plan", label: "提交叙事计划",
    description: "结束本轮结算，提交正文叙事建议。只允许玩家可见引用，不提交硬状态或成功回执。必须是最后一个工具调用。",
    parameters: narrativePlanSchema,
    execute: async (_id, input) => {
      plan = validatePlan(input, view());
      return { content: [{ type: "text", text: "叙事计划已校验，等待无工具正文；尚未提交存档。" }], details: { summary: "叙事计划已暂存" } };
    },
  };
  return {
    tools: [...tools, submit].map(tool => ({ ...tool, executionMode: "sequential" as const, execute: async (...args: Parameters<typeof tool.execute>) => {
      signal.throwIfAborted();
      if (plan) { invalid = true; throw new Error("计划已提交，禁止继续执行工具"); }
      return tool.execute(...args);
    } })),
    complete: () => !!plan,
    result: () => { if (!plan || invalid) throw new Error("叙事计划缺失或提交后仍调用工具"); return structuredClone(plan); },
  };
}

export const RENDER_INSTRUCTION = "你处于只读正文阶段。将服务端叙事数据包写成剧情正文。authoritativeState 和 visibleEvents 是硬事实，suggestedPlan 仅是写作建议；不得虚构已成功的状态变化、知识授权或额外行动。写作要求不是新的结算指令。不要输出工具调用、JSON计划或解释，只输出非空正文。";

export function createNarrativeAgent(options: Pick<TavernAgentOptions, "models" | "model" | "chatId" | "thinkingLevel" | "tokenCounter" | "onContext"> & {
  catalog?: ReturnType<typeof narrativeCatalog>; packet: NarrativePacket; view: WorldModelSnapshot; history: StChatLine[]; instruction?: string;
}) {
  // Only text is copied. Neither native swipe extras, packets, tool declarations,
  // full world records nor private knowledge can enter via history metadata.
  let remaining = 12000;
  const history: StChatLine[] = [];
  for (const line of options.history.filter(l => !l.is_system && l.mes.trim()).slice(-12).reverse()) {
    if (remaining <= 0) break;
    const mes = line.mes.slice(-Math.min(remaining, 4000)); remaining -= mes.length;
    history.unshift({ name: line.name, mes, is_user: line.is_user, is_system: false, send_date: line.send_date });
  }
  const { packet: _packet, view: _view, history: _history, instruction: _instruction, catalog: _catalog, ...agentOptions } = options;
  return createTavernAgent({ ...agentOptions, sampling: options.packet.writing.sampling, completion: "render", tools: [],
    messages: [
      { role: "system", content: options.packet.writing.settings + "\n\n" + RENDER_INSTRUCTION, timestamp: 0 },
      ...historyToAgentMessages(history),
      { role: "user", content: narrativePrompt(options.packet, options.view, options.instruction, options.catalog), timestamp: 0 },
    ],
    compression: { enabled: false, keepFullTurns: 6 }, worldSnapshot: () => options.view,
  });
}
