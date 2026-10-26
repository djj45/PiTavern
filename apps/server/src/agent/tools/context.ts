import type { StChatLine } from "../../stdata/types.ts";
import type { WiEntry } from "../../context/worldinfo.ts";

/** 召回限次冷却的运行时强制状态（挂在 ChatSession 上，跨工具调用共享） */
export interface RecallEnforcement {
  /** 当前剧情轮次（每收到一条用户消息 +1） */
  turn: number;
  /** 本轮已用召回次数 */
  usedThisTurn: number;
  /** 完整正文召回后的冷却截止轮次（turn < 该值时禁止召回） */
  cooldownUntilTurn: number;
}

/** 每轮工具构建时的上下文（闭包捕获，当轮有效） */
export interface ToolContext {
  chatId: string;
  /** 正则前的全量消息行（含本轮用户消息） */
  lines: StChatLine[];
  /** 合并后的全部世界书条目（卡内书 + 启用世界），refId 即数组下标 */
  worldEntries: WiEntry[];
  /** chat_metadata.variables（可能是任意 JSON） */
  variables: unknown;
  /** skills 根目录（data/st/skills） */
  skillsDir: string;
  /** 宏替换函数（世界书渲染正文用） */
  substitute: (text: string) => string;
  enforcement: RecallEnforcement;
  maxRecallsPerTurn: number;
  recallCooldownTurns: number;
}

/** 为消息行标注剧情轮次：开场白=0，此后每条用户消息开启新一轮 */
export function lineTurns(lines: StChatLine[]): number[] {
  const turns: number[] = [];
  let turn = 0;
  let sawUser = false;
  for (const line of lines) {
    if (line.is_system) {
      turns.push(-1);
      continue;
    }
    if (line.is_user) {
      turn = sawUser ? turn + 1 : 1;
      sawUser = true;
    }
    turns.push(turn);
  }
  return turns;
}
