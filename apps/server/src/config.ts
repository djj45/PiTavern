import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 单个中转/供应商下的模型条目（用户在设置里手填，M1 不做目录自动发现） */
export interface ProviderModelConfig {
  id: string;
  name: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
}

/** OpenAI 兼容中转或官方 API 的连接配置 */
export interface ProviderConfig {
  id: string;
  name: string;
  /** 形如 https://host/v1 */
  baseUrl: string;
  apiKey?: string;
  models: ProviderModelConfig[];
}

export interface WorldInfoConfig {
  /** 扫描最近 N 条消息（ST world_info_depth） */
  scanDepth: number;
  /** 递归步数（ST world_info_max_recursion_steps） */
  recursionSteps: number;
  caseSensitive: boolean;
  matchWholeWords: boolean;
}

export interface TavernConfig {
  port: number;
  /** SillyTavern 兼容数据目录（characters/ chats/ worlds/ OpenAI Settings/） */
  stDataDir: string;
  providers: ProviderConfig[];
  defaultProvider: string;
  defaultModel: string;
  persona: { name: string; description: string };
  /** off | low | medium | high（仅对 reasoning 模型生效） */
  thinkingLevel: "off" | "low" | "medium" | "high";
  /** simple=内置简洁组装；bridge=ST 预设桥接组装 */
  contextMode: "simple" | "bridge";
  /** 桥接模式使用的预设（文件名，OpenAI Settings/ 下） */
  activePreset: string;
  /** 桥接模式额外启用的全局世界书（worlds/ 下的文件名） */
  activeWorlds: string[];
  worldInfo: WorldInfoConfig;
  /** 酒馆工具四件套（worldbook_search/recall/variables/skill） */
  toolsEnabled: boolean;
}

export const CONFIG_PATH = process.env.PITAVERN_CONFIG ?? "data/config.json";

/** 仓库根目录（config 里的相对路径都锚定到这里，与进程 cwd 无关） */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export function resolveDataPath(p: string): string {
  return path.isAbsolute(p) ? p : path.join(REPO_ROOT, p);
}

export function defaultConfig(): TavernConfig {
  return {
    port: 8787,
    stDataDir: "data/st",
    providers: [],
    defaultProvider: "",
    defaultModel: "",
    persona: { name: "旅人", description: "" },
    thinkingLevel: "off",
    contextMode: "simple",
    activePreset: "",
    activeWorlds: [],
    worldInfo: { scanDepth: 2, recursionSteps: 0, caseSensitive: false, matchWholeWords: true },
    toolsEnabled: true,
  };
}

export function loadConfig(): TavernConfig {
  const defaults = defaultConfig();
  if (!fs.existsSync(resolveDataPath(CONFIG_PATH))) return defaults;
  const raw = JSON.parse(fs.readFileSync(resolveDataPath(CONFIG_PATH), "utf8")) as Partial<TavernConfig>;
  return {
    ...defaults,
    ...raw,
    persona: { ...defaults.persona, ...raw.persona },
    worldInfo: { ...defaults.worldInfo, ...raw.worldInfo },
  };
}

export function saveConfig(config: TavernConfig): void {
  fs.mkdirSync(path.dirname(resolveDataPath(CONFIG_PATH)), { recursive: true });
  fs.writeFileSync(resolveDataPath(CONFIG_PATH), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

/** 在 stDataDir 下播种 ST 兼容目录结构 */
export function seedDataDirs(stDataDir: string): void {
  for (const dir of ["characters", "chats", "worlds", "OpenAI Settings", "skills"]) {
    fs.mkdirSync(path.join(stDataDir, dir), { recursive: true });
  }
}
