/** 归一化后的角色卡（来源可能是 V2/V3 PNG、charx 或导出 JSON） */
export interface CharacterCard {
  spec: string;
  name: string;
  description: string;
  personality: string;
  scenario: string;
  firstMes: string;
  mesExample: string;
  creatorNotes: string;
  systemPrompt: string;
  postHistoryInstructions: string;
  alternateGreetings: string[];
  tags: string[];
  creator: string;
  characterVersion: string;
  extensions: Record<string, unknown>;
  /** 卡片对应的 PNG 文件绝对路径（无则空串） */
  avatarFile: string;
}

/** SillyTavern 聊天记录 JSONL 单行结构 */
export interface StChatLine {
  name: string;
  is_user: boolean;
  is_system: boolean;
  send_date: string;
  mes: string;
  extra?: Record<string, unknown>;
}

/** 卡片规范 JSON 的 data 字段 */
interface RawCardData {
  name?: unknown;
  description?: unknown;
  personality?: unknown;
  scenario?: unknown;
  first_mes?: unknown;
  mes_example?: unknown;
  creator_notes?: unknown;
  system_prompt?: unknown;
  post_history_instructions?: unknown;
  alternate_greetings?: unknown;
  tags?: unknown;
  creator?: unknown;
  character_version?: unknown;
  extensions?: unknown;
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

export function normalizeCard(spec: string, data: RawCardData, avatarFile: string): CharacterCard {
  return {
    spec,
    name: str(data.name, "未命名"),
    description: str(data.description),
    personality: str(data.personality),
    scenario: str(data.scenario),
    firstMes: str(data.first_mes),
    mesExample: str(data.mes_example),
    creatorNotes: str(data.creator_notes),
    systemPrompt: str(data.system_prompt),
    postHistoryInstructions: str(data.post_history_instructions),
    alternateGreetings: strArray(data.alternate_greetings),
    tags: strArray(data.tags),
    creator: str(data.creator),
    characterVersion: str(data.character_version),
    extensions: (data.extensions as Record<string, unknown>) ?? {},
    avatarFile,
  };
}
