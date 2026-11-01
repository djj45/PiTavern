/**
 * PiTavern World Engine v0.1 契约（M0）。
 *
 * 这是共享类型层，尚不接入 Runtime；M0 先锁定字段名、持久化边界和命令语义。
 */

export const WORLD_SCHEMA_VERSION = 1 as const;
/** 世界快照在 chat_metadata、候选 state 和回合检查点中统一使用这个键。 */
export const WORLD_STATE_KEY = "_pitavernWorld";
/** 聊天内随 JSONL 保存的不可变模板版本表：contentHash -> template。 */
export const WORLD_TEMPLATES_KEY = "_pitavernWorldTemplates";
export const WORLD_MAX_MONEY = 1_000_000_000_000;
export const WORLD_MAX_ITEM_QUANTITY = 1_000_000;
/** 简单时钟总分钟上限，防止整数溢出。 */
export const WORLD_MAX_CLOCK_MINUTES = 525_600_000;
/** 单份快照保留的审计事件数量上限；不等于整个 JSONL 的总体积上限。 */
export const WORLD_MAX_RECENT_EVENTS = 100;

export interface WorldLocationDefinition {
  id: string;
  name: string;
  description?: string;
}

export interface WorldActorDefinition {
  id: string;
  name: string;
  description?: string;
}

export interface WorldItemDefinition {
  id: string;
  name: string;
  description?: string;
  /** 模板固定价格；购买规则不从模型参数读取价格。 */
  price: number;
}

export interface WorldInventoryEntry {
  ownerId: string;
  itemId: string;
  quantity: number;
}

export interface WorldInitialState {
  actorId: string;
  locationId: string;
  money: number;
  inventory: WorldInventoryEntry[];
  knowledge?: WorldInitialKnowledge[];
  actorMoney?: Array<{actorId: string; money: number}>;
}

export interface WorldTemplate {
  schemaVersion: 1 | 2 | 3;
  templateId: string;
  templateVersion: number;
  rulesVersion: number;
  locations: WorldLocationDefinition[];
  actors: WorldActorDefinition[];
  items: WorldItemDefinition[];
  initial: WorldInitialState;
  facts?: WorldFactDefinition[];
  interactions?: WorldInteractionDefinition[];
  quests?: WorldQuestDefinition[];
}

/** 模板内容哈希是模板身份；模板更新产生新记录，不覆盖旧记录。 */
export interface WorldTemplateRecord {
  contentHash: string;
  template: WorldTemplate;
  /** 模板库显示名；不参与内容哈希。 */
  name?: string;
  /** 模板库描述；不参与内容哈希。 */
  description?: string;
}

export interface WorldActorState {
  id: string;
  locationId: string;
  status: "alive" | "dead" | "inactive";
}

export interface WorldScene {
  locationId: string;
  presentActorIds: string[];
}

export interface WorldEvent {
  id: string;
  commandId: string;
  turn: number;
  type: "move" | "purchase" | "transfer" | "advance_time" | "knowledge_learn" | "knowledge_publish" | "quest_accept" | "quest_advance" | "quest_complete";
  questId?: string;
  stageId?: string;
  factId?: string;
  interactionId?: string;
  actorId?: string;
  targetId?: string;
  itemId?: string;
  quantity?: number;
  moneyDelta?: number;
  worldTimeMinutes: number;
  summary: string;
}

/**
 * 权威恢复依据。快照和本轮事件一起进入一次 JSONL 提交；
 * recentEvents 只做审计，不用于重放恢复。
 */
export interface WorldSnapshot {
  schemaVersion: 1 | 2 | 3;
  revision: number;
  templateHash: string;
  templateVersion: number;
  rulesVersion: number;
  clockMinutes: number;
  scene: WorldScene;
  actors: Record<string, WorldActorState>;
  money: Record<string, number>;
  inventory: WorldInventoryEntry[];
  recentEvents: WorldEvent[];
  knowledge?: WorldKnowledgeEntry[];
  publishedFactIds?: string[];
  questStates?: WorldQuestState[];
}

/** 聊天级模板表；旧模板记录必须保留，快照才能持续执行旧规则。 */
export type WorldTemplateTable = Record<string, WorldTemplateRecord>;

export interface WorldMetadata {
  [WORLD_STATE_KEY]?: WorldSnapshot;
  [WORLD_TEMPLATES_KEY]?: WorldTemplateTable;
}

interface WorldCommandBase {
  /** 同一次生成事务内幂等；不承诺跨回合或跨重启去重。 */
  commandId: string;
}

export type WorldCommand =
  | (WorldCommandBase & { type: "move_to"; actorId: string; locationId: string })
  | (WorldCommandBase & { type: "transfer_item"; fromId: string; toId: string; itemId: string; quantity: number })
  | (WorldCommandBase & { type: "purchase_item"; buyerId: string; sellerId: string; itemId: string; quantity: number })
  | (WorldCommandBase & { type: "advance_time"; minutes: number });

