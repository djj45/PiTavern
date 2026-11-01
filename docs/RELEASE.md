# 0.4.0 发布与升级

发布日期：2026-11-01。要求 Node.js >=22.19，CI 目标 Node 22/24。

0.4.0 新增单文件聊天 JSONL 导入：侧栏「＋ 导入聊天」→ 选择文件 → 只读预览 → 关联已有角色卡并确认标题 → 原子导入并打开。预览与导入共用严格解析器；重复文件按原始字节 SHA-256 阻止；未知字段、`swipes`、候选、隐藏 continuation、变量、世界快照和模板表原样保留；模板缺失或规则版本未知时只读。导入索引保存在 `<stDataDir>/.pitavern/chat-imports/index.json`，随整库备份。单个聊天文件不含角色卡、独立生成记录和供应商配置，完整迁移仍使用整库归档。契约见 [聊天导入契约](CHAT_IMPORT.md)，完整变更见 [CHANGELOG](../CHANGELOG.md)。

本版同时修正导出文档歧义：JSONL 导出原样返回整份聊天文件（含未选中的候选、隐藏 continuation、变量和世界模板表）；MD 导出只包含当前活动路径的可见消息。导入校验还覆盖 `swipe_info[].extra` 的扩展字段/世界快照/候选引用、原生 `swipes` 的 10000 节点预算，以及首行 `mes` 类型判定。兼容边界以 [兼容说明](COMPATIBILITY.md) 为准。

## 全新安装

    git clone git@github.com:djj45/PiTavern.git
    cd PiTavern
    git checkout v0.4.0
    ./start.command

也可解压源码包，在目录内双击 macOS 的 start.command 或执行 npm start。首次启动联网安装锁定的依赖，检查 Node、构建并启动。默认 http://127.0.0.1:8787；端口冲突用 PORT=9898 ./start.command。停止启动器会回收服务。

首次设置没有任何模型和密钥。在「设置」添加连接和模型，选择上下文模式；密钥不能放入源码。纯本地脚本无需模型。导入聊天前需先在资料库放入至少一张角色卡：导入必须关联已有角色，不读取聊天文件里的角色卡。

## 升级

0.3.0 → 0.4.0 不自动迁移聊天数据；已有聊天、角色卡、世界书、预设和分支数据按原格式读取。

1. 停止所有生成和脚本，在「资料 → 备份与迁移」导出整库；另外安全保留实际配置文件（默认 data/config.json），其中可能含密钥，不能提交 Git。升级前完成备份。
2. 关闭服务，确认已有源码修改已保存，记录 git rev-parse HEAD 作为回退点。
3. git fetch origin --tags，再 git checkout v0.4.0，然后 ./start.command；按锁文件补依赖并重建。
4. 确认设置里的 stDataDir 指向原库；旧角色、聊天、预设与已有分支目录可读。验证一轮生成、候选切换和旧聊天世界状态。
5. 导入索引是新增的：首次成功导入时创建 `<stDataDir>/.pitavern/chat-imports/index.json`，整库备份包含它。它只记录通过 PiTavern 导入的文件哈希；手工复制进 `chats/` 的聊天不进入索引，导入前无法识别为重复。删除索引会丢失重复识别历史，但已有聊天不受影响；索引损坏时服务保留副本并重建，不阻止导入。
6. 导入总是创建新聊天文件，不覆盖已有聊天。标题优先保留原 `_pitavernTitle`，否则使用上传文件名（去扩展名）；重名自动追加 ` (2)`、` (3)`……，可在预览中修改。导入后的聊天没有独立生成记录，统计从导入后开始。
7. 导入 JSONL 中的世界模板表随聊天保存，不依赖独立模板目录；模板缺失或规则版本未知时世界面板显示只读原因，不能提交世界命令。这不是导入失败；该聊天仍可查看，但在缺失/不匹配的模板被恢复前不能提交世界命令。
8. 旧版或原版酒馆不保证识别新增的 `_pitavernImport` 等元数据；不能用升级后的聊天覆盖升级前备份。

已有分支管理数据保持兼容：旧 JSONL 首次打开分支目录时仍会递归补齐持久 messageId 并迁移旧分支元数据键；世界字段只随聊天 JSONL 的提交一起变化。

## 回退

停止新服务，切回升级前记录的 Git 提交或原安装，按对应锁文件安装依赖后启动。回退数据前复制保留升级后的完整资料，把配置指向升级前备份恢复出的新目录，不能覆盖当前库。整库恢复保留旧目录，按界面旧路径改回 stDataDir 并重启也可回退。密钥和连接配置单独恢复，不随便携归档导入。

0.3.0 不读取 `.pitavern/chat-imports/index.json`，也没有导入 UI；可保留该索引，重新升级到 0.4.0 后继续用它识别重复。导入后的聊天是常规 JSONL，回退版本可读取正文，但会忽略 `_pitavernImport` 等新增元数据；回退版本没有导入入口，不会再次导入同一文件。

