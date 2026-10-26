# PiTavern（π 酒馆）

基于 [pi](https://github.com/earendil-works/pi) agent 运行时的 agent 化酒馆。数据生态兼容 [SillyTavern](https://github.com/SillyTavern/SillyTavern)（角色卡 / 世界书 / 预设 / JSONL 聊天记录）。

## 开发

```sh
npm install
npm run dev:server   # 服务端 http://127.0.0.1:8787（tsx watch）
npm run dev:web      # 前端 http://localhost:5173（vite，代理 /api /ws）
npm run check        # 全仓类型检查
npm run e2e          # mock 中转端到端冒烟
```

首次使用：打开前端 → 设置 → 添加中转（OpenAI 兼容 baseUrl + API Key + 模型 id）→ 保存并测试连通 → 把角色卡 PNG 放进 `data/st/characters/` → 开始新对话。

`data/config.json` 存连接配置（含明文 API Key，已在 .gitignore 中）。`stDataDir` 可指向现有 SillyTavern 的 `data/default-user` 直接复用角色卡与聊天记录。

## 路线图

- **M1 行走骨架** ✅ pi Agent 引擎 + 中转接入 + WS 流式 + ST 人物卡/聊天读写 + 基础聊天 UI
- **M2 桥接组装器** ✅ ST 预设兼容组装（prompt_order 引擎 / 宏核心集 / 世界书扫描递归 / 提示词正则 / 深度注入 / 采样透传），猫神预设实测对齐（`npm run verify:bridge`）
- **M3 工具四件套** worldbook_search / tavern_recall_history / 变量读取 / skill 参考 + 限次冷却运行时强制 + 可视化面板
- **M4 输出协议 + 历史压缩** 强制工具调用防截断 + consumeToolCalls 还原 + squash/summary 折叠
- **M5 接管模式** agent 原生上下文组装 + 每轮状态投影

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
