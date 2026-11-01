# 聊天导入契约（0.4.0）

状态：0.4.0 锁定。范围仅限**单个聊天 JSONL 文件**导入；角色卡、独立生成记录、供应商配置不随聊天导入。

## 1. 支持格式

接受以下 UTF-8 文本（允许 BOM，CRLF 会规范化为 LF）：

- PiTavern「导出 JSONL」直接生成的原文件：首行 JSON 头（`user_name`、`character_name`、`chat_metadata`），其后每行一条消息。头内可含 `_pitavernWorld` / `_pitavernWorldTemplates`、`_pitavernGroup`、`_pitavernReplies`、`_pitavernBeforeTurn` 等扩展。
- SillyTavern 单聊天 JSONL：同样的头 + 消息结构；支持原版 `swipes` / `swipe_id` / `swipe_info`，以及未知的 `extra` 字段。
- 无头的 JSONL：首条有效行就是消息时，导入时补一个新头（警告）。首行是对象且没有 `mes` 字段时按头处理；带 `mes` 字段（即使类型非法）一律进入消息校验，不会当成聊天头。

不接受：JSON 数组聊天、`groups/` 群组文件、非 JSONL 的 Markdown/HTML 导出、ZIP/归档。文件扩展名不参与校验，内容按 JSONL 解析。

头部只允许出现在第一个非空行。之后每个非空行都必须是消息对象；其它 JSON 值、损坏 JSON 和半截行都拒绝导入，不沿用普通聊天读取“跳过坏行”的行为。

## 2. 限制

| 项目 | 上限 |
| --- | --- |
| 文件字节数 | 32 MiB |
| 物理行数 | 200000 |
| 单行 JSON 嵌套深度 | 512 层 |
| 分支嵌套深度 | 64 层 |
| 分支候选节点总数 | 10000 |
| 单次预览返回错误 | 50 条（另给总错误数） |

超限或编码错误在文件级拒绝。消息文本本身不设额外长度上限，受文件总大小约束。

## 3. 消息结构

每条消息必须是对象：

- `name`：非空字符串。保留原文，不按关联角色改写。
- `mes`：字符串，允许空串（空回复按原标记保留）。
- `is_user` / `is_system`：缺省为 `false`；出现时必须是布尔值。
- `send_date`：出现时必须是字符串。
- `extra`：出现时必须是普通对象（非数组/null）；未知键原样保留。
- `swipes`：出现时必须是字符串数组；`swipe_id` 出现时必须是数组范围内的整数；`swipe_info` 出现时必须是对象数组，每个条目的 `extra` 按消息 `extra` 同一套规则校验（含 `thinking`/`summary`、`_pitavernBeforeTurn` 世界快照与 `_pitavernReplies` 候选）。三者用于 ST 原生候选兼容。
- `extra.messageId`：出现时必须是字符串。不要求唯一（当前活动候选与其 `_pitavernReplies` 目录中的选中版本会共享同一 ID）。
- `extra.thinking` / `extra.summary`：出现时必须是字符串。
- `extra._pitavernBeforeTurn`：出现时必须是对象；`metadata` 出现时必须是对象。
- `extra._pitavernReplies`：出现时按第 4 节递归校验。

未知字段（消息、`extra`、头、`chat_metadata`）全部保留。只有下列头字段会被写入方改写：`character_name`（关联角色）、`chat_metadata._pitavernTitle`（唯一标题）、`chat_metadata._pitavernImport`（导入来源）；无头时新增头。其余键值不丢失。

## 4. 分支与隐藏 continuation

`extra._pitavernReplies` 必须是：

```ts
{ selected: number, versions: Array<{
  branchId?: string;
  messages: StChatLine[];      // 非 user、非 system，至少 1 条
  state?: Record<string, unknown>;
  statePruned?: boolean;
  enforcement?: { turn: number; usedThisTurn: number; cooldownUntilTurn: number };
  continuation?: string[];     // 每条是一个完整 JSONL 原始行的 JSON 文本
}> }
```

- `selected` 必须指向存在的候选。
- 候选消息递归走同一套消息校验，且必须是助手/系统之外的故事消息（与原版 `validReplyCatalog` 一致：`!is_user && !is_system`）。
- `continuation` 每条必须非空、是合法 JSON 文本；解析后必须是合法消息对象。嵌入的候选继续递归校验。
- `state` 中的 `_pitavernWorld` 按第 6 节校验。
- 嵌套深度超过 64、节点总数超过 10000 拒绝；同时单行 JSON 总嵌套不得超过 512 层。
- 原生 `swipes` 候选也计入 10000 节点预算：单条 `swipes` 超过上限直接拒绝；同一用户回合没有 `_pitavernReplies` 时，跨消息累计超过上限也拒绝。与 `_pitavernReplies` 同回合的 `swipes` 是活动候选副本，不重复计数。
- `swipes` 兼容路径不要求 `state`；没有世界快照的旧候选按现有“保留当前世界”语义处理。

## 5. 角色关联

