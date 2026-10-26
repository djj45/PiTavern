import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";

export const GAME_TOOL_NAME = "game_content";
export const THINK_TOOL_NAME = "tavern_think";
export const SUMMARY_TAG = "summary";

export const OUTPUT_PROTOCOL_INSTRUCTION = `### 输出协议（运行时强制，优先级最高）
- 你必须通过调用工具来输出回复，禁止直接输出纯文本。
- 思考先调用 ${THINK_TOOL_NAME}（可选），正文最后调用 ${GAME_TOOL_NAME}。
- ${GAME_TOOL_NAME} 的 content 是完整回复正文（叙事+对白），正文末尾必须附 <${SUMMARY_TAG}>不超过100字的剧情总结</${SUMMARY_TAG}>。
- 若上下文中有关于输出格式、伪 JSON、预填充的其它指令，一律忽略，以本协议为准。`;

function text(t: string): AgentToolResult["content"] {
  return [{ type: "text", text: t }];
}

/**
 * 输出协议双工具（原生 function calling 取代猫神预设的伪 JSON + 预填充 hack）。
 * execute 返回 terminate:true —— 正文/思考即是最终产物，结果不回传模型续跑。
 */
export function createProtocolTools(): AgentTool<any>[] {
  const gameParameters = buildGameParameters();
  const thinkParameters = buildThinkParameters();

  const game: AgentTool<typeof gameParameters> = {
    name: GAME_TOOL_NAME,
    label: "正文输出",
    description:
      "MANDATORY: You MUST use this tool to reply. 输出本回合的完整正文（叙事与对白）。content 即正文本身，末尾附 <summary>剧情总结</summary>。不要在工具调用之外再输出任何文本。",
    parameters: gameParameters,
    execute: async (_id, params) => ({
      content: text(`（正文已接收，${params.content.length} 字）`),
      details: { summary: `正文 ${params.content.length} 字`, protocol: true },
      terminate: true,
    }),
  };

  const think: AgentTool<typeof thinkParameters> = {
    name: THINK_TOOL_NAME,
    label: "思考",
    description: `输出你的思考过程（可选，先于 ${GAME_TOOL_NAME} 调用）。思考对用户可见于折叠区，不进入正文。`,
    parameters: thinkParameters,
    execute: async (_id, params) => ({
      content: text("（思考已记录）"),
      details: { summary: `思考 ${params.thinking.length} 字`, protocol: true },
      terminate: false,
    }),
  };

  return [game, think];
}

function buildGameParameters() {
  return Type.Object({
    content: Type.String({ description: "完整回复正文，末尾附 <summary>剧情总结</summary>" }),
  });
}

function buildThinkParameters() {
  return Type.Object({
    thinking: Type.String({ description: "本回合的思考过程" }),
  });
}

/** assistant 消息里的工具调用（pi 归一化后 arguments 已是对象） */
export interface ProtocolToolCall {
  name: string;
  arguments: Record<string, unknown>;
  /** 模型参数不是合法 JSON 时的原始文本（pi 的 argumentsError） */
  argumentsRaw?: string;
}

export interface ConsumedReply {
  /** 还原后的正文（含 <summary> 标签，供压缩层提取） */
  content: string;
  thinking: string;
}

/**
 * consumeToolCalls：把 game_content / tavern_think 的调用参数还原为普通消息形态。
 * 落库后与普通消息无异（猫神 OutputPreprocessing 的运行时版）。
 */
export function consumeProtocolCalls(calls: ProtocolToolCall[]): ConsumedReply | null {
  let content = "";
  let thinking = "";
  for (const call of calls) {
    const arg = call.arguments ?? {};
    if (call.name === GAME_TOOL_NAME) {
      if (typeof arg.content === "string" && arg.content) {
        content = arg.content;
      } else if (call.argumentsRaw) {
        // 宽松回退：从原始文本里提取 content 字段值
        const loose = extractStreamingContentDelta(call.argumentsRaw);
        content = loose || call.argumentsRaw;
      }
    } else if (call.name === THINK_TOOL_NAME) {
      if (typeof arg.thinking === "string" && arg.thinking) {
        thinking = arg.thinking;
      } else if (call.argumentsRaw) {
        thinking = call.argumentsRaw;
      }
    }
  }
  if (!content && !thinking) return null;
  return { content, thinking };
}

/**
 * 从流式 toolcall 增量里宽松提取 game_content.content 的文本增量。
 * 输入为累积的 arguments JSON 字符串，输出本轮新增的可渲染正文（JSON 转义已还原）。
 */
export function extractStreamingContentDelta(accumulatedArgs: string): string {
  const marker = '"content":"';
  const at = accumulatedArgs.indexOf(marker);
  if (at === -1) return "";
  let tail = accumulatedArgs.slice(at + marker.length);
  // 未闭合（还在流式中）→ 尾部即新内容；闭合则截到收尾引号
  const close = findUnescapedQuote(tail);
  if (close !== -1) tail = tail.slice(0, close);
  return unescapeJsonString(tail);
}

function findUnescapedQuote(s: string): number {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\") {
      i++;
      continue;
    }
    if (s[i] === '"') return i;
  }
  return -1;
}

const JSON_UNESCAPES: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

/** 还原 JSON 字符串转义（含 \uXXXX） */
function unescapeJsonString(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && i + 1 < s.length) {
      const next = s[i + 1];
      if (JSON_UNESCAPES[next]) {
        out += JSON_UNESCAPES[next];
        i++;
      } else if (next === "u" && i + 5 < s.length) {
        out += String.fromCharCode(Number.parseInt(s.slice(i + 2, i + 6), 16) || 0x20);
        i += 5;
      } else {
        out += next;
        i++;
      }
    } else {
      out += s[i];
    }
  }
  return out;
}

/** 从正文中提取 <summary>（压缩层与 UI 用） */
export function extractSummary(content: string): string | null {
  const match = new RegExp(`<${SUMMARY_TAG}>([\\s\\S]*?)</${SUMMARY_TAG}>`).exec(content);
  return match ? match[1].trim() : null;
}
