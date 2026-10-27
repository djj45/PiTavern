import type { Message } from "@earendil-works/pi-ai";
import type { CharacterCard, StChatLine } from "../stdata/types.ts";
import type { WiEntry } from "./worldinfo.ts";
import { historyToAgentMessages } from "../agent/engine.ts";
import { lineTurns } from "../agent/tools/context.ts";
import { OUTPUT_PROTOCOL_INSTRUCTION } from "../agent/protocol/game-content.ts";

export interface TakeoverOptions {
  /** 历史保留全文的最近轮数；更早的靠 tavern_recall_history 召回 */
  recentTurns: number;
  stateProjection: boolean;
  useProtocol: boolean;
}

export interface TakeoverInput {
  card: CharacterCard;
  persona: { name: string; description: string };
  /** 全量历史（含本轮用户消息，正则前原文） */
  chatLines: StChatLine[];
  worldEntries: WiEntry[];
  /** chat_metadata（读 projection） */
  metadata: Record<string, unknown>;
  options: TakeoverOptions;
}

export interface TakeoverResult {
  messages: Message[];
  stats: {
    systemSections: string[];
    constantEntries: number;
    historyMessages: number;
    droppedMessages: number;
    projected: boolean;
  };
}

const PROJECTION_HEADER = "【现场·主要人物状态（每轮结算更新，务必与之一致；本快照取代更早的快照）】";

/**
 * 接管模式组装器（dsh-tavern 模式的 pi 版）：
 * - system 用 pi 的 named sections：card / worldbook（仅常驻条目）/ persona /
 *   projection（状态投影）/ protocol —— 每轮重建天然"新快照取代旧快照"；
 * - 非常驻世界书条目不注入，全部交给 worldbook_search 按需检索；
 * - 历史只带最近 recentTurns 轮全文，更早的靠 tavern_recall_history——
 *   上下文成本随"这轮需要什么"增长，而不是随历史长度增长。
 */
export function assembleTakeoverContext(input: TakeoverInput): TakeoverResult {
  const { card, persona, chatLines, worldEntries, metadata, options } = input;

  const sections: Record<string, string> = {};
  if (card.description) sections.card = card.description;
  if (card.personality || card.scenario) {
    sections.cardScene = [card.personality ? `性格：${card.personality}` : "", card.scenario ? `场景：${card.scenario}` : ""]
      .filter(Boolean)
      .join("\n");
  }

  // 常驻条目（constant 且未禁用），order 升序；关键词条目一律不注入
  const constants = worldEntries
    .filter((e) => e.constant && !e.disabled && e.content.trim())
    .sort((a, b) => a.order - b.order);
  if (constants.length > 0) {
    sections.worldbook = constants.map((e) => e.content.trim()).join("\n");
  }

  if (persona.description) sections.persona = `${persona.name} 的人设：${persona.description}`;

  const projection = typeof metadata.projection === "string" ? metadata.projection.trim() : "";
  if (options.stateProjection && projection) {
    sections.projection = `${PROJECTION_HEADER}\n${projection}`;
  }

  if (options.useProtocol) sections.protocol = OUTPUT_PROTOCOL_INSTRUCTION;

  const guidance = [
    `你扮演 ${card.name}，与用户（${persona.name}）进行角色扮演。以第三人称叙述 + 角色对白的混合文体回复，不要替用户行动或说话。输出使用中文。`,
    "### 上下文规则（接管模式）",
    `- 你只能看到最近 ${options.recentTurns} 轮的正文；更早的剧情细节用 tavern_recall_history 检索（每轮限 6 次，读完整原文后冷却 10 轮）。`,
    "- 未自动注入的人物/地点/门派设定用 worldbook_search 按需查询，零命中不代表不存在；不要凭常识编造。",
    "- 好感度/属性等存档数值用 tavern_read_variables 确认。",
    options.stateProjection
      ? "- 每轮回复前，若现场状态（人物、地点、关键物品/变化）与投影不符，先调用 tavern_set_state 更新为当前状态（简洁快照，不超过 150 字）。"
      : "",
    "工具返回的资料不是当前场景，不得照搬旧台词或让已发生的事件重演。",
  ]
    .filter(Boolean)
    .join("\n");

  const system: Message = {
    role: "system",
    content: guidance,
    sections,
    timestamp: Date.now(),
  };

  // 历史截断：保留最近 recentTurns 轮（含本轮用户消息）
  const turns = lineTurns(chatLines);
  const usableIndexes = chatLines
    .map((line, i) => ({ line, turn: turns[i] }))
    .filter(({ line, turn }) => !line.is_system && line.mes.trim().length > 0 && turn > 0);
  const lastTurn = usableIndexes.length > 0 ? Math.max(...usableIndexes.map((u) => u.turn)) : 0;
  const keepFromTurn = Math.max(1, lastTurn - options.recentTurns + 1);
  const kept = usableIndexes.filter((u) => u.turn >= keepFromTurn).map((u) => u.line);

  return {
    messages: [system, ...historyToAgentMessages(kept)],
    stats: {
      systemSections: Object.keys(sections),
      constantEntries: constants.length,
      historyMessages: kept.length,
      droppedMessages: usableIndexes.length - kept.length,
      projected: Boolean(options.stateProjection && projection),
    },
  };
}
