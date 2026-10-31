# 0.2.2 发布与升级

发布日期：2026-10-30。要求 Node.js >=22.19，CI 目标 Node 22/24。

0.2.2 在 0.2.1 基础上完成剧情分支管理两期：完整目录、非活动路线预览、全文正文搜索、逐路线收藏/标签、整棵子树归档/恢复、批量操作、路线对比，以及旧 JSONL 迁移和跨层切换稳定性修复。完整变更见 [CHANGELOG](../CHANGELOG.md)。

兼容边界仍以 [兼容说明](COMPATIBILITY.md) 为准。自动验收使用合成数据；真实供应商、真实大库和第三方复杂预设/脚本仍需单独确认，不以合成测试结果替代。

## 全新安装

    git clone git@github.com:djj45/PiTavern.git
    cd PiTavern
    git checkout v0.2.2
    ./start.command

也可解压源码包，在目录内双击 macOS 的 start.command 或执行 npm start。首次启动联网安装锁定的依赖，检查 Node、构建并启动。默认 http://127.0.0.1:8787；端口冲突用 PORT=9898 ./start.command。停止启动器会回收服务。

首次设置没有任何模型和密钥。在「设置」添加连接和模型，选择上下文模式；密钥不能放入源码。纯本地脚本无需模型。

## 升级

1. 停止所有生成和脚本，在「资料 → 备份与迁移」导出整库；另外安全保留实际配置文件（默认 data/config.json），其中可能含密钥，不能提交 Git。备份应在升级前完成。
2. 关闭服务，确认已有源码修改已保存，记录 git rev-parse HEAD 作为回退点。
3. git fetch origin --tags，再 git checkout v0.2.2，然后 ./start.command；按锁文件补依赖并重建。
4. 确认设置里的 stDataDir 指向原库，旧角色、聊天和预设可读；验证一轮生成、候选和世界书。不会自动迁移或替换原库。
5. 新群聊/脚本/分支使用 JSONL 扩展，旧版或原版酒馆不保证识别；不能用升级后的资料覆盖升级前备份。

源码包升级应解压到新目录并保留旧安装。PITAVERN_CONFIG 指向原配置的绝对路径；若 stDataDir 为相对路径，先改成原库绝对路径，避免相对新源码目录解析成空库。保留旧配置副本以便回退。

从 0.2.1 升级到 0.2.2 后，设置仍自动保存。旧 JSONL 首次打开分支目录时会在一次事务里递归补齐持久 messageId 并迁移旧分支元数据键，会改变该聊天文件 revision；正文、候选和状态不变。目录深度/节点上限为 200/10000，正文搜索每页 100 条。

## 回退

停止新服务，切回升级前记录的 Git 提交或原安装，按对应锁文件安装依赖后启动。回退数据前复制保留升级后的完整资料，把配置指向升级前备份恢复出的新目录，不能覆盖当前库。整库恢复保留旧目录，按界面旧路径改回 stDataDir 并重启也可回退。密钥和连接配置单独恢复，不随便携归档导入。

## 验收和打包

    npm ci
    npm run check
    npm run build
    npm run verify:ci
    npm run verify:browser
    npm run verify:local
    npm run verify:local -- --provider
    npm run release:pack
    npm run verify:release -- /绝对路径/PiTavern-0.2.2.tar.gz

- npm run verify:ci 当前为 18 组独立合成数据回归；npm run verify:browser 当前为 34 项 Chromium 验收，均不需要真实 API Key。
- 分支管理专项验收已覆盖旧存档活动/非活动迁移、元数据保留、101 层切换、全文搜索分页与旧响应隔离、迁移后编辑和移动端目录。
- provider 参数明确启用一次真实默认模型请求；无模型时报告待验并退出 2。不要在发布流程中隐式调用真实供应商。
- 全部源码提交后再打包，工作区不干净会拒绝。输出到 data/releases/ 唯一目录，附 manifest.json 和 SHA256SUMS。包内无 data、node_modules、.git 或 .env，是需要 Node/npm 的源码包。
- 发布验收解包到独立含空格空目录，确认没有依赖和资料，使用 start.command 首次安装，检查版本、空库、静态资源、HTTP/WS 和端口回收。独立配置，不接触原库或真实供应商。所有成功/失败产物保留于 data/test-runs/。
- manifest 中的 providerAcceptance 和 largeLibraryAcceptance 为 not_executed_by_packager；发布包不声称已完成这两项实机验收。

## 发布产物

    data/releases/PiTavern-0.2.2-<随机后缀>/
    ├── PiTavern-0.2.2.tar.gz
    ├── SHA256SUMS
    └── manifest.json

发布包是纯源码归档，基于 v0.2.2 提交生成。GitHub 远端 CI 结果以推送后的 Actions 记录为准；本地发布前执行类型检查、构建、18 组 CI 和 34 项浏览器验收。

## 真实环境边界

- 自动验收覆盖结构和回滚，不替代各供应商、文本补全或复杂第三方脚本实测。
- 本机真实资料应在副本上执行 backup/restore 逐文件校验；真实默认模型请求只在明确加 --provider 时执行。
- 真实大库、真实供应商和原版复杂预设的验收报告应放在 data/test-runs/，并随对应版本提交或归档，而不是伪造通过。
