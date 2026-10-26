# PiTavern（π 酒馆）

基于 [pi](https://github.com/earendil-works/pi) agent 运行时的 agent 化酒馆。数据生态兼容 [SillyTavern](https://github.com/SillyTavern/SillyTavern)（角色卡 / 世界书 / 预设 / JSONL 聊天记录）。

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
npm run verify:regression # 空聊天/缓存/完整工具轮压缩/前端会话状态回归
```

聊天切换和断线重连通过 WebSocket 快照恢复历史与生成进度。设置变更从下一回合生效，当前生成仍可停止。聊天读取按文件修改时间缓存，兼容外部修改的 ST 记录。

两种上下文模式统一在 Agent 层压缩完整旧轮次，保留当前工具调用链，并为输出预留预算。预算仍采用保守字符估算；模型的 `contextWindow`、`maxTokens` 应按实际能力配置。压缩后仍超预算时会返回明确错误。

`npm run e2e` 使用独立测试目录和动态端口，测试数据与逐次 mock 请求记录保留在 `data/test-runs/`，不依赖真实 API Key。

首次使用：打开前端 → 设置 → 添加中转（OpenAI 兼容 baseUrl + API Key + 模型 id）→ 保存并测试连通 → 把角色卡 PNG 放进 `data/st/characters/` → 开始新对话。

`data/config.json` 存连接配置（含明文 API Key，已在 .gitignore 中）。`stDataDir` 可指向现有 SillyTavern 的 `data/default-user` 直接复用角色卡与聊天记录。

## 路线图

- **M1 行走骨架** ✅ pi Agent 引擎 + 中转接入 + WS 流式 + ST 人物卡/聊天读写 + 基础聊天 UI
- **M2 桥接组装器** ✅ ST 预设兼容组装（prompt_order 引擎 / 宏核心集 / 世界书扫描递归 / 提示词正则 / 深度注入 / 采样透传），猫神预设实测对齐（`npm run verify:bridge`）
- **M3 工具四件套** ✅ worldbook_search（片段→refs 两级检索）/ tavern_recall_history（query 片段 + turn 全文）/ tavern_read_variables（ST chat_metadata.variables 兼容）/ tavern_read_skill_reference；召回限次（每轮≤6）与冷却（全文召回后 10 轮）由**运行时强制**；UI 工具卡片流 + 用量/召回面板（`npm run verify:tools`）
- **M4 输出协议 + 历史压缩** ✅ game_tool 模式：`game_content`（正文，MANDATORY）+ `tavern_think`（思维链）双工具原生 function calling 取代伪 JSON 预填；consumeToolCalls 还原落库（mes 正文 + extra.thinking/summary）；参数流式宽松提取（toolcall_delta 实时渲染正文）；`tool_choice=required` 可透传；历史压缩 transformContext（超预算时旧轮 summary 优先折叠为 |用户|/|游戏剧情| 块，UI/落库永远全文）（`npm run verify:m4`）
- **M5 接管模式** agent 原生上下文组装 + 每轮状态投影

## 工具四件套（M3）

两种上下文模式下都可用，缺一不可的运行时能力：

| 工具 | 说明 |
|---|---|
| `worldbook_search` | 片段搜索（query）→ 全文读取（refs / read=true）两级检索；搜全部条目不限自动召回 |
| `tavern_recall_history` | query 关键词召回片段 / turn 按轮读完整正文；**每轮 ≤6 次、全文召回后冷却 10 轮，运行时强制拒绝**（不靠提示词自觉） |
| `tavern_read_variables` | 只读查询存档变量（list/search/read 分页）；数据在聊天 JSONL 首行 `chat_metadata.variables`（ST 兼容，手编 JSONL 即可写入） |
| `tavern_read_skill_reference` | 读 `data/st/skills/<名>/references/*.md`（防目录穿越） |

右上角 📊 面板：实时工具卡片（含拒绝/冷却态）、token 用量、召回预算状态。

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
| 世界书 sticky/cooldown/delay 计时效果、向量条目、min activations | ❌ M4+ |
| instruct 模板、text-completion 系 API、{{setvar}} 写变量 | ❌ 暂不支持 |

## 架构

```
apps/server   pi-agent-core 引擎 · 每聊天一个 Agent（finishTurn 单回合 / transformContext 压缩位）
              pi-ai createProvider 接任意 OpenAI 兼容中转 · ST 数据格式读写 · HTTP+WS
apps/web      Vite + React + TS + Tailwind · 聊天流（流式渲染/工具卡片） · 面板 · 设置
packages/shared  前后端 WS 事件协议契约
```
