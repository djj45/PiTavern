/**
 * ST 正则脚本管线的提示词侧（对照 public/scripts/extensions/regex/engine.js）。
 * M2 只实现 prompt 层：markdownOnly 的纯显示脚本跳过；promptOnly 与双向脚本生效。
 */

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
}

/** 对单段文本按序应用所有命中的脚本 */
export function applyRegex(text: string, scripts: RegexScript[], ctx: RegexContext): string {
  if (!text) return text;
  let result = text;
  for (const script of scripts) {
    if (script.disabled) continue;
    // 提示词侧：markdownOnly（且非 promptOnly）的脚本只影响显示，跳过
    if (script.markdownOnly && !script.promptOnly) continue;
    if (!Array.isArray(script.placement) || !script.placement.includes(ctx.placement)) continue;
    if (ctx.depth !== null) {
      if (script.minDepth != null && ctx.depth < script.minDepth) continue;
      if (script.maxDepth != null && ctx.depth > script.maxDepth) continue;
    }
    const regex = parseFindRegex(script.findRegex);
    if (!regex) continue;
    try {
      result = result.replace(regex, script.replaceString);
    } catch {
      // 单个脚本失败不影响整体管线
    }
  }
  return result;
}
