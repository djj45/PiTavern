import fs from "node:fs";
import path from "node:path";
import type { Agent } from "@earendil-works/pi-agent-core";
import type { ChatMessageDto, ServerEvent } from "@pitavern/shared";
import { createTavernAgent, buildSystemPrompt, historyToAgentMessages } from "../agent/engine.ts";
import { createTavernTools, type RecallEnforcement, type ToolContext } from "../agent/tools/index.ts";
import {
  consumeProtocolCalls,
  createProtocolTools,
  extractStreamingContentDelta,
  extractSummary,
  GAME_TOOL_NAME,
  OUTPUT_PROTOCOL_INSTRUCTION,
} from "../agent/protocol/game-content.ts";
import { assembleBridgeContext } from "../context/bridge.ts";
import { substituteMacros } from "../context/macros.ts";
import type { MacroEnv } from "../context/macros.ts";
import type { RegexScript } from "../context/regex.ts";
import { loadPreset, presetsDir } from "../context/preset.ts";
import { normalizeCardBook, normalizeWorldFile, type WiEntry } from "../context/worldinfo.ts";
import type { TavernConfig } from "../config.ts";
import { resolveModel } from "../providers/models.ts";
import type { Models, ToolCall } from "@earendil-works/pi-ai";
import type { CharacterCard } from "../stdata/types.ts";
import type { CharacterStore } from "../stdata/characters.ts";
import type { ChatStore } from "../stdata/chats.ts";

/** 单个聊天的运行时：Agent 引用 + 事件转发 + 召回限次冷却计数 */
class ChatSession {
  agent: Agent | null = null;
  character = "";
  enforcement: RecallEnforcement = { turn: 0, usedThisTurn: 0, cooldownUntilTurn: 0 };
}

export class SessionManager {
  private readonly sessions = new Map<string, ChatSession>();
  private readonly listeners = new Set<(event: ServerEvent) => void>();

  constructor(
    private readonly config: TavernConfig,
    private readonly models: () => Models,
    private readonly characters: CharacterStore,
    private readonly chats: ChatStore,
    private readonly stDataDir: string,
  ) {}

