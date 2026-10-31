# World Engine v0.1（M0 契约）

状态：M0 语义锁定；M1 纯状态/固定规则/内存事务、M2 聊天生命周期、M3 Agent 工具与 World Digest 均已实现。尚未包含世界 UI 和旧聊天中途绑定。

目标：先证明**世界硬状态在生成、失败、停止、重生成、分支切换、重启和恢复备份之间始终正确**，首个场景固定为「酒馆买剑」。

## 1. 范围

### 第一版纳入

- 世界模板：地点、角色、物品、固定价格、初始金钱/位置/库存。
- 世界快照：时钟、当前位置、角色状态、金钱、库存。
- 固定规则包：查询、移动、转移物品、购买物品、推进时间。
- 事务：命令先暂存，整轮成功才提交。
- 生命周期：发送、失败、停止、重生成、分支切换、重启、备份恢复。
- 新聊天初始化世界模板。
- 世界模板/当前状态/本轮事件 UI。

### 第一版不纳入

- 关系图、知识/秘密、任务、NPC 意图、日程、自主世界推进。
- 完整事件重放或旁路事件库。
- 世界状态与普通聊天变量自动双向同步。
- 编辑正文后自动重算世界。
- 旧聊天中途绑定模板、手工修正世界、模板热更新。
- 文本补全模型的世界命令能力。

## 2. 字段命名与恢复键

统一使用以下字段，不再使用 `state.world`：

- `chat_metadata._pitavernWorld`：当前权威快照。
- `chat_metadata._pitavernWorldTemplates`：聊天内不可变模板版本表，`contentHash -> { contentHash, template }`。
- 分支候选 `state` 和用户消息 `_pitavernBeforeTurn` 中同样使用 `_pitavernWorld`；不转换字段名。
- 回合状态键集中为：

```ts
const TURN_STATE_KEYS = [
  "variables",
  "projection",
  "timedWorldInfo",
  "_pitavernEnforcement",
  "_pitavernWorld",
] as const;
```

`stateFields`、`restoreState`、候选状态、重生成检查点和分支切换都使用这一份列表。

## 3. 持久化与提交

- 快照负责恢复，事件负责解释变化；第一版不承诺事件重放。
- 本轮事件（最多 100 条）和快照一起写入聊天 JSONL 的同一字段。
- 不建立独立世界事件文件；避免跨文件写无法整体原子提交。
- 一次成功回合只执行一次聊天文件替换，包含：
  - 助手回复；
  - 世界快照；
  - 本轮事件；
  - 变量/投影/计时；
  - 回合前检查点；
  - 候选状态。
- 失败、停止、空正文：丢弃 WorldTransaction，不写世界快照或事件。
- 并发校验同时使用聊天文件 revision 和世界 revision；世界 revision 只用于诊断和状态比较，不能单独承担文件并发检查。

## 4. 命令与幂等

命令：`move_to`、`transfer_item`、`purchase_item`、`advance_time`。查询走只读 API。

幂等保证**仅限一次生成事务**：

- 事务内保存 `commandId -> 参数摘要 + 原始结果`。
- 相同 ID、相同参数：返回第一次的 staged 结果，不重复应用。
- 相同 ID、不同参数：返回 `COMMAND_CONFLICT`。
- 跨回合、跨重启不承诺去重；事件中的 commandId 只用于审计。
- 持久化快照不保存 `recentCommandIds`。

每条命令在**事务工作副本**上应用；校验失败时工作副本不能留下部分变化。金额、数量、时钟使用安全整数和显式上限。

## 5. 模板不可变与缺失处理

- 模板内容哈希是版本身份。
- 新模板版本生成新记录，旧记录不覆盖；聊天内保存完整模板表。
- 快照只引用 `templateHash/templateVersion/rulesVersion`，不复制整份模板到每个检查点。
- 聊天 JSONL 携带模板表，因此单文件导出/备份恢复后仍可执行。
- 模板记录缺失、规则版本未知或哈希不匹配时：进入**只读世界模式**；允许查看快照，禁止执行/模型提交世界命令，不静默套用新版模板。
- 整库备份包含 JSONL 中的模板表；不依赖独立模板目录。

