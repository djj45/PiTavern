/**
 * 前后端共用的 ST 正则管线。未标 only 的脚本分别作用于提示词与显示副本，存档保留原文。
 */
import { substituteMacros, type MacroEnv } from "./macros.ts";

export const RegexPlacement = {
  DISPLAY: 0,
  USER_INPUT: 1,
  AI_OUTPUT: 2,
  SLASH_COMMAND: 3,
  WORLD_INFO: 5,
  REASONING: 6,
} as const;

/** ST regex script（预设 extensions.regex_scripts 或 data/regex/*.json） */
export interface RegexScript {
  id?: string;
  scriptName?: string;
  /** "/pattern/flags" 或裸 pattern */
  findRegex: string;
  replaceString: string;
  placement: number[];
  disabled?: boolean;
  /** 仅显示层（提示词侧跳过） */
  markdownOnly?: boolean;
  /** 仅提示词层 */
  promptOnly?: boolean;
  minDepth?: number | null;
  maxDepth?: number | null;
  substituteRegex?: number;
  trimStrings?: string[];
}

const FIND_RE = /^\/(.+)\/([a-z]*)$/s;

export function parseFindRegex(spec: string): RegExp | null {
  const match = FIND_RE.exec(spec);
  try {
    return match ? new RegExp(match[1], match[2]) : new RegExp(spec);
  } catch {
    return null;
  }
}

export interface RegexContext {
  placement: number;
  /** 距最新消息的深度（0=最新一条）；null=不限 */
  depth: number | null;
  layer?: "prompt" | "display";
  env?: MacroEnv;
}

/** 导入数据只接受完整脚本，避免一个损坏条目阻断聊天同步。 */
export function normalizeRegexScripts(raw: unknown): RegexScript[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((script): script is RegexScript => script && typeof script === "object" &&
    typeof script.findRegex === "string" && typeof script.replaceString === "string" && Array.isArray(script.placement));
}

function escapeRegexValue(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
}

/** 对单段文本按序应用所有命中的脚本 */
export function applyRegex(text: string, scripts: RegexScript[], ctx: RegexContext): string {
  if (!text) return text;
  let result = text;
  for (const script of scripts) {
    if (script.disabled) continue;
    const display = ctx.layer === "display";
    if (display ? script.promptOnly && !script.markdownOnly : script.markdownOnly && !script.promptOnly) continue;
    if (!Array.isArray(script.placement) || !(script.placement.includes(ctx.placement) ||
      (display && ctx.placement !== RegexPlacement.REASONING && script.placement.includes(RegexPlacement.DISPLAY)))) continue;
    if (ctx.depth !== null) {
      if (script.minDepth != null && script.minDepth >= 0 && ctx.depth < script.minDepth) continue;
      if (script.maxDepth != null && script.maxDepth >= 0 && ctx.depth > script.maxDepth) continue;
    }
    // 渲染、预算与诊断都不能写聊天变量。
    const env = ctx.env && { ...ctx.env, readOnly: true };
    const substitute = (value: string) => env ? substituteMacros(value, env) : value;
    let pattern = script.findRegex;
    if (Number(script.substituteRegex) === 1) pattern = substitute(pattern);
    if (Number(script.substituteRegex) === 2) pattern = pattern.replace(/\{\{[^{}]+\}\}/g, (macro) => escapeRegexValue(substitute(macro)));
    const regex = parseFindRegex(pattern);
    if (!regex) continue;
    try {
      result = result.replace(regex, (...args: unknown[]) => {
        const groups = typeof args.at(-1) === "object" ? args.at(-1) as Record<string, string> : undefined;
        const captures = args.slice(0, args.length - (groups ? 3 : 2));
        const trims = Array.isArray(script.trimStrings) ? script.trimStrings.filter((s) => typeof s === "string").map(substitute) : [];
        const replacement = script.replaceString.replace(/\{\{match\}\}/gi, "$0")
          .replace(/\$(\d+)|\$<([^>]+)>|\$&/g, (token, index: string | undefined, name: string | undefined) => {
            let value = String(name ? groups?.[name] ?? "" : captures[token === "$&" ? 0 : Number(index)] ?? "");
            for (const trim of trims) if (trim) value = value.replaceAll(trim, "");
            return value;
          });
        return substitute(replacement);
      });
    } catch {
      // 单个脚本失败不影响整体管线
    }
  }
  return result;
}