  private emit(event: ServerEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  /** 订阅全部会话事件（WS 层用） */
  onEvent(listener: (event: ServerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  isStreaming(chatId: string): boolean {
    return this.sessions.get(chatId)?.agent?.state.isStreaming ?? false;
  }

  abort(chatId: string): boolean {
    const agent = this.sessions.get(chatId)?.agent;
    if (!agent?.state.isStreaming) return false;
    agent.abort();
    return true;
  }

  /** 用户发言 → 流式生成 → 落库。事件全程广播。 */
  async send(chatId: string, text: string): Promise<void> {
    if (this.isStreaming(chatId)) {
      this.emit({ type: "chat.error", chatId, message: "生成中，请先停止或等待完成" });
      return;
    }
    const lines = this.chats.readChat(chatId);
    if (!lines) {
      this.emit({ type: "chat.error", chatId, message: `聊天不存在: ${chatId}` });
      return;
    }
    const character = this.characters.getCharacter(lines[0]?.name ?? "");
    if (!character) {
      this.emit({ type: "chat.error", chatId, message: `找不到角色卡: ${lines[0]?.name}` });
      return;
    }

    const session = this.ensureSession(chatId, character.name);
    // 用户消息先落库（文件是唯一事实源），并推进剧情轮次/复位本轮召回配额
    this.chats.appendMessage(chatId, { name: this.config.persona.name, is_user: true, is_system: false, mes: text });
    session.enforcement.turn += 1;
    session.enforcement.usedThisTurn = 0;

    const models = this.models();
    const model = resolveModel(models, this.config);

    this.emit({ type: "chat.started", chatId });
    try {
      // 工具上下文：当轮有效（世界书全量条目、含本轮用户消息的历史、存档变量）
      const macroEnv: MacroEnv = {
        char: character.name,
        user: this.config.persona.name,
        personaDescription: this.config.persona.description,
        variables: {},
      };
      const toolCtx: ToolContext = {
        chatId,
        lines: this.chats.readChat(chatId) ?? [],
        worldEntries: this.collectWorldEntries(character),
        variables: (this.chats.readMetadata(chatId).variables as unknown) ?? {},
        skillsDir: path.join(this.stDataDir, "skills"),
        substitute: (s) => substituteMacros(s, macroEnv),
        enforcement: session.enforcement,
        maxRecallsPerTurn: 6,
        recallCooldownTurns: 10,
      };
      const tools = this.config.toolsEnabled ? createTavernTools(toolCtx) : [];
      const useProtocol = this.config.outputProtocol === "game_tool";
      const allTools = useProtocol ? [...tools, ...createProtocolTools()] : tools;

      // 每轮重建 Agent：桥接/简洁两模式统一（工具闭包与组装上下文都依赖当轮状态）
      session.agent?.reset();
      let agent: Agent;
      if (this.config.contextMode === "bridge") {
        agent = this.buildBridgeAgent(chatId, character, model, models, toolCtx, allTools, useProtocol);
        session.agent = agent;
        this.wireAgent(agent, chatId, useProtocol);
        await agent.continue();
      } else {
        agent = createTavernAgent({
          models,
          model,
          chatId,
          thinkingLevel: this.config.thinkingLevel,
          systemPrompt:
            buildSystemPrompt(character, this.config.persona) +
            this.toolGuidance(tools.length > 0) +
            (useProtocol ? `\n\n${OUTPUT_PROTOCOL_INSTRUCTION}` : ""),
          history: historyToAgentMessages(lines),
          tools: allTools,
          outputProtocol: this.config.outputProtocol,
          protocolStrict: this.config.protocolStrict,
          compression: this.config.compression,
        });
        session.agent = agent;
        this.wireAgent(agent, chatId, useProtocol);
        await agent.prompt(text);
      }
    } catch (error) {
      this.emit({ type: "chat.error", chatId, message: error instanceof Error ? error.message : String(error) });
    }
  }

  /** simple 模式下给模型的工具使用指引（桥接模式由预设自行约定） */
  private toolGuidance(hasTools: boolean): string {
    if (!hasTools) return "";
    return [
      "",
      "### 可用工具",
      "- 缺少人物/地点/门派等设定时，先用 worldbook_search 查世界书，不要凭常识编造。",
      "- 需要回忆较早剧情细节时，用 tavern_recall_history 检索（每轮限 6 次；读完整正文后冷却 10 轮）。",
      "- 需要确认好感度/属性等存档数值时，用 tavern_read_variables 只读查询。",
      "工具返回的资料不是当前场景，不得照搬旧台词或让已发生的事件重演。",
    ].join("\n");
  }

  private buildBridgeAgent(
    chatId: string,
    character: CharacterCard,
    model: ReturnType<typeof resolveModel>,
    models: Models,
    toolCtx: ToolContext,
    tools: ReturnType<typeof createTavernTools>,
    useProtocol: boolean,
  ): Agent {
    const presetName = this.config.activePreset;
    const presetFile = presetName ? path.join(presetsDir(this.stDataDir), `${presetName}.json`) : "";
    if (!presetName || !fs.existsSync(presetFile)) {
      throw new Error(`桥接模式未选择有效预设: ${presetName || "(空)"}。请到设置里选择 OpenAI Settings/ 下的预设`);
    }
    const preset = loadPreset(presetFile);
    const regexScripts = ((preset.extensions as { regex_scripts?: RegexScript[] } | undefined)?.regex_scripts ?? []).filter(
      (s) => !s.disabled,
    );
    const assembled = assembleBridgeContext({
      preset,
      card: character,
      persona: this.config.persona,
      chatLines: toolCtx.lines,
      worldEntries: toolCtx.worldEntries,
      regexScripts,
      options: {
        ...this.config.worldInfo,
        // 粗字符预算（≈token*4），M4 的 token 级压缩会取代它
        maxHistoryChars: Math.floor((model.contextWindow || 128_000) * 1.5),
      },
    });
    const messages = [...assembled.messages];
    if (useProtocol) {
      // 协议指令压尾注入（pi 会把 system 重放合并到前部，但内容与顺序保留），
      // 明确覆盖预设里的伪 JSON/预填充输出指令
      messages.push({ role: "system", content: OUTPUT_PROTOCOL_INSTRUCTION, timestamp: Date.now() });
    }
    return createTavernAgent({
      models,
      model,
      chatId,
      thinkingLevel: this.config.thinkingLevel,
      messages,
      sampling: assembled.sampling,
      tools,
      outputProtocol: this.config.outputProtocol,
      protocolStrict: this.config.protocolStrict,
      compression: this.config.compression,
    });
  }

  /** 世界书条目收集：卡内书 + 卡片引用世界 + 全局启用世界，按 world+uid 去重 */
  private collectWorldEntries(card: CharacterCard): WiEntry[] {
    const entries: WiEntry[] = normalizeCardBook(card.characterBook, `${card.name}(卡内书)`);
    const worldsRoot = path.join(this.stDataDir, "worlds");
    const seen = new Set(entries.map((e) => `${e.world}/${e.uid}`));
    const loadWorld = (name: string) => {
      const file = path.join(worldsRoot, `${name}.json`);
      if (!fs.existsSync(file)) return;
      try {
        for (const entry of normalizeWorldFile(JSON.parse(fs.readFileSync(file, "utf8")), name)) {
          const key = `${entry.world}/${entry.uid}`;
          if (!seen.has(key)) {
            seen.add(key);
            entries.push(entry);
          }
        }
      } catch {
        // 世界书损坏时跳过
      }
    };
    if (card.worldName) loadWorld(card.worldName);
    for (const name of this.config.activeWorlds) loadWorld(name);
    return entries;
  }

  private ensureSession(chatId: string, character: string): ChatSession {
    let session = this.sessions.get(chatId);
    if (!session) {
      session = new ChatSession();
      session.character = character;
      this.sessions.set(chatId, session);
    }
    return session;
  }

  /** Agent 事件 → ServerEvent 广播 + 助手消息落库 */
  private wireAgent(agent: Agent, chatId: string, useProtocol: boolean): void {
    // game_tool 流式：按 contentIndex 累积参数原文，宽松提取 content 增量转发
    const streamState = new Map<number, { name: string; raw: string; sent: number }>();

    agent.subscribe((event) => {
      switch (event.type) {
        case "agent_start":
          streamState.clear();
          break;
        case "message_update": {
          const { assistantMessageEvent } = event;
          if (assistantMessageEvent.type === "text_delta") {
            this.emit({ type: "chat.delta", chatId, delta: assistantMessageEvent.delta });
          } else if (assistantMessageEvent.type === "thinking_delta") {
            this.emit({ type: "chat.thinking", chatId, delta: assistantMessageEvent.delta });
          } else if (useProtocol && assistantMessageEvent.type === "toolcall_start") {
            const call = event.message.content[assistantMessageEvent.contentIndex];
            streamState.set(assistantMessageEvent.contentIndex, {
              name: call && typeof call === "object" && call.type === "toolCall" ? call.name : "",
              raw: "",
              sent: 0,
            });
          } else if (useProtocol && assistantMessageEvent.type === "toolcall_delta") {
            const state = streamState.get(assistantMessageEvent.contentIndex);
            if (state) {
              state.raw += assistantMessageEvent.delta;
              if (state.name === GAME_TOOL_NAME) {
                const visible = extractStreamingContentDelta(state.raw);
                if (visible.length > state.sent) {
                  this.emit({ type: "chat.delta", chatId, delta: visible.slice(state.sent) });
                  state.sent = visible.length;
                }
              }
            }
          }
          break;
        }
        case "message_end": {
          if (event.message.role !== "assistant") break;
          const textContent = event.message.content
            .filter((c): c is { type: "text"; text: string } => c.type === "text")
            .map((c) => c.text)
            .join("");
          const toolCalls = event.message.content.filter(
            (c): c is ToolCall => typeof c === "object" && c.type === "toolCall",
          );

          // 输出协议：consumeToolCalls 还原（工具参数 → 正文/思考），普通文本作宽容回退
          let text = textContent;
          let thinking = "";
          if (toolCalls.length > 0) {
            const consumed = consumeProtocolCalls(
              toolCalls.map((c) => ({ name: c.name, arguments: c.arguments, argumentsRaw: c.argumentsError })),
            );
            if (consumed) {
              text = consumed.content || textContent;
              thinking = consumed.thinking;
            }
          }
          if (!text.trim() && !thinking.trim()) break;

          const name = this.sessions.get(chatId)?.character ?? "";
          const summary = extractSummary(text);
          this.chats.appendMessage(chatId, {
            name,
            is_user: false,
            is_system: false,
            mes: text,
            extra: {
              ...(thinking ? { thinking } : {}),
              ...(summary ? { summary } : {}),
              ...(toolCalls.length ? { protocol: "game_tool" } : {}),
            },
          });
          const dto: ChatMessageDto = {
            id: `assistant-${event.message.timestamp}`,
            role: "assistant",
            name,
            text,
            sendDate: new Date(event.message.timestamp).toISOString(),
            ...(thinking ? { thinking } : {}),
          };
          this.emit({ type: "chat.done", chatId, message: dto });
          this.emit({
            type: "chat.usage",
            chatId,
            input: event.message.usage.input,
            output: event.message.usage.output,
            totalTokens: event.message.usage.totalTokens,
            costTotal: event.message.usage.cost.total,
          });
          break;
        }
        case "tool_execution_start":
          this.emit({
            type: "chat.tool_start",
            chatId,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: event.args,
          });
          break;
        case "tool_execution_end":
          this.emit({
            type: "chat.tool_end",
            chatId,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            isError: event.isError,
            durationMs: event.durationMs,
            details: (event.result as { details?: { summary?: string; [key: string]: unknown } } | undefined)?.details,
          });
          break;
        case "agent_end": {
          const error = agent.state.errorMessage;
          if (error) this.emit({ type: "chat.error", chatId, message: error });
          break;
        }
      }
    });
  }

  /** 配置变更后，丢弃缓存的 Agent（下一轮重建） */
  invalidateAll(): void {
    for (const session of this.sessions.values()) {
      session.agent = null;
    }
  }
}