## 6. 编辑、重生成和分支

### 文本编辑

- 只改 `mes`，不重算世界。
- 世界启用时，编辑历史只移除后续的普通变量/投影等失效字段，**保留 `_pitavernWorld` 和候选的既有世界状态**。
- 不整体删除候选 `state`；按 `TURN_STATE_KEYS` 逐字段清理，世界字段显式保留。
- 若用户编辑了涉及硬事实的文字，界面提示“世界状态不会根据文字重算”。

### 重生成

- 新候选从该用户回合前的 `_pitavernBeforeTurn` 世界检查点开始。
- 新命令只进入新事务。
- 成功：旧候选保留自己的世界快照/事件，新候选成为当前；不删除旧候选。
- 失败/停止：旧正文、世界快照、事件和候选完全保留。
- 提交前同时校验聊天文件 revision。

### 分支

- 每条分支候选的 `state` 保存独立世界快照和本轮事件审计。
- 切换分支恢复该分支世界、变量、投影、计时和召回检查点。
- 分支切换失败不修改当前世界。

## 7. 初始化、修正和旧聊天

第一版只支持**新聊天时选择世界模板**：

- 模板在创建聊天时校验并生成初始快照。
- 模板表和初始快照随聊天创建一次性写入。
- 旧聊天没有世界字段 → 世界引擎关闭，行为完全不变。
- 旧聊天中途绑定模板 → 延后，不在 v0.1。
- 手工修正世界 → 延后，不在 v0.1；普通编辑不会修改世界。

这几项都不影响“世界状态生命周期”主闭环；推迟可减少分支语义分叉。

## 8. 数值和能力边界

- 金钱、物品数量、时间必须是安全整数；加法/乘法/时间推进前检查上限和溢出。
- 任一命令失败，暂存副本无部分变化。
- 模型能力：
  - chat-completions 且有普通工具：enabled。
  - text-completions（没有普通工具）：read-only；“不增加独立后台模型调用”不等于不增加工具往返模型请求。
  - 无模板/模板缺失/规则版本未知：read-only 或 disabled。
- 单份快照最多 100 条事件；检查点/候选各自复制快照，因此这不代表整个 JSONL 体积有界。

## 9. 第一阶段实施顺序

1. **M0：本文档 + 共享类型/常量 + 评审。**
2. **M1：纯 WorldState/规则/事务，不接聊天。**
3. **M2：先接 ChatStore/SessionManager，用直接事务集成测试跑通完整生命周期；暂不接 Agent/UI。**
4. **M3：`world_query` / `world_command` 工具、World Digest、模型能力限制（已实现）。**
5. **M4：新聊天模板选择/编辑 UI、当前世界状态与本轮事件面板、只读提示、旧聊天初始化/世界修正入口。**
6. **M5：浏览器/备份/重启验收与文档。**

## 10. 验收补充

除买剑主场景外，固定增加：

- 相同命令 ID、不同参数被拒绝。
- 一条命令成功、后一条失败，失败命令没有部分修改。
- 已成功回合重生成失败，原正文、世界、事件全部保留。
- 编辑历史文字后，切分支、重生成、重启，世界恢复仍正确。
- 模板缺失/版本未知时进入只读；JSONL 单独导入后旧世界可查看或明确只读。
- 文本补全模型不能提交世界命令，但不能破坏只读查看。

## 11. 关键产品承诺

> Runtime 保证世界账本一致；不承诺模型自由文本永不与账本矛盾。

后续版本再扩展知识、关系、任务、NPC 意图、日程和模拟规则。

## 12. M1 纯引擎接口

