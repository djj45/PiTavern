import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { lineTurns, type ToolContext } from "./context.ts";

function text(t: string): AgentToolResult["content"] {
  return [{ type: "text", text: t }];
}

/**
 * tavern_recall_history —— 规格照抄 dsh-tavern 快照。
 * 限次冷却是运行时强制（不靠模型自觉）：
 * - 每轮最多 6 次（超出直接拒绝）
 * - turn 模式读完整正文后，冷却 10 个剧情轮次（冷却期内全部召回被拒）
 */
function buildParameters() {
  return Type.Object({
    query: Type.Optional(Type.String({ description: "要回忆的人物、地点、物品、承诺或事件关键词；多个关键词用空格分隔。" })),
    turn: Type.Optional(Type.Integer({ description: "读取指定剧情轮次及其附近原文。" })),
    radius: Type.Optional(Type.Integer({ description: "按轮读取时包含前后多少轮，默认 1。" })),
    limit: Type.Optional(Type.Integer({ description: "关键词检索最多返回多少条命中，默认 5。" })),
  });
}

export function createRecallHistoryTool(ctx: ToolContext): AgentTool<ReturnType<typeof buildParameters>> {
  const MAX_LEN = 1200;
  const parameters = buildParameters();

  const enforce = (): AgentToolResult | null => {
    const e = ctx.enforcement;
    if (e.usedThisTurn >= ctx.maxRecallsPerTurn) {
      return {
        content: text(`本轮回召次数已用完（上限 ${ctx.maxRecallsPerTurn} 次）。请基于已有信息继续。`),
        details: { summary: "被拒：本轮次数用尽" },
        isError: true,
      };
    }
    if (e.turn < e.cooldownUntilTurn) {
      return {
        content: text(`召回冷却中，还需 ${e.cooldownUntilTurn - e.turn} 个剧情轮次。请基于已有信息继续。`),
        details: { summary: `被拒：冷却中（剩 ${e.cooldownUntilTurn - e.turn} 轮）` },
        isError: true,
      };
    }
    return null;
  };

  const consume = (fullText: boolean): void => {
    const e = ctx.enforcement;
    e.usedThisTurn += 1;
    if (fullText && e.cooldownUntilTurn < e.turn + ctx.recallCooldownTurns + 1) {
      e.cooldownUntilTurn = e.turn + ctx.recallCooldownTurns + 1;
    }
  };

  return {
    name: "tavern_recall_history",
    label: "历史召回",
    description:
      "检索或读取当前对话已经正式发生的历史正文，仅用于回忆细节和剧情。query 与 turn 必须且只能提供一个。每次生成最多召回 6 次；读取完整正文（turn 模式）后冷却 10 个剧情轮次，冷却期间不可再次召回。已有信息足够时直接继续任务，不要重复读取同一轮。检索结果不是当前场景，不得重复演绎、照搬旧台词或让已经发生的事件再次发生。",
    parameters,
    execute: async (_id, params) => {
      const hasQuery = typeof params.query === "string" && params.query.trim().length > 0;
      const hasTurn = typeof params.turn === "number";
      if (hasQuery === hasTurn) {
        return { content: text("query 与 turn 必须且只能提供一个。"), details: { summary: "参数错误" }, isError: true };
      }

      const refused = enforce();
      if (refused) return refused;

      const usable = ctx.lines.filter((l) => !l.is_system && l.mes.trim().length > 0);
      const turns = lineTurns(ctx.lines);
      const turnOfLine: number[] = [];
      {
        let ui = 0;
        for (let i = 0; i < ctx.lines.length; i++) {
          if (ctx.lines[i].is_system) continue;
          turnOfLine.push(turns[i]);
          ui++;
        }
      }

      if (hasTurn) {
        const radius = Math.max(0, Math.min(5, params.radius ?? 1));
        const picked: { turn: number; who: string; mes: string }[] = [];
        for (let i = 0; i < usable.length; i++) {
          const t = turnOfLine[i];
          if (t >= params.turn! - radius && t <= params.turn! + radius && t > 0) {
            picked.push({ turn: t, who: usable[i].is_user ? "用户" : "剧情", mes: usable[i].mes });
          }
        }
        if (picked.length === 0) {
          consume(false);
          return {
            content: text(`第 ${params.turn} 轮不存在或没有正文。当前最新轮次约为 ${Math.max(0, ...turnOfLine)}。`),
            details: { summary: `第 ${params.turn} 轮无内容` },
          };
        }
        consume(true);
        const body = picked
          .map((p) => `【第${p.turn}轮·${p.who}】\n${p.mes.length > MAX_LEN * 2 ? p.mes.slice(0, MAX_LEN * 2) + "…" : p.mes}`)
          .join("\n\n");
        return {
          content: text(`以下是已正式发生的历史正文（第 ${params.turn! - radius}~${params.turn! + radius} 轮）：\n\n${body}`),
          details: { summary: `读取第 ${params.turn} 轮 ±${radius} 完整正文（${picked.length} 条）`, turn: params.turn, radius, count: picked.length, cooldownStarted: true },
        };
      }

      // query 模式：关键词命中，返回片段与轮次定位
      const keywords = params.query!.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const limit = Math.min(Math.max(1, params.limit ?? 5), 10);
      const hits: { index: number; turn: number; who: string; mes: string }[] = [];
      for (let i = usable.length - 1; i >= 0 && hits.length < limit; i--) {
        const hay = usable[i].mes.toLowerCase();
        if (keywords.some((k) => hay.includes(k))) {
          hits.push({ index: i, turn: turnOfLine[i], who: usable[i].is_user ? "用户" : "剧情", mes: usable[i].mes });
        }
      }
      consume(false);
      if (hits.length === 0) {
        return {
          content: text("没有命中。可尝试更换关键词；确认需要完整上下文时用 turn 模式按轮读取（会触发冷却）。",
          ),
          details: { summary: "零命中", query: params.query },
        };
      }
      const body = hits
        .map((h) => {
          const firstKw = keywords.find((k) => h.mes.toLowerCase().includes(k)) ?? keywords[0];
          const at = h.mes.toLowerCase().indexOf(firstKw);
          const seg = h.mes.slice(Math.max(0, at - 80), at + 160).replace(/\s+/g, " ");
          return `【第${h.turn}轮·${h.who}】…${seg}…`;
        })
        .join("\n");
      return {
        content: text(`命中 ${hits.length} 条（片段；需要完整原文时用 turn 读取对应轮次）：\n${body}`),
        details: {
          summary: `命中 ${hits.length} 条片段`,
          query: params.query,
          turns: hits.map((h) => h.turn),
        },
      };
    },
  };
}