## 验收和打包

    npm ci
    npm run check
    npm run build
    npm run verify:ci
    npm run verify:chat-import
    npm run verify:browser
    npm run verify:local
    npm run verify:local -- --provider
    npm run release:pack
    npm run verify:release -- /绝对路径/PiTavern-0.4.0.tar.gz

- `npm run verify:chat-import` 是 0.4.0 新增的单文件聊天导入专项：导出/导入往返、隐藏分支/候选、损坏 JSON 与半截行、重复文件、无头文件、角色关联、超限和世界模板只读等，使用合成数据，不需要真实 API Key。
- `npm run verify:ci` 与 `npm run verify:browser` 覆盖既有回归以及新增浏览器导入用例；本次本地运行为离线 CI 19 组、浏览器 39 项（含聊天导入 4 项与 390px 移动端）。
- `npm run verify:world-engine` 等既有专项继续运行；世界引擎 0.4.0 不新增规则，单文件导入复用聊天 JSONL 的模板/快照持久化路径。
- 发布前应在本地真实资料副本上覆盖：资料解析、整库备份恢复逐文件 SHA-256、导入索引写入/损坏重建、重复阻止、单文件导入后打开聊天、世界模板只读投影；不得修改原库，结果保留在 `data/test-runs/`。
- provider 参数明确启用一次真实默认模型请求；无模型时报告待验并退出 2。不要在发布流程中隐式调用真实供应商。
- 全部源码提交后再打包，工作区不干净会拒绝。输出到 data/releases/ 唯一目录，附 manifest.json 和 SHA256SUMS。包内无 data、node_modules、.git 或 .env，是需要 Node/npm 的源码包。
- 发布验收解包到独立含空格空目录，确认没有依赖和资料，使用 start.command 首次安装，检查版本、空库、静态资源、HTTP/WS 和端口回收。独立配置，不接触原库或真实供应商。所有成功/失败产物保留于 data/test-runs/。
- manifest 中的 providerAcceptance 和 largeLibraryAcceptance 为 not_executed_by_packager；发布包不声称已完成这两项实机验收。

### 本次本地验收记录（2026-11-01）

- 环境：macOS arm64、Node v26.12.0。Node 22/24 由 GitHub Actions 配置执行，本会话未单独运行。
- `npm run check` / `npm run build`：通过。
- `npm run verify:chat-import`：49 项检查通过（解析器 27、服务/存储 10、世界/分支闭环 8、HTTP 4）。
- `npm run verify:ci`：19 组离线合成回归通过，包含新增 `chat-import`。
- `npm run verify:browser`：39 项 Chromium 验收通过，其中聊天导入 4 项（完整流程/损坏行号/重复阻止/390px）。
- `npm run verify:local`：本机现有资料副本 47 个文件、1 个聊天、4 个资料资源；整库恢复逐文件 SHA-256 一致、原资料未变、真实副本单文件导入通过；真实供应商 `not_requested`（未传 `--provider`）。
- 未执行：真实供应商请求、真实大库/真实第三方复杂预设实机验收、Node 22/24 本地矩阵、提交后的 `release:pack` / `verify:release`。这些不因本地合成/副本结果自动声明通过。

## 发布产物

    data/releases/PiTavern-0.4.0-<随机后缀>/
    ├── PiTavern-0.4.0.tar.gz
    ├── SHA256SUMS
    └── manifest.json

发布包是纯源码归档，基于 v0.4.0 提交生成。GitHub 远端 CI 结果以推送后的 Actions 记录为准；本地发布前执行类型检查、构建、聊天导入专项、现有 CI、浏览器验收和真实资料副本验收。

## 真实环境边界

- 自动验收覆盖结构和回滚，不替代各供应商、文本补全或复杂第三方脚本实测。
- 聊天导入的自动化用例使用合成 JSONL 和本地 mock；真实 SillyTavern 导出、含复杂隐藏分支/世界模板的文件和真实大库，应在数据副本上手工走一遍「预览 → 关联角色 → 导入并打开」，并保留 `data/test-runs/` 记录。
- 世界模板缺失、引用记录缺失、哈希/版本不匹配或规则版本未知时进入只读；可查看，不能提交世界命令，也不会静默套用新模板。
- 本机真实资料应在副本上执行 backup/restore 逐文件校验；真实默认模型请求只在明确加 --provider 时执行。
- 0.4.0 只包含单个聊天 JSONL 导入；不包含 0.5/0.6 计划中的自定义世界模板编辑器、模板热更新等后续能力，也不包含随聊天文件迁移角色卡、独立生成记录或供应商配置。
- 真实大库、真实供应商和原版复杂预设的验收报告应放在 data/test-runs/，并随对应版本提交或归档，而不是伪造通过。