入口为 `apps/server/src/world/index.ts`，不读取配置、不读写聊天文件、不调用模型。

- `createWorldTemplateRecord(input)`：校验模板，生成不可变版本记录。内容哈希采用 SHA-256；递归按对象键排序、保留数组顺序的 JSON 为输入，字段顺序不影响身份。
- `createInitialWorldSnapshot(record)`：校验记录哈希和已支持的规则版本，创建 revision 0、时钟 0 的快照。
- `new WorldState(snapshot, templates, capability?)`：校验快照及模板引用，解析能力模式；模板缺失、内容/版本不匹配、规则未知或引用不一致时只读。快照自身结构损坏则抛出 `WorldValidationError`，不猜测修复。
- `state.snapshot` / `state.template` / `state.capability`：返回独立副本，只读查看不会暴露引擎内部对象。
- `new WorldTransaction(state, turn)`：从状态创建工作副本；`turn` 必须为非负安全整数。
- `transaction.execute(command)`：严格校验命令，不接受价格或其他额外字段。每条命令在独立副本上结算，成功才更新事务工作副本。
- `transaction.snapshot` / `transaction.receipts`：返回暂存状态和收据的独立副本。
- `transaction.commit()`：结束内存事务并返回独立快照，**不修改原 WorldState、不写文件**。M2 负责校验聊天 revision 后，将该结果与正文一起提交。
- `transaction.discard()`：丢弃全部暂存修改和收据，结束事务。结束后不再接受命令或重复提交。

### 固定规则版本 1

- 所有声明角色初始为 alive，位于 `initial.locationId`；仅 `initial.actorId` 获得初始金额，其他角色余额为 0；初始库存按 ownerId 明确归属。
- 库存每个 `(ownerId, itemId)` 只有一条正数记录；数量清零时移除记录。不同角色可各自持有同种物品。
- 购买和转移要求双方是已声明、alive 且同地点的不同角色；价格固定来自模板。购买同时给卖家入账，金钱和物品总量守恒，固定零价格允许。
- 移动可到任意已声明地点，不消耗时间；v0.1 无路径或移动耗时配置。当前场景跟随玩家位置，在场列表由角色位置派生，inactive 不列入在场，dead 可在场但不能行动。
- 推进时间只增加总分钟，不执行日程或后台模拟。所有数值均采用共享常量的上限；乘法/加法在修改状态前校验。
- 每条新成功命令使世界 revision 加 1 并产生一条事件；拒绝和重复调用不改变 revision。
- `recentEvents` 保存当前分支最近最多 100 条成功事件；事件 ID 为 UUID。其裁剪不影响事务内收据。
- 结构合法的命令无论 staged 或 rejected 都保留原收据；相同 ID 的不同参数返回冲突。结构不合法且 ID 尚未使用的输入只报错，不占用收据。收据从不进入持久化快照。
- 只读/禁用模式可以读取快照，命令返回 READ_ONLY；模型与工具能力的具体判定由 M3 调用方提供，M1 不接供应商配置。

### M1 验证

`npm run verify:world-engine` 使用纯合成数据运行单元测试，已加入 `verify:ci`。覆盖模板和快照校验、内容哈希、只读降级、固定交易规则、数值边界、单命令原子性、事务隔离、幂等、事件裁剪及 JSON 往返。

真实聊天的失败/停止/重生成/分支/备份生命周期已由 M2 接入；JSON 往返测试不代替存储集成验收。

## 13. M2 聊天生命周期接入

M2 已把纯世界引擎接入聊天存储边界；M2 本身不接 Agent 工具和 UI，工具层由 M3 接入。

### ChatStore

- `initializeWorld(chatId, template, expectedRevision?)`：只允许没有用户发言的新聊天；一次性写入 `_pitavernWorldTemplates` 和初始 `_pitavernWorld`。
- `readWorld(chatId, capability?)`：从当前聊天元数据加载快照和模板；模板缺失/版本异常由 `WorldState` 降级只读；未启用返回 null。
- `beginWorldTransaction(chatId, turn, capability?)`：读取当前世界并创建事务，供 M3 的 Agent 工具和集成测试使用。
- 初始化不会中途绑定旧聊天；文本编辑、普通分支切换和备份恢复不重新初始化世界。

