# 0.2.0-rc.1 发布与升级

候选版日期：2026-10-29。支持 Node.js >=22.19，CI 目标 Node 22/24；保留兼容边界，不把 RC 当作正式生产验证完成。

## 全新安装

    git clone git@github.com:djj45/PiTavern.git
    cd PiTavern
    git checkout v0.2.0-rc.1
    ./start.command

也可解压源码包，在目录内双击 macOS 的 start.command 或执行 npm start。首次启动联网安装锁定的依赖，检查 Node、构建并启动。默认 http://127.0.0.1:8787；端口冲突用 PORT=9898 ./start.command。停止启动器会回收服务。

首次设置没有任何模型和密钥。在「设置」添加连接、模型并选择上下文模式；密钥不能放入源码。纯本地脚本无需模型。

## 升级

1. 停止所有生成和脚本，在「资料库 → 备份与迁移」导出整库；另外安全保留实际配置文件（默认 data/config.json），其中可能含密钥，不能提交 Git。备份应在升级前完成。
2. 关闭服务，确认已有源码修改已保存，记录 git rev-parse HEAD 作为回退点。
3. git fetch origin --tags，再 git checkout v0.2.0-rc.1，然后 ./start.command；按锁文件补依赖并重建。
4. 确认设置的 stDataDir 指向原库，旧角色、聊天和预设可读；验证一轮生成、候选和世界书。不会自动迁移/替换原库。
5. 新群聊/脚本使用 JSONL 扩展，旧版或原版酒馆不保证识别。不能用升级后资料覆盖升级前备份。

源码包升级应解压到新目录并保留旧安装。PITAVERN_CONFIG 指向原配置的绝对路径；若 stDataDir 为相对路径，先改成原库绝对路径，避免相对新源码目录解析成空库。保留旧配置副本以便回退。

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
    npm run verify:release -- /绝对路径/PiTavern-0.2.0-rc.1.tar.gz

provider 参数明确启用一次真实默认模型请求；无模型时报告待验并退出 2。全部源码提交后再打包，工作区不干净会拒绝。输出到 data/releases/ 唯一目录，附 manifest.json 和 SHA256SUMS。包内无 data、node_modules、.git 或 .env，是需要 Node/npm 的源码包。

发布验收解包到独立含空格空目录，确认没有依赖和资料，使用 start.command 首次安装，检查版本、空库、静态资源、HTTP/WS 和端口回收。独立配置，不接触原库或真实供应商。所有成功/失败产物保留于 data/test-runs/。

## 真实环境边界

- 上轮 d07caa4 的 GitHub Actions Node 22/24 已通过；本轮以新提交实际 CI 为准，不用旧结果替代。
- 本机原库仅 1 张卡、1 个预设，没有聊天和外部世界书；已在副本执行备份/恢复逐文件 SHA256 比对，确认原库未改动。报告：data/test-runs/local-acceptance-DeE7Fn/report.json。
- 无供应商、默认模型和密钥，真实请求未执行，真实大库也缺少输入。后续配置实际模型和足量真实资料再验收，才能升级正式版。
- 合成测试覆盖结构和回滚，不替代各供应商、文本补全或复杂第三方脚本实测。
