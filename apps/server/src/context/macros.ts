/**
 * ST 宏引擎核心集（对照 public/scripts/macros/definitions/）。
 * 未识别的宏保持原样，与 ST 的宽松行为一致。
 */

export interface MacroEnv {
  char: string;
  user: string;
  personaDescription?: string;
  /** {{getvar}} 的变量源 */
  variables?: Record<string, unknown>;
  lastUserMessage?: string;
}

const MACRO_RE = /\{\{([\w_]+)((?:::|:)[^}]*)?\}\}/gi;
/** {{// 注释}} 整块删除；{{trim}} 连同周围空白删除（ST 语义） */
const COMMENT_RE = /\{\{\/\/[\s\S]*?\}\}/g;
const TRIM_RE = /[ \t]*\{\{trim\}\}[ \t]*\n?/gi;

function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

function splitArgs(raw: string | undefined, separator: "::" | ":"): string[] {
  if (!raw) return [];
  return raw.split(separator).map((s) => s.trim()).filter((s) => s.length > 0);
}

function varToString(value: unknown): string {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** {{roll:2d6+3}} / {{roll:d20}} / {{roll:1d10-1}} */
function rollDice(spec: string): string {
  const match = /^(\d*)d(\d+)([+-]\d+)?$/i.exec(spec);
  if (!match) return "";
  const count = Math.min(Number(match[1] || 1), 100);
  const sides = Number(match[2]);
  const modifier = Number(match[3] || 0);
  if (sides <= 0) return "";
  let total = modifier;
  for (let i = 0; i < count; i++) total += 1 + Math.floor(Math.random() * sides);
  return String(total);
}

export function substituteMacros(text: string, env: MacroEnv): string {
  if (!text.includes("{{")) return text;
  let result = text.replace(COMMENT_RE, "").replace(TRIM_RE, "");
  result = result.replace(MACRO_RE, (whole, nameRaw: string, argsRaw?: string) => {
    const name = nameRaw.toLowerCase();
    // {{name::a::b}} 与 {{name:a,b}} 两种参数风格，取匹配到的一种
    const args = argsRaw?.startsWith("::")
      ? splitArgs(argsRaw, "::")
      : argsRaw?.startsWith(":")
        ? splitArgs(argsRaw, ":")
        : [];

    switch (name) {
      case "char":
        return env.char;
      case "user":
        return env.user;
      case "persona":
        return env.personaDescription ?? "";
      case "lastusermessage":
        return env.lastUserMessage ?? "";
      case "random":
        return args.length ? args[Math.floor(Math.random() * args.length)] : "";
      case "pick":
        // 确定性随机：同 key 同输入稳定输出（ST 的 {{pick:name:...}} 语义）
        if (args.length >= 2) return String(args[hashString(args[0] + env.char + env.user) % args.length]);
        return args[0] ?? "";
      case "roll":
        return rollDice(args[0] ?? "");
      case "getvar": {
        const key = args[0] ?? "";
        return varToString(env.variables?.[key]);
      }
      case "getvardefault": {
        const key = args[0] ?? "";
        const value = env.variables?.[key];
        return value === undefined ? (args[1] ?? "") : varToString(value);
      }
      case "setvar":
        // 提示词层的 setvar 只做无输出替换（真正写变量属 M3 工具层）
        return "";
      case "time":
        return new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
      case "date":
        return new Date().toLocaleDateString("zh-CN");
      case "weekday": {
        const names = ["日", "一", "二", "三", "四", "五", "六"];
        return `星期${names[new Date().getDay()]}`;
      }
      case "time_utc":
        return new Date().toISOString().slice(11, 16);
      case "date_utc":
        return new Date().toISOString().slice(0, 10);
      case "weekday_utc": {
        const names = ["日", "一", "二", "三", "四", "五", "六"];
        return `星期${names[new Date().getUTCDay()]}`;
      }
      default:
        return whole;
    }
  });
  return result;
}
