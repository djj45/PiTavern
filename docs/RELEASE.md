# 0.5.0 发布与升级

发布日期：2026-11-01。要求 Node.js >=22.19，CI 目标 Node 22/24。

0.5.0 交付世界模板库与编辑器：模板列表、新建/复制内置、地点/角色/物品（固定价格）/初始玩家/位置/金额/库存编辑、服务端校验与初始世界预览、草稿与不可变发布版本、版本列表、导入/导出、冲突检查、整库备份恢复。新聊天可直接选择已发布模板或按内容哈希选择精确版本；已有聊天继续使用自身 JSONL 内嵌的模板记录，删除/修改模板库不影响旧聊天。契约见 [世界模板契约](WORLD_TEMPLATES.md)，完整变更见 [CHANGELOG](../CHANGELOG.md)。

本版同时包含 0.4.1 的隐藏分支候选修复，以及两项发布元数据修正：仅改名称/描述时 `draftDirty` 正确显示；已发布版本没有描述时摘要不回退未发布草稿描述。

## 全新安装

    git clone git@github.com:djj45/PiTavern.git
    cd PiTavern
    git checkout v0.5.0
    ./start.command

也可解压源码包，在目录内双击 macOS 的 start.command 或执行 npm start。首次启动联网安装锁定的依赖，检查 Node、构建并启动。默认 http://127.0.0.1:8787；端口冲突用 PORT=9898 ./start.command。停止启动器会回收服务。

首次设置没有任何模型和密钥。在「设置」添加连接和模型，选择上下文模式；密钥不能放入源码。纯本地脚本无需模型。导入聊天和新建世界模板前，先在资料库放入角色卡。

## 升级

0.4.x → 0.5.0 不自动迁移聊天数据；已有聊天、角色卡、世界书、预设和分支按原格式读取。

1. 停止所有生成和脚本，在「资料 → 备份与迁移」导出整库；另外安全保留实际配置文件（默认 data/config.json），其中可能含密钥，不能提交 Git。升级前完成备份。
2. 关闭服务，确认已有源码修改已保存，记录 git rev-parse HEAD 作为回退点。
3. git fetch origin --tags，再 git checkout v0.5.0，然后 ./start.command；按锁文件补依赖并重建。
4. 确认 stDataDir 指向原库；旧聊天继续使用其 JSONL 内嵌模板，不需要迁移；模板库为空不影响旧聊天。
5. 新模板库位于 `<stDataDir>/.pitavern/world-templates/`，随整库备份。新建/复制/导入只产生草稿；发布生成新的不可变版本。
6. 删除模板库条目只影响新聊天选择，不改变已有聊天/分支及其内嵌模板；模板目录文件缺失时编辑器明确报错，不猜测模板。
7. 导入/导出模板 JSON 的格式为 `pitavern-world-template` v1；导入时相同 `templateId`（包括内置模板 ID）会分配新的稳定 ID，不覆盖已有模板。
8. 旧版或原版酒馆不保证识别 `_pitavernImport`、模板名称等新增元数据；不能用升级后的聊天覆盖升级前备份。

## 回退

停止新服务，切回升级前记录的 Git 提交或原安装，按对应锁文件安装依赖后启动。回退数据前复制保留升级后的完整资料，把配置指向升级前备份恢复出的新目录，不能覆盖当前库。整库恢复保留旧目录，按界面旧路径改回 stDataDir 并重启也可回退。密钥和连接配置单独恢复，不随便携归档导入。

0.4.x 不读取 `.pitavern/world-templates`，也没有模板编辑器；保留该目录不影响旧版启动。0.5.0 新建的聊天是常规 JSONL，回退版本可读取正文和世界摘要，但会忽略模板库和自定义名称等新增元数据；回退版本不能编辑/发布模板。

## 验收和打包

    npm ci
    npm run check
    npm run build
    npm run verify:chat-import
    npm run verify:world-templates
    npm run verify:ci
    npm run verify:browser
    npm run verify:local
    npm run verify:local -- --provider
    npm run release:pack
    npm run verify:release -- /绝对路径/PiTavern-0.5.0.tar.gz

- `verify:chat-import`：51 项；`verify:world-templates`：16 项；`verify:ci`：20 组；`verify:browser`：46 项。
- 模板库专项覆盖草稿/revision 冲突、不可变发布、版本选择、内置 ID 冲突、元数据发布、导入/导出、删除旧聊天不变和整库备份恢复。
- 发布前在真实资料副本上执行整库备份恢复逐文件 SHA-256、单文件聊天导入和模板库备份；不得修改原库。
- provider 参数明确启用一次真实默认模型请求；无模型时报告待验并退出 2。不要在发布流程中隐式调用真实供应商。
- 全部源码提交后打包；输出到 data/releases/ 唯一目录，附 manifest.json 和 SHA256SUMS。包内无 data、node_modules、.git 或 .env。
- 发布验收解包到独立含空格空目录，使用 start.command 首次安装，检查版本、空库、静态资源、HTTP/WS、模板库初始状态和端口回收。所有成功/失败产物保留在 data/test-runs/。
- manifest 的 providerAcceptance 与 largeLibraryAcceptance 为 not_executed_by_packager。

### 本次本地验收记录（2026-11-01）

- 环境：macOS arm64、Node v26.12.0；Node 22/24 由 GitHub Actions 执行。
- `npm run check` / `npm run build`：通过。
- `verify:chat-import`：51 项；`verify:world-templates`：16 项；`verify:ci`：20 组；`verify:browser`：46 项。
- `verify:local`：47 个文件、1 个聊天副本；整库恢复 SHA-256 一致、原资料未变、单文件导入通过；真实供应商 `not_requested`。
- 未执行：真实供应商请求、真实大库/第三方复杂预设实机验收、Node 22/24 本地矩阵；发布包验收在最终提交后执行。

## 发布产物

    data/releases/PiTavern-0.5.0-<随机后缀>/
    ├── PiTavern-0.5.0.tar.gz
    ├── SHA256SUMS
    └── manifest.json

发布包是纯源码归档，基于 v0.5.0 提交生成。GitHub 远端 CI 结果以 push 后的 Actions 记录为准；本地发布前执行类型检查、构建、聊天导入/模板库专项、离线 CI、浏览器验收和真实资料副本验收。

## 真实环境边界

- 自动验收覆盖结构和回滚，不替代各供应商、文本补全或复杂第三方脚本实测。
- 模板库自动化使用合成数据；真实 SillyTavern 导出、真实大库和复杂隐藏分支/世界模板应在数据副本上手工走一遍。
- 模板名称/描述展示与发布元数据已覆盖；模板内容更新到已有聊天、删除实体 ID 的迁移属于 0.6.0，0.5.0 不提供。
- 真实大库、真实供应商和原版复杂预设的验收报告应放在 data/test-runs/，并随对应版本提交或归档，而不是伪造通过。
