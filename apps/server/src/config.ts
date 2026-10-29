import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_DIALOGUE_PAIRS, type ChatAppearanceDto, type InstructTemplate, type ReasoningLevel, type TokenizerSetting, type VectorSettings, type WorldInfoSettings } from "@pitavern/shared";
import { atomicWrite } from "./stdata/files.ts";

/** 单个中转/供应商下的模型条目（用户在设置里手填，M1 不做目录自动发现） */
export interface ProviderModelConfig {
  id: string;
  name: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  tokenizer?: TokenizerSetting;
  /** 该模型默认思考强度；未设置时回退到全局 thinkingLevel。 */
  thinkingLevel?: ReasoningLevel;
}

/** OpenAI 兼容中转或官方 API 的连接配置 */
export interface ProviderConfig {
  id: string;
  name: string;
  /** 形如 https://host/v1 */
  baseUrl: string;
  apiKey?: string;
  apiType?: "chat" | "text";
  instruct?: InstructTemplate;
  models: ProviderModelConfig[];
}

export interface WorldInfoConfig extends WorldInfoSettings {
  /** 扫描最近 N 条消息（ST world_info_depth） */
  scanDepth: number;
  /** 递归步数（ST world_info_max_recursion_steps） */
  recursionSteps: number;
  caseSensitive: boolean;
  matchWholeWords: boolean;
}

export interface CompressionConfig {
  enabled: boolean;
  /** 尾部保留全文的轮数（一轮 = 用户+剧情） */
  keepFullTurns: number;
}

export interface TakeoverConfig {
  /** 历史保留全文的最近轮数；更早的靠 tavern_recall_history 召回 */
  recentTurns: number;
  /** 状态投影（tavern_set_state 工具 + 每轮回注 system） */
  stateProjection: boolean;
}

export interface BranchConfig {
  /** 每次正常回复成功后自动追加的额外候选数；0 关闭，上限 4 */
  autoGenerate: number;
}

export interface TavernConfig {
  port: number;
  /** SillyTavern 兼容数据目录（characters/ chats/ worlds/ OpenAI Settings/） */
  stDataDir: string;
  providers: ProviderConfig[];
  defaultProvider: string;
  defaultModel: string;
  persona: { name: string; description: string };
  /** 推理模型的思考强度（仅对 reasoning 模型生效） */
  thinkingLevel: ReasoningLevel;
  /** simple=内置简洁组装；bridge=ST 预设桥接组装；takeover=agent 原生接管组装 */
  contextMode: "simple" | "bridge" | "takeover";
  /** 桥接模式使用的预设（文件名，OpenAI Settings/ 下） */
  activePreset: string;
  /** 桥接模式额外启用的全局世界书（worlds/ 下的文件名） */
  activeWorlds: string[];
  worldInfo: WorldInfoConfig;
  vectors: VectorSettings;
  /** 酒馆工具四件套（worldbook_search/recall/variables/skill） */
  toolsEnabled: boolean;
  /** native=纯文本流式；game_tool=强制工具调用防截断（game_content + tavern_think） */
  outputProtocol: "native" | "game_tool";
  /** game_tool 下向中转透传 tool_choice=required（不兼容的中转可关） */
  protocolStrict: boolean;
  compression: CompressionConfig;
  takeover: TakeoverConfig;
  branches: BranchConfig;
  appearance: ChatAppearanceDto;
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
    worldInfo: { scanDepth: 2, recursionSteps: 0, caseSensitive: false, matchWholeWords: true, useGroupScoring: false, minActivations: 0, minActivationsDepthMax: 0, budgetTokens: 0 },
    vectors: { enabled: false, providerId: "", model: "", queryMessages: 2, maxEntries: 5, scoreThreshold: 0.3 },
    toolsEnabled: true,
    outputProtocol: "native",
    protocolStrict: true,
    compression: { enabled: true, keepFullTurns: 6 },
    takeover: { recentTurns: 3, stateProjection: true },
    branches: { autoGenerate: 0 },
    appearance: { speechColor: "", dialogueColor: "", dialoguePairs: DEFAULT_DIALOGUE_PAIRS.map((pair) => ({ ...pair })) },
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
    vectors: { ...defaults.vectors, ...raw.vectors },
    compression: { ...defaults.compression, ...raw.compression },
    takeover: { ...defaults.takeover, ...raw.takeover },
    branches: { ...defaults.branches, ...raw.branches },
    appearance: {
      ...defaults.appearance,
      ...(raw.appearance ?? {}),
      dialoguePairs: Array.isArray(raw.appearance?.dialoguePairs)
        ? raw.appearance.dialoguePairs.map((pair) => ({
            open: String(pair?.open ?? ""),
            close: String(pair?.close ?? ""),
            ...(typeof pair?.color === "string" ? { color: pair.color } : {}),
          }))
        : defaults.appearance.dialoguePairs,
    },
  };
}

export function saveConfig(config: TavernConfig): void {
  atomicWrite(resolveDataPath(CONFIG_PATH), `${JSON.stringify(config, null, 2)}\n`);
}

/** 在 stDataDir 下播种 ST 兼容目录结构 */
export function seedDataDirs(stDataDir: string): void {
  for (const dir of ["characters", "chats", "worlds", "OpenAI Settings", "skills"]) {
    fs.mkdirSync(path.join(stDataDir, dir), { recursive: true });
  }
}
