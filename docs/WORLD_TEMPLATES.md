# World Templates 0.5.0 契约（M0/M1）

状态：0.5.0 编辑器与版本选择实现完成，待验收/发布；尚未打 0.5.0 标签。本文锁定世界模板库的存储、草稿/发布、版本选择、冲突和备份边界。0.5.0 不实现模板热更新；已有聊天继续使用自身 JSONL 内嵌的不可变模板记录，更新到新模板属于 0.6.0。

## 1. 范围

0.5.0 提供：

- 模板库列表、从内置模板复制、新建、编辑、导入、导出。
- 地点、角色、物品（固定价格）、初始玩家/地点/金额/库存表单。
- 服务端复用 `parseWorldTemplate` / `createWorldTemplateRecord` 校验，报告重复 ID、无效引用和数值越界。
- 初始世界预览。
- 草稿与已发布版本分离；发布生成新的不可变版本记录。
- 模板库纳入整库备份/恢复。
- 删除模板库中的模板不影响已有聊天。
- 编辑保存的版本冲突检查。
- 新聊天选择模板及版本选择接口。

不提供：

- 已有聊天切换到新模板版本（0.6.0 热更新）。
- 模板目录之外的模板共享/市场。
- 模板内脚本、任意 JS、关系图或世界书联动。

## 2. 存储

目录：`<stDataDir>/.pitavern/world-templates/`

    index.json
    versions/<contentHash>.json

- `index.json`：模板目录与草稿；每次保存原子替换。
- `versions/<contentHash>.json`：已发布模板记录，内容不可变；文件名即 SHA-256。
- 模板记录沿用现有契约：`{ contentHash, template, name?, description? }`；名称/描述不参与模板内容哈希。
- `index.json` 记录：schemaVersion、目录 revision、每个模板的稳定 `templateId`、显示名/描述、草稿、draftRevision、publishedHash、版本元数据。
- 模板库 `templateId` 与内置模板 ID 共用选择器命名空间；导入/保存冲突时必须分配新的库 ID，不能复用内置 ID，否则新聊天会命中内置规则。
- 所有写操作先校验，再原子写；发布先写不可变版本文件，再更新索引。索引写失败不会覆盖已有草稿/版本。

## 3. 草稿与发布

- 新建/复制/导入产生草稿；草稿可反复编辑，保存必须携带当前 `draftRevision`。
- 保存草稿：`parseWorldTemplate` 校验；模板 ID 必须与目录条目一致；`rulesVersion` 固定为当前运行时支持版本；递增 `draftRevision`。
- 发布：校验草稿；`templateVersion = 已发布最大版本 + 1`；`rulesVersion = WORLD_RULES_VERSION`；生成新的 `contentHash` 和不可变版本文件；索引更新 `publishedHash`。
- 草稿与已发布内容一致时发布不产生新版本，返回当前记录（或由 UI 禁用发布）。
- 名称/描述是发布元数据，不参与模板内容哈希。模板正文未变、仅名称/描述改变时，发布更新当前版本的元数据而不新增内容版本；新聊天使用新名称，已有聊天继续使用自己内嵌的旧名称/记录。
- `draftDirty` 同时比较发布版本的内容哈希、名称和描述；仅改名称/描述并保存后，列表显示草稿有修改。
- 最新发布摘要只使用该版本的名称/描述；版本明确没有描述时，不回退未发布草稿的描述。
- 发布不会修改任何已有聊天 JSONL；已有聊天继续使用其内嵌模板表。
- 删除模板只删除模板库条目；已有聊天内嵌记录和版本不受影响。历史版本文件可保留为孤立文件。

## 4. 版本选择

- `GET /api/world/templates`：内置模板 + 模板库每个模板的最新已发布版本摘要；未发布模板不进入新聊天选择器，但出现在编辑器列表。
- `GET /api/world/template-library/:id/versions`：完整版本列表（contentHash、templateVersion、rulesVersion、createdAt、名称快照）。
- `POST /api/chats` 增加可选 `worldTemplateHash`：按精确版本创建聊天；不传时按 `worldTemplateId` 使用最新已发布版本或内置模板。
- 新聊天初始化时把所选版本记录完整写入 `chat_metadata._pitavernWorldTemplates`；之后模板库删除/修改不影响该聊天。

## 5. 目录 API

- `GET /api/world/template-library`：编辑器摘要 + 草稿/发布状态。
- `GET /api/world/template-library/:id`：草稿、最新发布记录、版本列表、初始世界快照。
- `POST /api/world/template-library`：`{ action: "blank" | "copy", name?, description?, sourceId? }`。
- `PUT /api/world/template-library/:id`：`{ revision, name, description, template }`，版本冲突返回 409。
- `POST /api/world/template-library/:id/publish`：`{ revision }`。
- `GET /api/world/template-library/:id/export`：下载模板 JSON。
- `POST /api/world/template-library/import`：导入模板 JSON，生成草稿。
- `DELETE /api/world/template-library/:id`：删除目录模板；不影响聊天。

模板 JSON 导入/导出格式：

```json
{
  "format": "pitavern-world-template",
  "version": 1,
  "name": "我的酒馆",
  "description": "可选",
  "template": { "schemaVersion": 1, "templateId": "...", "templateVersion": 1, "rulesVersion": 1, "...": "..." }
}
```

导入时若 `templateId` 已存在或与内置模板 ID 冲突，生成新的稳定 ID，不覆盖已有模板。

## 6. 表单与预览

表单字段：

- 地点：ID、名称、描述。
- 角色：ID、名称、描述。
- 物品：ID、名称、描述、固定价格。
- 初始：玩家角色、初始地点、金额、库存（归属/物品/数量）。
- 模板显示名与描述（不进入内容哈希）。

校验失败按字段返回：重复 ID、未声明初始角色/地点、库存引用、数值越界、未知字段。预览使用 `createInitialWorldSnapshot`，展示地点/角色/物品数量、初始金钱/位置/库存和规则版本。

## 7. 冲突、备份与恢复

- 保存/发布必须携带 `draftRevision`；与当前索引不一致返回 409 并提示重新载入。
- 编辑器在新建空白、复制内置、导入或切换模板前，若存在未保存修改必须二次确认；取消后保留当前编辑内容。
- 两个窗口同时编辑同一模板时，后提交者必须重新载入或合并，不能覆盖。
- 整库备份包含 `.pitavern/world-templates/`；恢复后索引、草稿、版本记录和聊天内嵌模板都保留。
- 手工删除模板目录中的文件不影响已有聊天；编辑器读取缺失版本时明确报错，不猜测模板内容。
- 模板库写入不改变已有聊天的 revision/世界状态。

## 8. 0.5.0 验收

- 创建/复制模板 → 新建聊天选模板 → 执行 world_command → 导出/导入整库 → 重启恢复。
- 草稿保存/发布/再次编辑/版本冲突/删除模板后旧聊天不变。
- 模板库删除/备份恢复后，旧聊天和旧分支继续使用其内嵌版本。
- 非法模板（重复 ID、无效引用、数值越界）被服务端拒绝，不落库。
- 0.5.0 不验证“已有聊天更新模板”；该用例留 0.6.0。