export type WorldCommandErrorCode =
  | "INVALID_COMMAND"
  | "UNKNOWN_TEMPLATE"
  | "UNKNOWN_ENTITY"
  | "UNKNOWN_LOCATION"
  | "UNKNOWN_ITEM"
  | "INSUFFICIENT_FUNDS"
  | "INSUFFICIENT_QUANTITY"
  | "INVALID_QUANTITY"
  | "INVALID_AMOUNT"
  | "TIME_LIMIT"
  | "COMMAND_CONFLICT"
  | "READ_ONLY";

export interface WorldCommandError {
  code: WorldCommandErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export interface WorldCommandRejected {
  status: "rejected";
  commandId: string;
  error: WorldCommandError;
}

export interface WorldCommandStaged {
  status: "staged";
  commandId: string;
  /** 只在事务内有效；最终提交前不要把 staged 当成已发生事实。 */
  summary: string;
  event: WorldEvent;
  revision: number;
}

export type WorldCommandResult = WorldCommandStaged | WorldCommandRejected;

/**
 * 一次生成事务内的幂等收据，不持久化。
 * 相同 ID + 相同参数返回原结果；相同 ID + 不同参数返回 COMMAND_CONFLICT。
 */
export interface WorldCommandReceipt {
  commandId: string;
  argsHash: string;
  result: WorldCommandResult;
}

export type WorldEngineMode = "enabled" | "read-only" | "disabled";

/**
 * 能力矩阵：
 * - chat-completions + 工具可用：enabled
 * - text-completions（没有普通工具）：read-only（只能查看，不能由模型提交命令）
 * - 未绑定模板/模板缺失：disabled 或 read-only
 */
export interface WorldEngineCapability {
  mode: WorldEngineMode;
  reason?: string;
}

/** 世界模板选择器使用的轻量摘要；模板正文按需读取。 */

/** 已发布模板版本摘要。 */
export interface WorldTemplateVersionDto {
  contentHash: string;
  templateVersion: number;
  rulesVersion: number;
  createdAt: string;
  name: string;
  description?: string;
}

/** 模板编辑器列表项；draftDirty 表示草稿与最新发布内容不同。 */
export interface WorldTemplateLibrarySummaryDto {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  draftRevision: number;
  publishedHash?: string;
  publishedVersion?: number;
  versionCount: number;
  draftDirty: boolean;
}

/** 模板编辑器完整视图；initialSnapshot 由当前草稿生成。 */
export interface WorldTemplateEditorDto extends WorldTemplateLibrarySummaryDto {
  draft: WorldTemplate;
  published?: WorldTemplateRecord;
  versions: WorldTemplateVersionDto[];
  initialSnapshot?: WorldSnapshot;
}

export interface WorldTemplateExportDto {
  format: "pitavern-world-template";
  version: 1;
  name: string;
  description?: string;
  template: WorldTemplate;
}


export type WorldTemplateChangeEntity = "template" | "location" | "actor" | "item" | "initial" | "rules" | "fact" | "interaction" | "quest";
export type WorldTemplateChangeAction = "added" | "removed" | "modified";

/** 0.6.0 模板迁移差异；blocking 变更禁止应用。 */
export interface WorldTemplateChangeDto {
  entity: WorldTemplateChangeEntity;
  action: WorldTemplateChangeAction;
  id?: string;
  label: string;
  detail?: string;
  blocking?: boolean;
}

export interface WorldTemplateMigrationTargetDto {
  contentHash: string;
  templateId: string;
  templateVersion: number;
  rulesVersion: number;
  name?: string;
  description?: string;
}

/** 迁移预览；snapshot 仅在无阻断时给出。 */
export interface WorldTemplateMigrationPreviewDto {
  chatId: string;
  from: WorldTemplateMigrationTargetDto;
  to: WorldTemplateMigrationTargetDto;
  changes: WorldTemplateChangeDto[];
  blocking: WorldTemplateChangeDto[];
  warnings: string[];
  applyable: boolean;
  snapshotCount: number;
  previewHash: string;
  snapshot?: WorldSnapshot;
}

export interface WorldTemplateMigrationResultDto {
  revision: string;
  backupId: string;
  changes: WorldTemplateChangeDto[];
}


export type WorldChatMigrationLocationKind = "active" | "checkpoint" | "candidate" | "native" | "continuation";
export type WorldChatMigrationLocationStatus = "migrated" | "unchanged" | "blocked";

/** 整份聊天中的一个世界恢复点：活动世界、回合检查点、候选、原生 swipe 或隐藏 continuation。 */
export interface WorldChatMigrationLocationDto {
  path: string;
  kind: WorldChatMigrationLocationKind;
  label: string;
  sourceHash: string;
  sourceName?: string;
  sourceDescription?: string;
  sourceTemplateVersion: number;
  sourceRulesVersion: number;
  target: WorldTemplateMigrationTargetDto;
  status: WorldChatMigrationLocationStatus;
  changes: WorldTemplateChangeDto[];
  blocking: WorldTemplateChangeDto[];
  warnings: string[];
}

export interface WorldChatMigrationCountsDto {
  worlds: number;
  migrated: number;
  unchanged: number;
  blocked: number;
  noWorld: number;
}

/** 全聊天迁移预览；previewHash 绑定 sourceHash、目标元数据和每个位置的计划。 */
export interface WorldChatMigrationPreviewDto {
  chatId: string;
  revision: string;
  sourceHash: string;
  target: WorldTemplateMigrationTargetDto;
  locations: WorldChatMigrationLocationDto[];
  counts: WorldChatMigrationCountsDto;
  blocking: WorldChatMigrationLocationDto[];
  warnings: string[];
  applyable: boolean;
  noop: boolean;
  previewHash: string;
}

export interface WorldChatMigrationResultDto {
  revision: string;
  backupId?: string;
  target: WorldTemplateMigrationTargetDto;
  counts: WorldChatMigrationCountsDto;
  previewHash: string;
  noop?: boolean;
}

export interface WorldTemplateSummaryDto {
  id: string;
  name: string;
  description?: string;
  templateVersion: number;
  rulesVersion: number;
  contentHash: string;
  locations: number;
  actors: number;
  items: number;
  /** builtin=内置只读模板；library=模板库最新已发布版本。 */
  source?: "builtin" | "library";
}

/** ChatSnapshotDto.world：当前聊天的世界视图；快照损坏时只带 error 和只读能力。 */
export interface WorldChatStateDto {
  snapshot?: WorldModelSnapshot;
  template?: WorldTemplate;
  templateName: string;
  capability: WorldEngineCapability;
  error?: string;
}

/** 0.8.0: v2 only; v1 remains strictly readable without these fields. */
export interface WorldFactDefinition { id: string; text: string; visibility: "public" | "restricted"; description?: string }
export interface WorldInitialKnowledge { actorId: string; factId: string }
export interface WorldKnowledgeSource { type: "initial" | "interaction"; turn: number; interactionId?: string; fromActorId?: string }
export interface WorldKnowledgeEntry extends WorldInitialKnowledge { source: WorldKnowledgeSource }
export type WorldInteractionCondition =
  | { type: "at_location"; locationId: string }
  | { type: "npc_present"; actorId: string }
  | { type: "has_item"; itemId: string; quantity: number }
  | { type: "knows_fact"; actorId: string; factId: string };
export type WorldInteractionEffect =
  | { type: "learn"; actorId: string; factId: string; fromActorId?: string }
  | { type: "publish"; factId: string };
export interface WorldInteractionDefinition { id: string; name: string; description?: string; conditions: WorldInteractionCondition[]; effects: WorldInteractionEffect[] }
export interface WorldKnownFact { id: string; text: string; source: WorldKnowledgeSource | {type: "public"; turn: number} }
/** Model DTO: never add complete knowledge relations or template rules here. */
export interface WorldModelSnapshot extends Omit<WorldSnapshot, "knowledge" | "publishedFactIds" | "questStates"> {
  viewpointId: string;
  knowledgeKey: string;
  knownFacts: WorldKnownFact[];
  publicInteractions: Array<{id: string; name: string}>;
  questKey?: string;
  quests?: WorldQuestView[];
}
export interface WorldInteractionResult { status: "staged" | "unchanged" | "rejected"; summary: string; revision: number; knownFacts?: WorldKnownFact[] }

export interface WorldQuestStage { id: string; objective: string; conditions: WorldInteractionCondition[]; delivery?: {toActorId: string; itemId: string; quantity: number} }
export interface WorldQuestDefinition { id: string; name: string; description?: string; openConditions: WorldInteractionCondition[]; stages: WorldQuestStage[]; reward: {fromActorId: string; money: number; items: Array<{itemId: string; quantity: number}>} }
export interface WorldQuestState { questId: string; status: "active" | "completed"; acceptedTurn: number; completedStages: Array<{stageId: string; turn: number}>; completedTurn?: number }
export interface WorldQuestView { id: string; name: string; status: "available" | "active" | "completed"; currentStage?: {id: string; objective: string}; completedStages: Array<{id: string; objective: string; turn: number}> }
export interface WorldQuestResult { status: "staged" | "unchanged" | "rejected"; summary: string; revision: number; quests?: WorldQuestView[] }
