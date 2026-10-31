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
}

export interface WorldTemplate {
  schemaVersion: 1;
  templateId: string;
  templateVersion: number;
  rulesVersion: number;
  locations: WorldLocationDefinition[];
  actors: WorldActorDefinition[];
  items: WorldItemDefinition[];
  initial: WorldInitialState;
}

/** 模板内容哈希是模板身份；模板更新产生新记录，不覆盖旧记录。 */
export interface WorldTemplateRecord {
  contentHash: string;
  template: WorldTemplate;
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
  type: "move" | "purchase" | "transfer" | "advance_time";
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
  schemaVersion: 1;
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
}

/** ChatSnapshotDto.world：当前聊天的世界视图；快照损坏时只带 error 和只读能力。 */
export interface WorldChatStateDto {
  snapshot?: WorldSnapshot;
  template?: WorldTemplate;
  templateName: string;
  capability: WorldEngineCapability;
  error?: string;
}
