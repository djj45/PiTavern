# 0.2.0-rc.1 兼容范围

这是独立实现，支持以下常用数据和脚本核心，并非 SillyTavern 全量替代。未配置真实模型或缺少真实大库时，不声称已完成这两项实机验收。

## 角色卡和世界书

- JSON/PNG V2/V3 卡片；资料库同时编辑外部世界书与角色卡内 character_book，包含搜索、复制、冲突检查、草稿和历史恢复。
- 编辑保留未知字段、PNG 像素及其他文本块；同一角色正则与世界书共用文件版本，避免相互覆盖。
- CharX：读取 card.json 与内嵌资源，识别主头像；保存原始归档、所有资源和导入清单。不联网下载远程资源，不提供资源播放/回写归档功能。
- BYAF：转换角色、场景设定、开场、示例、指令、世界书与场景聊天，保留选中回复和候选。多场景分别保留上下文。多角色归档目前仅导入首位并给出警告，完整原始归档留存，不自动转换群聊。
- 归档导入拒绝同名角色、路径穿越、重复条目、链接、文件重叠、无效 CRC、加密、ZIP64 和超限展开；上传上限 24 MiB、单文件 32 MiB、展开总量 128 MiB、最多 2000 条。归档和失败产物保存于资料库 .pitavern/imports/<id>/。

## 群聊

- 2–12 个不同角色，按勾选顺序全员发言，或每轮指定成员；成员从已有卡片选择。
- simple、bridge、takeover 复用原上下文流程；桥接模式遵守预设 marker 开关。各角色用自己的设定、卡内书和显示正则，历史标记发送者。
- 一次用户发言、整轮原子提交；中途失败/停止不保存角色半轮回复。普通发送保留用户消息供重试。
- 重生成沿用原轮发言角色，候选包含整轮多角色回复与状态；重启与 JSONL 导出保留元数据。原版酒馆未必识别这些扩展。
- 当前不读取原版 groups/group chats 目录，不提供自动自然轮换、随机插话、成员中途编辑。BYAF 多角色自动迁移也不在本版范围。

## STscript 核心

入口：聊天顶部「STscript」编辑器，或聊天输入框的 / 开头文本。普通斜杠文本可用 /send /你的文本 明确发送。

| 类别 | 已实现 |
| --- | --- |
| 语法 | 管道、双竖线清管道、双引号、反斜杠转义、双斜杠及块注释、闭包 {: ... :}、命名闭包 /:name、命名参数和默认值 |
| 流程 | /pass、/echo、/return、/break、/abort、/run、/if、/while、/times、/foreach、/delay |
| 作用域 | /let 声明、/var 读写、宏 var；闭包遮蔽与祖先变量访问 |
| 聊天变量 | /getvar、/setvar、/addvar、/incvar、/decvar、/flushvar；get/set 支持 index= JSON 数组/对象索引 |
| 条件 | eq/neq/lt/gt/lte/gte/not/in/nin，支持数值、作用域或聊天变量、文本 |
| 数学 | add/mul/max/min/sub/div/mod/pow/sin/cos/log/abs/sqrt/round/floor/ceil；无效运算或无限结果返回 0 |
| 字符串/JSON | len/trim/trimstart/trimend/tolower/lower/toupper/upper/replace/split/join；replace 是字面替换 |
| 消息 | /messages names=on/off 0-3、/send、/sendas name=角色、/sys、/comment；支持 at= 插入。comment 为不进入上下文的隐藏行 |
| 模型 | /gen 当前上下文生成到管道；/genraw 原始提示；/trigger 为当前角色/群聊全员生成并追加，支持 name= 指定群成员 |
| 宏 | 已有基础宏、getvar/setvar/addvar/incvar/decvar，及 pipe/timesIndex/lastMessageId/lastMessage |

示例：

    /let label 本轮分数 |
    /setvar key=score 0 |
    /times 3 {: /incvar score :} |
    /if left=score right=3 rule=eq else={: /abort 分数错误 :} {:
      /sendas name={{char}} {{var::label}}：{{getvar::score}} |
      /echo 已完成
    :}

    /let multiply {: a=2 b=3 /mul {{var::a}} {{var::b}} :} |
    /:multiply a=4 b=5 |
    /echo 结果为 {{pipe}}

foreach 使用 JSON数组或对象加闭包，闭包内提供 var::item、var::index、var::key，输出结果数组。times 提供从零开始的 timesIndex。闭包第一条命令不隐式接收父管道，可显式使用 pipe 宏。

### 事务与限制

- 脚本在聊天/变量副本执行，成功后原子保存并备份。失败、取消或版本冲突不保存部分消息/变量，未知原始行仍保留。
- 每个聊天禁止脚本与普通生成并发。编辑器或聊天「停止」可取消；模型已发生的费用不能回滚，活动记录保留。
- 添加/插入消息或改变变量会清理失效的旧候选检查点、投影和计时缓存。脚本 trigger 不创建普通候选目录；需要候选时使用普通生成。
- 最多 20 万源码字符、1 万步、60 秒、32 层闭包、每值/变量合计 100 万字符、最多新增 100 条消息、100 条 echo。循环默认最多 100 次；guard=off 仍受全局上限约束，foreach 最多 1000 项，delay 最多 5 秒。
- 不执行任意 JS、shell、扩展命令、全局变量、DOM 操作、远程加载脚本、弹窗输入或立即执行闭包。未实现命令和命名参数明确报错，不能把任意原版脚本称作已兼容。
- 模型命令使用配置快照，不开放工具执行；桥接复用预设组装，但脚本生成暂不执行向量召回和世界书计时推进。普通群聊使用完整原生成流程。
- echo 的 title/severity 作为兼容参数接受，统一显示文本；不复刻原版弹窗样式。斜杠命令正则位置不自动应用到脚本。

语法依据：SillyTavern 官方 [STscript Language Reference](https://docs.sillytavern.app/for-contributors/st-script/)。实现为独立解析器，不使用 eval。
