import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ToolContext } from "./context.ts";

function text(t: string): AgentToolResult["content"] {
  return [{ type: "text", text: t }];
}

const PAGE_SIZE = 20;
const TEXT_SEGMENT = 1600;

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(${value.length})`;
  return typeof value;
}

/** 扁平化列出对象的一层子项 */
function listLevel(obj: Record<string, unknown>): string {
  return Object.entries(obj)
    .map(([k, v]) => `${k}: ${typeName(v)}`)
    .join("\n");
}

/**
 * tavern_read_variables —— 规格照抄 dsh-tavern 快照：
 * list 顶层路径 / search 路径名搜索 / read 读值（对象只返回一层，长文本分段）。
 * 只读；写入属输出协议（M4）的职责。
 */
function buildParameters() {
  return Type.Object({
    action: Type.String({ description: "list | search | read" }),
    path: Type.Optional(Type.String({ description: "相对存档根的路径，用 . 或 / 分层" })),
    query: Type.Optional(Type.String({ description: "search 的路径名关键词" })),
    cursor: Type.Optional(Type.String({ description: "续页游标（上次结果的 nextCursor）" })),
    limit: Type.Optional(Type.Integer({ description: "每页条数，默认 20" })),
  });
}

export function createReadVariablesTool(ctx: ToolContext): AgentTool<ReturnType<typeof buildParameters>> {
  const root = (ctx.variables && typeof ctx.variables === "object" ? ctx.variables : {}) as Record<string, unknown>;

  const collectPaths = (obj: unknown, prefix: string, out: string[]): void => {
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      for (const [k, v] of Object.entries(obj)) {
        const p = prefix ? `${prefix}.${k}` : k;
        out.push(p);
        collectPaths(v, p, out);
      }
    }
  };

  return {
    name: "tavern_read_variables",
    label: "存档变量",
    description:
      "只读查询当前游玩存档变量。默认 list 仅列顶层路径和类型，每页 20 项；path 分层展开。search 按路径名搜索，结果分页；read 读取路径值，对象只返回一层，长文本分段。路径相对于存档根，不含开头的斜杠。nextCursor 非空可续读，续页保留 action/path/query；变量可能在结算后变化，如发现与剧情不一致请重新查询。仅按需查询，不修改变量。",
    parameters: buildParameters(),
    execute: async (_id, params) => {
      const action = params.action;
      const offset = Number(params.cursor ?? "0") || 0;
      const limit = Math.min(Math.max(1, params.limit ?? PAGE_SIZE), 50);

      if (action === "list") {
        const target = params.path ? navigate(root, params.path) : root;
        if (target === undefined || target === null || typeof target !== "object" || Array.isArray(target)) {
          return {
            content: text(params.path ? `路径 ${params.path} 不是可展开的对象（值：${preview(target)}）` : "存档为空。"),
            details: { summary: params.path ? `${params.path} 不可展开` : "存档为空" },
          };
        }
        const entries = Object.entries(target as Record<string, unknown>);
        const page = entries.slice(offset, offset + limit);
        const next = offset + limit < entries.length ? String(offset + limit) : null;
        return {
          content: text(
            `${params.path ? `${params.path} 下` : "顶层"}共 ${entries.length} 项（第 ${offset + 1}-${offset + page.length} 项）：\n${page.map(([k, v]) => `${k}: ${typeName(v)}`).join("\n")}` + (next ? `\nnextCursor=${next}` : ""),
          ),
          details: { summary: `list ${params.path ?? "/"}（${page.length} 项）` },
        };
      }

      if (action === "search") {
        const all: string[] = [];
        collectPaths(root, "", all);
        const q = (params.query ?? "").toLowerCase();
        const matched = all.filter((p) => p.toLowerCase().includes(q));
        const page = matched.slice(offset, offset + limit);
        const next = offset + limit < matched.length ? String(offset + limit) : null;
        return {
          content: text(
            q ? `路径含“${params.query}”的变量 ${matched.length} 条：\n${page.join("\n")}` : `全部路径 ${matched.length} 条：\n${page.join("\n")}` + (next ? `\nnextCursor=${next}` : ""),
          ),
          details: { summary: `search "${params.query}"（${page.length}/${matched.length}）` },
        };
      }

      if (action === "read") {
        if (!params.path) {
          return { content: text("read 需要 path。"), details: { summary: "参数缺失" }, isError: true };
        }
        const value = navigate(root, params.path);
        if (value === undefined) {
          return { content: text(`路径 ${params.path} 不存在。`), details: { summary: `${params.path} 不存在` }, isError: true };
        }
        if (typeof value === "string" && value.length > TEXT_SEGMENT) {
          const seg = value.slice(offset, offset + TEXT_SEGMENT);
          const next = offset + TEXT_SEGMENT < value.length ? String(offset + TEXT_SEGMENT) : null;
          return {
            content: text(`${params.path}（长文本 ${value.length} 字，第 ${offset + 1}-${offset + seg.length} 段）：\n${seg}` + (next ? `\nnextCursor=${next}` : "")),
            details: { summary: `read ${params.path}（分段）` },
          };
        }
        const body =
          value && typeof value === "object"
            ? Array.isArray(value)
              ? JSON.stringify(value, null, 1).slice(0, TEXT_SEGMENT)
              : listLevel(value as Record<string, unknown>)
            : String(value);
        return {
          content: text(`${params.path} = ${body}`),
          details: { summary: `read ${params.path}` },
        };
      }

      return { content: text(`未知 action: ${action}`), details: { summary: `未知 action ${action}` }, isError: true };
    },
  };
}

function navigate(root: Record<string, unknown>, path: string): unknown {
  let current: unknown = root;
  for (const seg of path.split(/[./]+/).filter(Boolean)) {
    if (current && typeof current === "object" && !Array.isArray(current)) {
      current = (current as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  return current;
}

function preview(value: unknown): string {
  if (value === undefined) return "(不存在)";
  return String(value).slice(0, 100);
}
