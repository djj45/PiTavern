import fs from "node:fs";
import path from "node:path";
import type { Agent } from "@earendil-works/pi-agent-core";
import type { ChatSnapshotDto, ServerEvent } from "@pitavern/shared";
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
import { chatMessages, type ChatStore } from "../stdata/chats.ts";

/** 单个聊天的运行时：Agent 引用 + 事件转发 + 召回限次冷却计数 */
class ChatSession {
  agent: Agent | null = null;
  character = "";
  running = false;
  streamingText = "";
  aborted = false;
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
    if ("chatId" in event) {
      const session = this.sessions.get(event.chatId);
      if (session) {
        if (event.type === "chat.delta") session.streamingText += event.delta;
        if (event.type === "chat.started" || event.type === "chat.done" || event.type === "chat.finished") session.streamingText = "";
      }
    }
    for (const listener of this.listeners) listener(event);
  }

  /** 订阅全部会话事件（WS 层用） */
  onEvent(listener: (event: ServerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  isStreaming(chatId: string): boolean {
    return this.sessions.get(chatId)?.running ?? false;
  }

  abort(chatId: string): boolean {
    const session = this.sessions.get(chatId);
    if (!session?.running || !session.agent) return false;
    session.aborted = true;
    session.agent.abort();
    return true;
  }

  snapshot(chatId: string): ChatSnapshotDto | null {
    const document = this.chats.readDocument(chatId);
    if (!document) return null;
    const session = this.sessions.get(chatId);
    return {
      id: chatId, character: document.character, messages: chatMessages(document.lines),
      running: session?.running ?? false, streamingText: session?.streamingText ?? "",
    };
  }

  /** 用户发言 → 流式生成 → 落库。配置在回合开始时固定。 */
  async send(chatId: string, text: string): Promise<void> {
    if (this.isStreaming(chatId)) {
      this.emit({ type: "chat.error", chatId, message: "生成中，请先停止或等待完成" });
      return;
    }
    const session = this.ensureSession(chatId, "");
    session.running = true;
    session.aborted = false;
    session.streamingText = "";
    try {
      const config = structuredClone(this.config);
      const document = this.chats.readDocument(chatId);
      if (!document) throw new Error(`聊天不存在: ${chatId}`);
      const character = this.characters.getCharacter(document.character);
      if (!character) throw new Error(`找不到角色卡: ${document.character}`);
      session.character = character.name;
      const models = this.models();
      const model = resolveModel(models, config);
      const userLine = this.chats.appendMessage(chatId, {
        name: config.persona.name, is_user: true, is_system: false, mes: text,
      });
      session.enforcement.turn += 1;
      session.enforcement.usedThisTurn = 0;
      this.emit({ type: "chat.started", chatId, message: chatMessages([userLine])[0] });
      const macroEnv: MacroEnv = {
        char: character.name, user: config.persona.name,
        personaDescription: config.persona.description,
        variables: document.metadata.variables as Record<string, unknown> ?? {},
      };
      const toolCtx: ToolContext = {
        chatId,
        lines: [...document.lines, userLine],
        worldEntries: this.collectWorldEntries(character, config),
        variables: document.metadata.variables ?? {},
        skillsDir: path.join(this.stDataDir, "skills"),
        substitute: (s) => substituteMacros(s, macroEnv),
        enforcement: session.enforcement,
        maxRecallsPerTurn: 6,
        recallCooldownTurns: 10,
      };
      const tools = config.toolsEnabled ? createTavernTools(toolCtx) : [];
      const useProtocol = config.outputProtocol === "game_tool";
      const allTools = useProtocol ? [...tools, ...createProtocolTools()] : tools;
      const agent = config.contextMode === "bridge"
        ? this.buildBridgeAgent(chatId, character, model, models, toolCtx, allTools, useProtocol, config)
        : createTavernAgent({
            models, model, chatId, thinkingLevel: config.thinkingLevel,
            systemPrompt: buildSystemPrompt(character, config.persona) + this.toolGuidance(tools.length > 0) +
              (useProtocol ? `\n\n${OUTPUT_PROTOCOL_INSTRUCTION}` : ""),
            history: historyToAgentMessages(document.lines), tools: allTools,
            outputProtocol: config.outputProtocol, protocolStrict: config.protocolStrict,
            compression: config.compression,
          });
      session.agent = agent;
      this.wireAgent(agent, chatId, useProtocol);
      if (config.contextMode === "bridge") await agent.continue();
      else await agent.prompt(text);
      if (agent.state.errorMessage && !session.aborted) {
        this.emit({ type: "chat.error", chatId, message: agent.state.errorMessage });
      }
    } catch (error) {
      this.emit({ type: "chat.error", chatId, message: error instanceof Error ? error.message : String(error) });
    } finally {
      session.running = false;
      session.agent = null;
      this.emit({ type: "chat.finished", chatId });
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
    config: TavernConfig,
  ): Agent {
    const presetName = config.activePreset;
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
      persona: config.persona,
      chatLines: toolCtx.lines,
      worldEntries: toolCtx.worldEntries,
      regexScripts,
      options: {
        ...config.worldInfo,
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
      thinkingLevel: config.thinkingLevel,
      messages,
      sampling: assembled.sampling,
      tools,
      outputProtocol: config.outputProtocol,
      protocolStrict: config.protocolStrict,
      compression: config.compression,
    });
  }

  /** 世界书条目收集：卡内书 + 卡片引用世界 + 全局启用世界，按 world+uid 去重 */
  private collectWorldEntries(card: CharacterCard, config: TavernConfig): WiEntry[] {
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
    for (const name of config.activeWorlds) loadWorld(name);
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
          this.emit({
            type: "chat.usage",
            chatId,
            input: event.message.usage.input,
            output: event.message.usage.output,
            totalTokens: event.message.usage.totalTokens,
            costTotal: event.message.usage.cost.total,
          });
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
          const saved = this.chats.appendMessage(chatId, {
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
          this.emit({ type: "chat.done", chatId, message: chatMessages([saved])[0] });
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
      }
    });
  }

  /** 配置变更仅清理空闲引用，运行中的 Agent 使用本轮配置快照直到结束。 */
  invalidateAll(): void {
    for (const session of this.sessions.values()) {
      if (!session.running) session.agent = null;
    }
  }
}
