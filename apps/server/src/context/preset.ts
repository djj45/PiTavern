import fs from "node:fs";
import path from "node:path";

/** ST 预设（OpenAI Settings/*.json）的 prompts 条目 */
export interface StPrompt {
  identifier: string;
  name?: string;
  role: "system" | "user" | "assistant";
  content: string;
  /** main/nsfw/jailbreak 等带 system_prompt 标记的普通提示词 */
  system_prompt?: boolean;
  /** 结构占位符（chatHistory/worldInfoBefore/...） */
  marker?: boolean;
  /** 0=相对位置（按 order 排） 1=绝对深度注入 */
  injection_position?: number;
  injection_depth?: number;
  forbid_overrides?: boolean;
}

/** prompt_order 条目：character_id 100001 是全局默认档 */
export interface StPreset {
  prompts: StPrompt[];
  prompt_order: { character_id: number; order: { identifier: string; enabled: boolean }[] }[];
  // 采样与格式字段（宽松保留，桥接组装时读取）
  temperature?: number;
  top_p?: number;
  top_k?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  openai_max_tokens?: number;
  openai_max_context?: number;
  personality_format?: string;
  scenario_format?: string;
  wi_format?: string;
  squash_system_messages?: boolean;
  extensions?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface PresetMeta {
  /** 文件名（去 .json），即 ST 语义下的预设名 */
  name: string;
  promptCount: number;
  orderCount: number;
}

const PRESET_DIR_KEY = "OpenAI Settings";

export function presetsDir(stDataDir: string): string {
  return path.join(stDataDir, PRESET_DIR_KEY);
}

export function listPresets(stDataDir: string): PresetMeta[] {
  const dir = presetsDir(stDataDir);
  if (!fs.existsSync(dir)) return [];
  const metas: PresetMeta[] = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    try {
      const preset = loadPreset(path.join(dir, file));
      metas.push({
        name: file.replace(/\.json$/, ""),
        promptCount: preset.prompts?.length ?? 0,
        orderCount: resolveOrder(preset).length,
      });
    } catch {
      // 跳过损坏文件
    }
  }
  return metas;
}

export function loadPreset(file: string): StPreset {
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as StPreset;
  if (!Array.isArray(raw.prompts) || !Array.isArray(raw.prompt_order)) {
    throw new Error(`不是有效的 ST 预设: ${path.basename(file)}`);
  }
  return raw;
}

/** 取全局默认（character_id 100001）的启用顺序；缺失时回退第一个非空档 */
export function resolveOrder(preset: StPreset): { identifier: string; enabled: boolean }[] {
  const global = preset.prompt_order.find((o) => o.character_id === 100001 && o.order.length > 0);
  const fallback = preset.prompt_order.find((o) => o.order.length > 0);
  return (global ?? fallback)?.order ?? [];
}
