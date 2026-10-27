# PiTavern（π 酒馆）

基于 [pi](https://github.com/earendil-works/pi) agent 运行时的 agent 化酒馆。数据生态兼容 [SillyTavern](https://github.com/SillyTavern/SillyTavern)（角色卡 / 世界书 / 预设 / JSONL 聊天记录）。

## 一键启动

macOS 双击项目根目录的 **`start.command`** 即可，也可以在终端执行 `npm start`。

需先安装 Node.js 22.19 或更高版本（含 npm）。脚本自动安装缺失依赖、构建前端、启动服务并打开浏览器；首次安装依赖需要联网。前后端共用一个地址，无需另外启动 Vite。

默认地址为 `http://127.0.0.1:8787`，已有配置中的端口会自动生效。保持启动窗口打开；按 `Ctrl+C` 或关闭窗口可停止本次服务。端口被占用时会显示提示，可在终端改用其他端口：

```sh
PORT=9898 ./start.command
PITAVERN_OPEN_BROWSER=0 ./start.command # 不自动打开浏览器
```

`PITAVERN_CONFIG` 可指定其他配置文件；相对路径以项目根目录为基准。启动失败时，双击打开的窗口会保留错误信息，按回车后退出。

## 开发

```sh
npm install
npm run dev:server   # 服务端 http://127.0.0.1:8787（tsx watch）
npm run dev:web      # 前端 http://localhost:5173（vite，代理 /api /ws）
npm run check        # 全仓类型检查
npm run e2e          # mock 中转端到端冒烟（含工具循环）
npm run verify:bridge # 桥接组装器对齐验证（真实猫神预设）
npm run verify:tools # 工具四件套 + 限次冷却强制验证
npm run verify:m4    # 输出协议还原 + 流式提取 + 历史压缩验证
npm run verify:takeover # 接管模式组装 + 状态投影验证（合成数据，无需本地角色卡）
npm run verify:m6    # 世界书计时效果（sticky/cooldown/delay）验证
npm run verify:regression # 空聊天/缓存/完整工具轮压缩/前端会话状态回归
```

聊天切换和断线重连通过 WebSocket 快照恢复历史与生成进度。设置变更从下一回合生效，当前生成仍可停止。聊天读取按文件修改时间缓存，兼容外部修改的 ST 记录。

接管模式的状态投影通过增量事件更新，回复结束后保留本次会话的工具活动。角色卡、常驻世界书与历史中的宏在组装时展开；开场白随首轮保留，直到首轮离开历史窗口。全局世界书可直接在各上下文模式下导入和启用。

两种上下文模式统一在 Agent 层压缩完整旧轮次，保留当前工具调用链，并为输出预留预算。预算仍采用保守字符估算；模型的 `contextWindow`、`maxTokens` 应按实际能力配置。压缩后仍超预算时会返回明确错误。

`npm run e2e` 使用独立测试目录和动态端口，测试数据与逐次 mock 请求记录保留在 `data/test-runs/`，不依赖真实 API Key。

首次使用：打开前端 → 设置 → 添加中转（OpenAI 兼容 baseUrl + API Key + 模型 id）→ 保存并测试连通 → 把角色卡 PNG 放进 `data/st/characters/` → 开始新对话。

`data/config.json` 存连接配置（含明文 API Key，已在 .gitignore 中）。`stDataDir` 可指向现有 SillyTavern 的 `data/default-user` 直接复用角色卡与聊天记录。

## 路线图

- **M1 行走骨架** ✅ pi Agent 引擎 + 中转接入 + WS 流式 + ST 人物卡/聊天读写 + 基础聊天 UI
- **M2 桥接组装器** ✅ ST 预设兼容组装（prompt_order 引擎 / 宏核心集 / 世界书扫描递归 / 提示词正则 / 深度注入 / 采样透传），猫神预设实测对齐（`npm run verify:bridge`）
- **M3 工具四件套** ✅ worldbook_search（片段→refs 两级检索）/ tavern_recall_history（query 片段 + turn 全文）/ tavern_read_variables（ST chat_metadata.variables 兼容）/ tavern_read_skill_reference；召回限次（每轮≤6）与冷却（全文召回后 10 轮）由**运行时强制**；UI 工具卡片流 + 用量/召回面板（`npm run verify:tools`）
- **M4 输出协议 + 历史压缩** ✅ game_tool 模式：`game_content`（正文，MANDATORY）+ `tavern_think`（思维链）双工具原生 function calling 取代伪 JSON 预填；consumeToolCalls 还原落库（mes 正文 + extra.thinking/summary）；参数流式宽松提取（toolcall_delta 实时渲染正文）；`tool_choice=required` 可透传；历史压缩 transformContext（超预算时旧轮 summary 优先折叠为 |用户|/|游戏剧情| 块，UI/落库永远全文）（`npm run verify:m4`）
- **M5 接管模式** ✅ agent 原生组装：人物卡/常驻世界书/persona 进 system named sections，关键词条目 0 注入（全靠 worldbook_search）；历史只带近 N 轮（更早靠召回）——上下文成本随需求而非历史增长；`tavern_set_state` 状态投影工具每轮结算现场快照写入 `chat_metadata.projection` 并回注 system，📊 面板实时显示（`npm run verify:takeover`）
- **M6 打磨** ✅ 世界书计时效果（sticky 保活→到期自动进 cooldown 压制；delay 前置压制；状态持久化 `chat_metadata.timedWorldInfo`，单位消息数，对照 ST WorldInfoTimedEffects）；导入导出（侧栏上传角色卡 PNG/JSON、设置导入世界书、聊天导出 MD/JSONL）；主题（夜琥珀/林间绿/羊皮纸，🎨 切换）；移动端适配（抽屉导航 + 浮层面板）（`npm run verify:m6`）
- **后置** 多角色群聊；charx/byaf 卡格式；向量检索条目

## 工具四件套（M3）

两种上下文模式下都可用，缺一不可的运行时能力：

| 工具 | 说明 |
|---|---|
| `worldbook_search` | 片段搜索（query）→ 全文读取（refs / read=true）两级检索；搜全部条目不限自动召回 |
| `tavern_recall_history` | query 关键词召回片段 / turn 按轮读完整正文；**每轮 ≤6 次、全文召回后冷却 10 轮，运行时强制拒绝**（不靠提示词自觉） |
| `tavern_read_variables` | 只读查询存档变量（list/search/read 分页）；数据在聊天 JSONL 首行 `chat_metadata.variables`（ST 兼容，手编 JSONL 即可写入） |
| `tavern_read_skill_reference` | 读 `data/st/skills/<名>/references/*.md`（防目录穿越） |

右上角 📊 面板：实时工具卡片（含拒绝/冷却态）、token 用量、召回预算状态。

## 接管模式（M5）

设置 → 对话上下文 → 「Agent 接管」。这是 dsh-tavern 模式的 pi 版——上下文经济学最优解：

| 机制 | 说明 |
|---|---|
| system sections | 人物卡 / 常驻世界书 / persona / 状态投影 / 输出协议各自成 section，每轮重建 |
| 世界书按需 | 常驻（constant）条目注入；关键词条目 0 注入，全部靠 `worldbook_search` 检索 |
| 召回制历史 | 只带最近 N 轮全文（默认 3），更早剧情靠 `tavern_recall_history`；token 随"这轮需要什么"增长 |
| 状态投影 | 模型每轮用 `tavern_set_state` 结算现场快照（人物/地点/关键物品），写入 `chat_metadata.projection` 回注下一轮 system；📊 面板可见 |

## 桥接模式（M2）

设置 → 对话上下文 → 「ST 预设桥接」，选择 `OpenAI Settings/` 下的预设即可让现有 ST 预设生态生效（如猫神预设）。实现范围与已知差异：

| 能力 | 状态 |
|---|---|
| prompts + prompt_order（含 marker 与绝对深度注入） | ✅ |
| 宏核心集（char/user/random/pick/roll/getvar/时间/{{trim}}/{{// 注释}}） | ✅ |
| 世界书（常驻/关键词正则全词匹配/二级逻辑/递归/exclude/prevent/delayUntilRecursion/概率） | ✅ |
| 提示词正则（promptOnly、placement、minDepth/maxDepth） | ✅ |
| 采样参数透传（temperature/top_p/top_k/max_tokens…） | ✅（中转默认用 max_tokens 字段） |
| system 消息位置 | ⚠️ pi 运行时把所有 system 按序合并为开头一条（内容无损，历史后指令的"尾部位置"效果不保留） |
| 向量条目、min activations | ❌ 后置 |
| instruct 模板、text-completion 系 API、{{setvar}} 写变量 | ❌ 暂不支持 |

## 架构

```
apps/server   pi-agent-core 引擎 · 每聊天一个 Agent（finishTurn 单回合 / transformContext 压缩位）
              pi-ai createProvider 接任意 OpenAI 兼容中转 · ST 数据格式读写 · HTTP+WS
apps/web      Vite + React + TS + Tailwind · 聊天流（流式渲染/工具卡片） · 面板 · 设置
packages/shared  前后端 WS 事件协议契约
```
