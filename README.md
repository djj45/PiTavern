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
npm run verify:chat-ux # 世界书边界/生成事务/候选切换/备份恢复/历史分页与双窗口同步
npm run verify:rendering # Markdown 表格/折叠/代码/安全过滤
npm run verify:compat # 变量持久化/向量索引/最少激活数/instruct/文本补全（本地模拟接口）
npm run verify:library # 世界书/正则编辑、PNG 保留、全局执行顺序、整库备份迁移
npm run verify:ci     # 10 组独立合成数据回归，不需要本机资料库或真实 API Key
```

聊天切换和断线重连通过 WebSocket 快照恢复历史与生成进度。设置变更从下一回合生效，当前生成仍可停止。聊天读取按文件修改时间缓存，兼容外部修改的 ST 记录。

接管模式的状态投影通过增量事件更新。工具活动和模型回传用量按生成独立保存，重新生成、刷新或重启后仍可查看。角色卡、常驻世界书与历史中的宏在组装时展开；开场白随首轮保留，直到首轮离开历史窗口。全局世界书可直接在各上下文模式下导入和启用。

三种上下文模式统一在 Agent 层压缩完整旧轮次，保留当前工具调用链，并为输出预留预算。已知模型使用 `cl100k_base` / `o200k_base` tokenizer；未知模型明确回退到字符和 UTF-8 字节估算。设置中选中模型后，可填写实际上下文长度、最大输出和计数方式，中转模型别名可手动指定编码器。聊天封装和工具协议开销仍是估算，不能替代供应商账单。文本补全计数包含完整 instruct 模板。输入预算扣除输出上限和剩余空间的 10% 余量；即使关闭压缩，超预算请求也会在发送前终止。

### 生成记录与上下文诊断

右上角 📊 →「生成记录与上下文诊断」，可分页查看每次发送、重新生成或重试的结果、已回传 token 用量和工具活动。对话轮次按当前聊天中的用户消息统计；生成次数包含成功、失败、取消和服务中断的尝试。未回传的用量无法补算，导入聊天及功能启用前的历史也不会伪造统计。模型分多次调用时累计所有已收到的用量，切换候选或恢复备份不会回滚已发生的消耗。

诊断展示本次生成最近一次请求的计数方式、输出预留、输入预算、压缩前后 token、压缩轮数和消息数，以及系统提示、对话/工具结果、工具声明和封装的占用。世界书组装记录列出注入、预算过滤、未命中、禁用、概率、计时条件和缺少预设插入位置等原因；每次保留前 200 条诊断，筛选不会重新执行宏或扫描。接管模式还显示历史窗口省略的消息数。

记录独立保存在 `<stDataDir>/.pitavern/activity/<聊天 ID 的 sha256>/`，按每次生成原子更新；服务重启会将未结束记录标为中断，并保留此前收到的工具结果和用量。JSONL/MD 聊天导出不包含这些记录，完整迁移可使用「资料库 → 备份与迁移」。验证：`npm run verify:activity`、`npm run verify:chat-ux`。

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
- **后置** 多角色群聊；charx/byaf 卡格式；完整 STscript

## 聊天操作与显示

- **编辑消息**：每条消息下方点击「编辑」，保存或用 Ctrl/Cmd+Enter 提交，Esc 取消。只修改当前消息，后续对话保留；相关旧摘要、状态投影、世界书计时缓存失效。原版存档中的未知字段及未选中的候选回复保留；当前候选回复会同步修改。生成中不能编辑，其他窗口先修改时会提示冲突。
- **生成与重试**：普通发送和重新生成都在整轮成功、返回非空正文后，一次性保存助手回复、变量和计时状态。空响应、失败或停止不保存半成品，也不推进这些状态；普通发送保留用户消息，点击「重试本轮」即可重试，无需再次发送。投影工具的实时预览在失败后恢复原状态。
- **候选回复**：输入框上方点击「重新生成回复」，使用最后一条用户发言生成新的候选，不重复追加用户消息。通过左右箭头切换最后一轮候选时，同时恢复该候选的变量、投影、计时和召回状态。支持一轮多段助手回复，重启后候选仍保留。单段候选同步写入原版 `swipes`；多段候选及状态保存在用户消息的 `extra._pitavernReplies`，原版酒馆不保证识别这部分扩展。
- **状态恢复**：本版本生成的用户消息保存本轮开始前的变量、计时效果、状态投影及召回计数检查点，重生成从检查点执行，避免重复推进状态。旧版/外部存档没有检查点时保留现有变量，清除无从还原的投影与计时状态；无法重建原版工具副作用。编辑较早消息会使后续检查点失效，手工变量仍保留。
- **存档保护**：编辑、成功重生成、候选切换和恢复备份前，把原 JSONL 备份到数据目录下的 `.pitavern/backups/<聊天路径哈希>/`，再原子替换文件。右上角「备份与恢复」可按时间浏览、预览并恢复整份存档；恢复前也会备份当前内容。备份不会自动删除。生成期间发现外部文件变化、或预览后聊天又变化时，会拒绝覆盖。
- **长聊天**：打开或重连先加载最近 80 条消息，向上通过「加载更早的消息」继续分页。视口外的消息保留占位高度，附近才挂载 Markdown；正在编辑的消息保持挂载。连续正文增量按 50ms 合并，结束事件前立即刷新。分页仅影响界面传输和渲染，模型历史和 MD/JSONL 导出保持完整。
- **Markdown 显示**：支持标题、列表、引用、表格、代码块、链接和 `<details><summary>` 折叠，流式正文同样渲染。HTML 经过安全过滤，不运行角色卡脚本、内联事件或任意样式；原始消息及模型上下文保持原文。解析器按需加载。

## 工具四件套（M3）

两种上下文模式下都可用，缺一不可的运行时能力：

| 工具 | 说明 |
|---|---|
| `worldbook_search` | 片段搜索（query）→ 全文读取（refs / read=true）两级检索；搜全部条目不限自动召回 |
| `tavern_recall_history` | query 关键词召回片段 / turn 按轮读完整正文；**每轮 ≤6 次、全文召回后冷却 10 轮，运行时强制拒绝**（不靠提示词自觉） |
| `tavern_read_variables` | 只读查询存档变量（list/search/read 分页）；数据在聊天 JSONL 首行 `chat_metadata.variables`（ST 兼容，可通过 setvar 宏写入） |
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
| 世界书 inclusion groups / Outlet | ✅ 权重、优先级覆盖、关键词评分、多组、命名出口宏 |
| 显示层正则 | ✅ 全局、预设和角色卡脚本；用户/助手/思考文本、深度过滤、流式与历史渲染 |
| 世界书／正则编辑器 | ✅ 资料库可视化编辑、正则预览、自动备份、版本冲突保护 |
| 作者注释编辑 | ✅ 聊天顶部「作者注释」；正文、间隔、深度、位置、角色 |
| 采样参数透传（temperature/top_p/top_k/max_tokens…） | ✅（中转默认用 max_tokens 字段） |
| system 消息位置 | ⚠️ pi 运行时把所有 system 按序合并为开头一条（内容无损，历史后指令的"尾部位置"效果不保留） |
| 向量条目 | ✅ 桥接模式：OpenAI 兼容 embeddings、内容索引缓存、相似度阈值与召回上限 |
| min activations | ✅ 扩大历史扫描范围、最大深度、token 预算（未知模型估算）；概率失败不会反复重抽 |
| instruct 模板 | ✅ 单人对话序列、story 包装、首末序列、名字宏及停止串；内置 ChatML/Alpaca，可导入 ST instruct JSON |
| text-completion 系 API | ✅ OpenAI 兼容 `/completions`（SSE 或 JSON）；其他原生协议尚未接入 |
| `{{setvar}}` 写变量 | ✅ 本轮顺序求值、嵌套宏、空字符串赋值；保存到聊天 `chat_metadata.variables` |

世界书进一步对齐：扫描深度 0 不扫描聊天正文（仍可由最少激活数扩展）；条目独立深度 0 不继承全局深度；常驻条目遵守概率开关，sticky 保活不重抽概率。支持原版卡内书 snake_case 扩展字段、数值角色和全局大小写设置继承。作者注释前后与示例对话前后分别定位。深度注入以原始历史为基准，不受其他注入条目移位影响；pi 的 system 消息合并限制仍然存在。

### 兼容功能配置

- **分组择一**：读取世界书的 `group`（逗号分隔）、`groupOverride`、`groupWeight`、`useGroupScoring`；卡内书支持对应 snake_case 扩展字段。同轮候选先保留有效 sticky，再按命中键数过滤，启用覆盖时取最高 Order，否则按权重抽取。设置 → 世界书检索可启用全局评分，条目可单独覆盖。分组后继续检查概率与预算；递归和扩大扫描不会再次占用已入选的组，诊断会记录淘汰原因。
- **Outlet**：条目设置 `position: 7` 和 `outletName`（卡内书 `extensions.outlet_name`），在预设或作者注释中使用 `{{outlet::名称}}`。同名内容按 Order 从高到低合并；未知名称展开为空，缺少名称的条目跳过。世界书内容和 Outlet 内不能嵌套出口。出口仍参与世界书预算、递归与计时；未被引用时不会自动塞入其他位置，诊断标记为未引用。最终请求预算会计入实际展开内容及重复引用。
- **显示正则**：ST 桥接模式按「全局 → 预设 → 角色卡」顺序执行；其他模式按「全局 → 角色卡」执行显示脚本。`markdownOnly` 用于显示、`promptOnly` 用于提示词，两者都勾选时两侧生效。未标记 only 的脚本在桥接模式分别处理提示词和显示副本，**不复刻 ST 直接修改原始消息的行为**。支持 `$0`/`{{match}}`、编号/命名捕获组、`trimStrings`、基础宏及 `substituteRegex`；显示宏只读，不写变量。替换后仍经过 Markdown 和 HTML 过滤；编辑与 MD/JSONL 导出保留原文。全局正则存放于 `.pitavern/regex.json`，不自动读取原版全局 settings.json 正则库或执行 STscript。
- **作者注释**：聊天顶部「作者注释」编辑当前聊天的 `note_prompt/note_interval/note_depth/note_position/note_role`。间隔 0 关闭、1 每轮，其他值按用户轮数取模；深度 0 表示最新消息之后。保存会自动备份，保留未知字段，生成中禁止保存，过期版本提示冲突并保留草稿。注释在 ST 桥接模式生效；尚不导入原版全局/角色注释配置。
- **变量**：预设、角色描述、世界书和历史文本组装时可用 `{{setvar::金币::100}}` 写入，随后用 `{{getvar::金币}}` 读取。变量按聊天隔离，每轮组装执行宏，原始聊天文本保持不变；扫描预览、预算估算和工具检索使用副本，不额外写入。变量暂存在本轮内存中，成功后与回复一起提交；失败或停止不保存本轮宏写入。`setglobalvar`、`addvar/incvar` 和完整 STscript 解释器不在此次范围内。
- **最少激活数**：设置 → 世界书检索，填写目标条目数及最大扫描深度。目标为 0 时关闭扩展扫描；最大深度为 0 时允许扫描到历史末尾。条目独立扫描深度、计时效果、概率和预算仍生效，因此不能保证一定达到目标。世界书预算与上下文使用同一模型计数器；未知模型采用估算，诊断面板会显示计数方式和过滤原因。
- **向量世界书**：在世界书检索中启用，选择已配置的连接并填写 embedding 模型 ID。所选服务须提供 `/embeddings`；只有 ST 条目中的 `vectorized: true`（卡内书为 `extensions.vectorized`）参与语义召回，也保留关键词匹配。候选条目正文和最近对话会发送到所选服务。本地索引保存在 `<stDataDir>/.pitavern/vectors/`，按地址、模型、维度和内容区分；修改内容、切换模型或删除条目后不会继续使用失效候选。向量检索目前用于桥接模式，接管模式保留原来的工具检索方式。
- **文本补全与 instruct**：在连接上选择「文本补全（OpenAI 兼容）」，baseUrl 填到 `/v1` 等接口前缀，模型 ID 按服务实际配置。选择 ChatML/Alpaca，或导入 ST 导出的 instruct JSON；此文件不同于 OpenAI Settings 预设和 context/story-string 的 Handlebars 模板。支持单人普通生成，不覆盖群聊、用户代写和 quiet 等 ST 特殊生成模式。模板须匹配模型，不会自动探测。
- **文本补全能力限制**：可使用简洁或 ST 桥接模式，输出协议须为原生文本，运行时不发送工具声明；Agent 接管与 `game_tool` 不可用。切换接口时界面会切换到兼容选项，服务端也会拒绝不兼容的配置。原有聊天补全接口及工具循环保持可用。

`npm run verify:compat` 使用独立合成数据和本地模拟服务，验证实际请求格式、中文流式输出、停止、变量落库、索引更新与设置保存；不调用真实供应商。每次测试的请求记录保留在 `data/test-runs/compatibility-*/`。不同供应商的模型和采样参数支持仍需使用自己的服务确认。

`npm run verify:world-display` 使用独立合成数据和本地模拟服务，验证分组、Outlet、显示/提示词隔离、注释保存冲突与请求组装；产物保存在 `data/test-runs/world-display-*/`。加上 `--preview` 参数运行 server 工作区脚本可保留本地 UI 验证服务。

## 资料库编辑与迁移

顶部「资料库」提供三个页签：

- **世界书**：创建外部世界书、增删条目、关键词和正文、启停、常驻／向量、辅助逻辑、注入位置／角色／深度、Outlet、包含组、概率与时序。启用哪些世界书以及全局扫描和预算仍在设置中选择；卡内世界书暂不提供可视化编辑。
- **正则脚本**：编辑全局、预设和 JSON／PNG 角色卡来源的脚本，支持排序、启停、作用位置／层、深度、捕获裁剪和查找宏替换。预览使用独立线程、只读变量和执行超时，只测试当前来源。斜杠命令位置作为兼容字段保留，应用尚未实现命令执行。
- **备份与迁移**：导出 `.pitavern.gz` 整库文件，或上传后预览文件数、分类、展开大小与时间，再恢复到同级新目录。

编辑使用内容版本校验，其他窗口或外部程序改过文件时拒绝覆盖，浏览器保留草稿。保存前把原文件备份到 `.pitavern/editor-backups/`，然后原子替换；未知字段保留。编辑 PNG 卡片只改 `chara`／`ccv3` 文本块，保留图片、其他块和未知 JSON 字段。保存后通知已连接窗口同步显示。修改资料前需停止全部聊天生成。

整库归档包含 `characters/`、`chats/`、`worlds/`、`OpenAI Settings/`、`skills/` 和 `.pitavern/`（包括聊天／编辑备份及生成活动）。向量缓存、临时文件、其他 ST 目录、连接／API 密钥和应用设置不包含在内；迁往新机器后需重新配置连接、persona 与上下文设置并启用预设和世界书。归档不是加密格式，含完整私人聊天。压缩文件上限 512 MiB，单文件 32 MiB，展开总计 2 GiB，最多 10 万文件；使用 gzip 压缩的版本化 NDJSON，每个文件及归档汇总均校验 SHA-256，不跟随符号链接。

导出快照、导入校验和恢复期间服务暂停资料读写与生成。恢复会重新校验原归档、写入新目录，并原子保存新的 `stDataDir`；当前库完整保留，完成后服务保持暂停，**必须重启服务才会读取新库**。本机连接、密钥和其他设置保持当前值。回退时先停止服务，把实际配置文件（默认 `data/config.json`）的 `stDataDir` 改回界面显示的旧目录，再启动。

归档及导入校验产物保留在数据目录旁的 `.<数据目录名>-maintenance/`，不会打包自身，也不自动删除；失败产物和未激活的新目录不影响当前库，可确认不需要后手动整理。同一进程最多保留 3 份待恢复预览，可取消不需要的预览（磁盘产物仍保留），关闭弹窗会释放预览资格；重启后需重新上传。验证命令 `npm run verify:library`，使用合成数据逐文件比对恢复结果；测试产物保留于 `data/test-runs/library-*/`。

## 持续集成

GitHub Actions 在 push／pull request 时于 Node.js 22、24 下依次执行 `npm ci`、类型检查、构建和 `npm run verify:ci`。回归入口包括 M4、接管、M6、会话回归、兼容、聊天操作、活动诊断、世界书显示、Markdown 渲染和资料库迁移 10 组测试，全部使用合成数据与本地模拟接口。依赖本机资料的 bridge／tools 验证不纳入该入口。失败时上传 `data/test-runs/` 供查看，保留 7 天。配置文件为 `.github/workflows/ci.yml`；远端执行结果需提交推送后查看。

## 架构

```
apps/server   pi-agent-core 引擎 · 每聊天一个 Agent（finishTurn 单回合 / transformContext 压缩位）
              pi-ai createProvider 接任意 OpenAI 兼容中转 · ST 数据格式读写 · HTTP+WS
apps/web      Vite + React + TS + Tailwind · 聊天流（流式渲染/工具卡片） · 面板 · 设置
packages/shared  前后端 WS 事件协议契约
```