### 状态生命周期

- `STATE_KEYS` 增加 `_pitavernWorld`；`stateFields` / `restoreState` 自动复制/恢复世界。
- 用户回合 `_pitavernBeforeTurn.metadata` 自动包含世界；分支候选 `state` 自动包含世界。
- 重生成从回合前快照恢复世界。
- 文本编辑清理旧变量、投影等失效字段时，保留世界快照和候选世界恢复点。
- 模板表在聊天 JSONL 头部保存；分支候选只复制快照，不复制模板表。
- 世界快照通过现有单次 JSONL 替换和回复一起提交；M3 的 Agent 工具会在同一个 `WorldTransaction` 中暂存命令。

### SessionManager

- 每轮生成开始时从恢复后的聊天元数据创建 `WorldTransaction`；文本补全（无普通工具）能力固定为 read-only。
- 生成成功时把事务快照放入 `pendingMetadata._pitavernWorld`，随后和回复、变量、投影一起提交。
- 失败、停止、空正文和重生成失败不提交事务；已有候选保留。
- M3 已复用 `session.worldTransaction`，不另建世界提交路径。

### M2 验证

M2 阶段加入 6 项生命周期测试；当前 `npm run verify:world-engine` 同时运行 M1 纯规则、M2 生命周期和 M3 工具测试，共 52 项：

- 初始化、重启、模板持久化；
- 禁止已有用户发言后中途初始化；
- 回合提交、候选切换和重启后各自世界快照；
- 事务丢弃不改变聊天；
- 文本编辑后切分支仍能恢复世界；
- 备份恢复保留世界和模板。

M2 不包含 Agent 工具、World Digest、模板选择 UI、当前状态面板和世界修正入口；Agent 工具与 Digest 在 M3，UI 和修正入口在 M4。

## 14. M3 Agent 工具与 World Digest（当前）

M3 把世界事务接到 Agent 工具层。世界仍只在聊天生成中可用，不包含 UI、旧聊天中途绑定或手工修正。

### 工具注册与能力

- `createTavernTools(ctx)` 在 `ctx.world` 存在时追加世界工具；未初始化世界时工具列表保持原来的四个，不注入 Digest。
- enabled：注册 `world_query` 和 `world_command`。
- read-only（文本补全、`toolsEnabled=false`、模板缺失/哈希或版本异常）：只注册 `world_query`；当普通工具整体关闭或文本补全没有工具时，工具列表为空，模型只能看到只读 Digest。
- disabled：不注册世界工具。
- 世界命令只在 enabled 下执行；`world_command` 自身再次检查能力，防止读路径绕过注册表。
- `world_query` 读取事务工作副本（含本轮已 staged 的命令），不是上一轮已提交快照。

### world_query

- `section`：`summary`（默认）/ `actors` / `inventory` / `events` / `all`。
- `summary`：时间、地点、在场者、玩家金钱、随身物品、最近 3 条变化；不包含 revision、命令收据或完整快照。
- 其他 section 返回权威列表；`all` 额外包含全部角色、库存和最近事件（最多 100 条）。
- 只读世界仍可查询；返回末尾会明确标注只读原因，避免模型把只读摘要当作可提交状态。

### world_command

