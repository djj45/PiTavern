import fs from "node:fs";
import path from "node:path";
import type { Agent } from "@earendil-works/pi-agent-core";
import type { ChatMessageDto, ServerEvent } from "@pitavern/shared";
import { createTavernAgent, buildSystemPrompt, historyToAgentMessages } from "../agent/engine.ts";
import { assembleBridgeContext } from "../context/bridge.ts";
import type { RegexScript } from "../context/regex.ts";
import { loadPreset, presetsDir } from "../context/preset.ts";
import { normalizeCardBook, normalizeWorldFile, type WiEntry } from "../context/worldinfo.ts";
import type { TavernConfig } from "../config.ts";
import { resolveModel } from "../providers/models.ts";
import type { Models } from "@earendil-works/pi-ai";
import type { CharacterCard } from "../stdata/types.ts";
import type { CharacterStore } from "../stdata/characters.ts";
import type { ChatStore } from "../stdata/chats.ts";

/** 单个聊天的运行时：Agent 实例缓存 + 事件转发 + 落库 */
class ChatSession {
  agent: Agent | null = null;
  agentKey = "";
  character = "";
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

    // 用户消息先落库（文件是唯一事实源）
    this.chats.appendMessage(chatId, { name: this.config.persona.name, is_user: true, is_system: false, mes: text });

    const models = this.models();
    const model = resolveModel(models, this.config);
    const session = this.ensureSession(chatId, character.name);

    this.emit({ type: "chat.started", chatId });
    try {
      if (this.config.contextMode === "bridge") {
        await this.runBridgeTurn(chatId, session, character, model, models);
      } else {
        await this.runSimpleTurn(chatId, session, character, model, models, text);
      }
    } catch (error) {
      this.emit({ type: "chat.error", chatId, message: error instanceof Error ? error.message : String(error) });
    }
  }

  /** simple 模式：Agent 跨轮缓存，本轮用户消息经 prompt() 追加 */
  private async runSimpleTurn(
    chatId: string,
    session: ChatSession,
    character: CharacterCard,
    model: ReturnType<typeof resolveModel>,
    models: Models,
    text: string,
  ): Promise<void> {
    const modelKey = `simple:${model.provider}/${model.id}/${this.config.thinkingLevel}`;
    if (!session.agent || session.agentKey !== modelKey) {
      session.agent?.reset();
      session.agent = createTavernAgent({
        models,
        model,
        chatId,
        thinkingLevel: this.config.thinkingLevel,
        systemPrompt: buildSystemPrompt(character, this.config.persona),
        history: historyToAgentMessages(this.chats.readChat(chatId) ?? []),
      });
      session.agentKey = modelKey;
      this.wireAgent(session.agent, chatId);
    }
    await session.agent.prompt(text);
  }

  /** bridge 模式：每轮按预设重新组装完整上下文（世界书扫描依赖最新历史），Agent 一次性 */
  private async runBridgeTurn(
    chatId: string,
    session: ChatSession,
    character: CharacterCard,
    model: ReturnType<typeof resolveModel>,
    models: Models,
  ): Promise<void> {
    const presetName = this.config.activePreset;
    const presetFile = presetName ? path.join(presetsDir(this.stDataDir), `${presetName}.json`) : "";
    if (!presetName || !fs.existsSync(presetFile)) {
      throw new Error(`桥接模式未选择有效预设: ${presetName || "(空)"}。请到设置里选择 OpenAI Settings/ 下的预设`);
    }
    const preset = loadPreset(presetFile);
    const regexScripts = ((preset.extensions as { regex_scripts?: RegexScript[] } | undefined)?.regex_scripts ?? []).filter(
      (s) => !s.disabled,
    );
    const worldEntries = this.collectWorldEntries(character);
    const assembled = assembleBridgeContext({
      preset,
      card: character,
      persona: this.config.persona,
      chatLines: this.chats.readChat(chatId) ?? [],
      worldEntries,
      regexScripts,
      options: {
        ...this.config.worldInfo,
        // 粗字符预算（≈token*4），M4 的 token 级压缩会取代它
        maxHistoryChars: Math.floor((model.contextWindow || 128_000) * 1.5),
      },
    });

    session.agent?.reset();
    const agent = createTavernAgent({
      models,
      model,
      chatId,
      thinkingLevel: this.config.thinkingLevel,
      messages: assembled.messages,
      sampling: assembled.sampling,
    });
    session.agent = agent;
    session.agentKey = `bridge:${model.provider}/${model.id}/${presetName}`;
    this.wireAgent(agent, chatId);
    await agent.continue();
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
  private wireAgent(agent: Agent, chatId: string): void {
    agent.subscribe((event) => {
      switch (event.type) {
        case "message_update": {
          const { assistantMessageEvent } = event;
          if (assistantMessageEvent.type === "text_delta") {
            this.emit({ type: "chat.delta", chatId, delta: assistantMessageEvent.delta });
          } else if (assistantMessageEvent.type === "thinking_delta") {
            this.emit({ type: "chat.thinking", chatId, delta: assistantMessageEvent.delta });
          }
          break;
        }
        case "message_end": {
          if (event.message.role !== "assistant") break;
          const text = event.message.content
            .filter((c): c is { type: "text"; text: string } => c.type === "text")
            .map((c) => c.text)
            .join("");
          if (!text.trim()) break;
          const name = this.sessions.get(chatId)?.character ?? "";
          this.chats.appendMessage(chatId, { name, is_user: false, is_system: false, mes: text });
          const dto: ChatMessageDto = {
            id: `assistant-${event.message.timestamp}`,
            role: "assistant",
            name,
            text,
            sendDate: new Date(event.message.timestamp).toISOString(),
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

  /** 配置或模型变更后，丢弃缓存的 Agent（下轮重建，系统提示词/模型都会刷新） */
  invalidateAll(): void {
    for (const session of this.sessions.values()) {
      session.agent = null;
      session.agentKey = "";
    }
  }
}