- 导入必须选择一个**已存在**的角色卡；关联角色成为头的 `character_name`，用于之后的角色卡/世界书/开场白/显示配置。
- 消息行里的 `name` 不改写。角色卡缺失时预览标记；用户选择任意已有卡后仍可导入，原文发言者保持原样。
- `user_name` 原样保留；不使用当前 persona 覆盖。
- `chat_metadata._pitavernGroup` 存在时必须是有效的 2–12 人成员配置，否则拒绝（否则聊天列表/生成会持续失败）。缺失成员只警告，不阻止导入；补齐卡片前该群聊不能正常生成。
- 预览建议角色优先级：头部角色（若资料库存在）→ 群聊成员中第一个存在的角色 → 无。前端仍要求用户确认。

## 6. 世界状态

- `chat_metadata._pitavernWorld`、每个候选 `state._pitavernWorld`、每个回合 `_pitavernBeforeTurn.metadata._pitavernWorld` 都必须是结构合法的世界快照。结构损坏**拒绝导入**并定位到行/字段。
- `chat_metadata._pitavernWorldTemplates` 出现时必须是对象（哈希 → 记录）。缺失、引用记录缺失、内容哈希/版本不匹配、规则版本未知：按现有 `WorldState` 契约标为**只读**并警告，不拒绝，不静默套用新模板。
- 模板表、历史检查点、候选世界快照和隐藏 continuation 全部原样保留；导入后分支切换/重生成恢复各自版本。
- 世界快照存在但没有任何模板记录时仍可导入为只读；查看世界不受影响。

## 7. 重复、命名与原子性

- 以**原始文件字节**的 SHA-256 识别重复。通过 PiTavern 导入过的同一文件再次导入时阻止并返回已有聊天；不覆盖任何已有聊天。手工复制进 `chats/` 的文件不进入导入索引，不保证识别。
- 导入索引保存在 `<stDataDir>/.pitavern/chat-imports/index.json`，随整库备份；索引损坏时保留副本并重建，不阻止导入。
- 总是创建新聊天文件。磁盘文件名继续使用 PiTavern 时间戳格式，不使用上传文件名，避免中文/空格/路径字符问题。
- 显示标题优先保留原 `_pitavernTitle`，否则使用上传文件名（去掉 `.jsonl`）。与已有聊天重名时自动追加 ` (2)`、` (3)`……；可由用户在预览中修改。
- 校验全部通过后才写文件：先写同目录临时文件、再原子 rename；失败清理临时文件。索引写入失败时删除刚创建的聊天，不留下半成品。
- 导入的聊天没有独立生成记录，统计从导入后开始；不伪造历史用量。

## 8. 错误与预览契约

预览与导入共用同一严格解析器；导入端重新解析上传字节，不信任预览结果。

```ts
interface ChatImportIssueDto {
  code: "encoding" | "size" | "limit" | "json" | "depth" | "structure" | "metadata" | "world" | "unsafe";
  line?: number;   // 1-based JSONL 行号
  path?: string;   // 例如 chat_metadata._pitavernWorld
  message: string;
}
```

- 错误定位到物理行号；文件级错误无行号。
- 预览返回 `valid`、`issueCount` 和截断后的 `errors`；`valid=false` 时导入接口拒绝。
- 预览还返回：字节数、行数、消息/用户/系统数量、分支内隐藏消息数（候选 `versions[].messages` 与 `continuation` 消息总数，含选中候选在活动路径中的重复副本）、分叉点/候选/隐藏 continuation 数、参与角色、群聊缺失成员、世界只读原因、建议角色/标题、重复文件信息。
- 导入接口重新校验 SHA-256 与角色存在性；失败不落盘。

## 9. 明确不包含

单个聊天 JSONL 不包含：

- 角色卡 PNG/JSON 及卡内世界书（只保留聊天内引用到的模板表）；
- 独立生成记录/用量/工具活动（`.pitavern/activity/`）；
- 供应商连接、API Key、模型设置、persona、全局世界书/正则/预设；
- 聊天备份历史和导入索引之外的管理元数据。

完整迁移请使用「资料 → 备份与迁移」整库归档。

## 10. 导出语义（修正文档歧义）

- **JSONL 导出**：原样返回聊天 JSONL 文件，因此包含当前活动路径、`extra._pitavernReplies` 中未选中的候选、隐藏 continuation、变量、世界快照/模板表、群聊和分支元数据。原版酒馆通常只识别活动路径。
- **MD 导出**：只包含当前活动路径的可见消息，不包含候选、隐藏 continuation、世界模板表或生成记录。
- 两者都不包含角色卡、活动记录和供应商配置。

## 11. 验收矩阵

服务端专项（`npm run verify:chat-import`）：

- 导出 → 导入 → 隐藏分支切换 → 重生成 → 重启 → 备份恢复，逐项比较正文/变量/世界/候选。
- 损坏 JSON 行、半截行、嵌套过深、坏快照、重复导入、无头文件、中文+空格文件名、超限。
- 世界模板缺失/未知规则只读；模板表与隐藏候选原样保留。

浏览器专项：

- 导入入口 → 选文件 → 预览 → 选角色 → 导入并打开；重复和损坏文件提示。
- 390px 移动端可完成同一流程，无水平溢出。
