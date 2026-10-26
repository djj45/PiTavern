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
  };
}

export function saveConfig(config: TavernConfig): void {
  fs.mkdirSync(path.dirname(resolveDataPath(CONFIG_PATH)), { recursive: true });
  fs.writeFileSync(resolveDataPath(CONFIG_PATH), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

/** 在 stDataDir 下播种 ST 兼容目录结构 */
export function seedDataDirs(stDataDir: string): void {
  for (const dir of ["characters", "chats", "worlds", "OpenAI Settings"]) {
    fs.mkdirSync(path.join(stDataDir, dir), { recursive: true });
  }
}