- 命令：`move_to`、`transfer_item`、`purchase_item`、`advance_time`。
- 参数按命令类型严格校验；`additionalProperties: false`；数量、分钟、金额沿用共享上限；不接受模型定价，购买价格来自模板。
- 每条命令只在事务工作副本上结算；`staged` 不是已提交事实，返回中包含本轮暂存 revision。
- 同一事务内 `commandId` 幂等：相同 ID + 相同参数返回第一次结果；相同 ID + 不同参数返回 `COMMAND_CONFLICT`。失败命令的收据也保留，防止模型用同一 ID 重试改变意图；跨回合/重启不去重。
- 校验失败、余额/库存不足、未知实体等返回 `isError` 和错误码，世界状态不变。
- 工具结果只提示“已暂存”；本轮成功结束才随 JSONL 一起提交，失败/停止/空正文/重生成失败由 M2 的 `discard()` 撤销。

### World Digest

- 内容仅：当前时间、地点、在场者、玩家金钱、随身物品、最近 3 条变化；不含完整快照、revision、模板表或收据。
- simple 模式拼在 system prompt 末尾；bridge / takeover 作为尾部 system 消息追加；三种模式都不改变各模式原有历史组装。
- 群聊每个发言者开始前从同一事务工作副本重新生成 Digest，前一位角色 staged 的命令会进入下一位的摘要。
- 模板名称用于角色/地点/物品；角色与地点同 ID 时按实体类型分别取名。事件摘要优先用结构化字段和模板名称重排，旧存档只有原始 summary 时回退。
- 只读世界明确写“世界为只读模式（原因）”，并根据是否还有工具，分别提示只能用 `world_query` 或只能依据摘要叙述。
- simple 模式的工具指引按能力区分 enabled / read-only；桥接模式仍由预设自行约定，但 Digest 本身的能力提示一致。
- Digest 只包含摘要，不承诺完整事件解释；精确查询走 `world_query`。

### 能力矩阵

| 场景 | 能力 | 世界工具 | Digest |
| --- | --- | --- | --- |
| 未初始化世界 | 关闭 | 无 | 不注入 |
| chat-completions + `toolsEnabled=true`，模板有效 | enabled | world_query、world_command | 完整，提示可提交命令 |
| `toolsEnabled=false` | read-only | 无（普通工具整体关闭） | 只读、无工具提示 |
| text-completions | read-only | 无（文本补全没有普通工具） | 只读、无工具提示 |
| 模板缺失/哈希或版本异常 | read-only | 仅 world_query（若普通工具可用） | 带只读原因；不提示 world_command |
| takeover | 取决于模型与工具开关 | 同上；文本补全不允许 takeover | 同对应行 |
| bridge | 取决于模型与工具开关 | 同上 | 同对应行 |

“只读时只暴露 world_query”指普通工具仍可用、但世界降级只读；`toolsEnabled=false` 或文本补全时整个工具列表为空，因此不会有任何世界工具。

### 事务与失败

- 每轮生成仍只有一个 `WorldTransaction`，所有世界工具共享；不新建第二条提交路径。
- 生成成功：`pendingMetadata._pitavernWorld = worldTransaction.commit()`，与回复、变量、投影、计时和候选状态一次 JSONL 提交。
- 失败、停止、空正文、重生成失败：`finally` 中 `discard()`；旧分支/旧候选世界完全保留。
- 分支候选保存各自快照；文本编辑不重算世界；模板热更新不在 M3。

### 测试与验收

`npm run verify:world-engine` 共 52 项：

- M1 纯规则/校验 42 项（含 14 个生成式非法模板用例）；
- M2 聊天生命周期 6 项；
- M3 工具与 Digest 4 项：只注入摘要且区分只读/无工具、角色与地点同 ID 取名、world_query 分节查询、world_command staged/幂等/非法命令、只读只暴露 world_query。

M3 还要求 `npm run verify:branches` 通过；浏览器与离线 CI 使用 `npm run verify:browser` / `npm run verify:ci` 在外部终端验收，日志写入 `data/test-runs/`。

M3 不包含：模板选择/编辑 UI、当前世界状态与本轮事件面板、只读状态提示 UI、旧聊天中途绑定、手工修正世界入口、文本补全世界命令、脚本内世界工具。这些留到 M4/M5。
