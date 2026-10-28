import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Agent } from "@earendil-works/pi-agent-core";
import type { AuthorNoteDto, AuthorNoteSnapshotDto, ChatDisplayDto, ChatSnapshotDto, GenerationRecordDto, ServerEvent } from "@pitavern/shared";
import { createTavernAgent, buildSystemPrompt, historyToAgentMessages, type TavernAgentOptions } from "../agent/engine.ts";
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
import { assembleTakeoverContext } from "../context/takeover.ts";
import { substituteMacros } from "../context/macros.ts";
import type { MacroEnv } from "../context/macros.ts";
import { normalizeRegexScripts } from "../context/regex.ts";
import { readAuthorNote } from "../context/author-note.ts";
import { loadPreset, presetsDir } from "../context/preset.ts";
import { normalizeCardBook, normalizeWorldFile, normalizeTimedState, type WiEntry } from "../context/worldinfo.ts";
import type { TavernConfig } from "../config.ts";
import { resolveModel } from "../providers/models.ts";
import type { Models, ToolCall } from "@earendil-works/pi-ai";
import type { CharacterCard, StChatLine } from "../stdata/types.ts";
import type { CharacterStore } from "../stdata/characters.ts";
import { chatMessages, type ChatStore } from "../stdata/chats.ts";
import { createSetStateTool } from "../agent/tools/set-state.ts";
import { retrieveVectorEntries } from "../context/vectors.ts";
import { replyChoices, stateFields, validEnforcement } from "../stdata/replies.ts";
import { ActivityStore, emptyUsage } from "../stdata/activity.ts";
import { createTokenCounter } from "../context/tokens.ts";

type ContextHooks = Pick<TavernAgentOptions, "tokenCounter" | "instruct" | "onContext">;

/** 单个聊天的运行时：Agent 引用 + 事件转发 + 召回限次冷却计数 */
class ChatSession {
  agent: Agent | null = null;
  character = "";
  running = false;
  streamingText = "";
  aborted = false;
  controller: AbortController | null = null;
  generation: GenerationRecordDto | null = null;
  activityError?: string;
  enforcement: RecallEnforcement = { turn: 0, usedThisTurn: 0, cooldownUntilTurn: 0 };
}

export class SessionManager {
  private readonly sessions = new Map<string, ChatSession>();
  private readonly listeners = new Set<(event: ServerEvent) => void>();
  private readonly activity: ActivityStore;

  constructor(
    private readonly config: TavernConfig,
    private readonly models: () => Models,
    private readonly characters: CharacterStore,
    private readonly chats: ChatStore,
    private readonly stDataDir: string,
  ) { this.activity = new ActivityStore(stDataDir); }

  activityPage(chatId: string, before?: string) { return this.activity.page(chatId, before); }

  private activitySnapshot(chatId: string) {
    return this.activity.snapshot(chatId, this.chats.readChat(chatId)?.filter((line) => line.is_user && !line.is_system).length ?? 0);
  }

  private saveActivity(chatId: string, generation: GenerationRecordDto): void {
    try {
      this.activity.save(chatId, generation);
      const session = this.sessions.get(chatId);
      if (session) session.activityError = undefined;
    } catch (cause) {
      const message = "生成记录保存失败，统计可能不完整：" + (cause instanceof Error ? cause.message : String(cause));
      const session = this.sessions.get(chatId);
      if (session) session.activityError = message;
      throw new Error(message);
    }
    this.emit({ type: "chat.activity", chatId, activity: this.activitySnapshot(chatId) });
  }

  private emit(event: ServerEvent): void {
    if ("chatId" in event) {
      const session = this.sessions.get(event.chatId);
      if (session) {
        if (event.type === "chat.delta") session.streamingText += event.delta;
        if (event.type === "chat.started" || event.type === "chat.done" || event.type === "chat.finished") session.streamingText = "";
        const run = session.generation;
        if (run && event.type === "chat.tool_start") {
          run.tools.push({ key: `${run.id}:${run.tools.length}`, toolCallId: event.toolCallId,
            toolName: event.toolName, args: structuredClone(event.args), status: "running" });
          this.saveActivity(event.chatId, run);
        } else if (run && event.type === "chat.tool_end") {
          const tool = run.tools.findLast((item) => item.toolCallId === event.toolCallId && item.status === "running");
          if (tool) Object.assign(tool, { status: event.isError ? "error" : "done", summary: event.details?.summary, durationMs: event.durationMs });
          this.saveActivity(event.chatId, run);
        }
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
    if (!session?.running) return false;
    session.aborted = true;
    session.controller?.abort();
    session.agent?.abort();
    return true;
  }

  snapshot(chatId: string, full = false): ChatSnapshotDto | null {
    const document = this.chats.readDocument(chatId);
    if (!document) return null;
    const session = this.sessions.get(chatId);
    const projection = typeof document.metadata.projection === "string" ? document.metadata.projection : undefined;
    const { messages, ...page } = this.chats.page(chatId);
    const choices = replyChoices(document.lines);
    let activity: ChatSnapshotDto["activity"];
    let activityError = session?.activityError;
    try { activity = this.activitySnapshot(chatId); }
    catch (cause) { activityError = "生成记录读取失败：" + (cause instanceof Error ? cause.message : String(cause)); }
    return {
      id: chatId, character: document.character, messages: full ? chatMessages(document.lines) : messages,
      ...(!full ? { page } : {}),
      ...(choices ? { replyChoices: choices } : {}),
      running: session?.running ?? false, streamingText: session?.streamingText ?? "",
      activity, activityError,
      display: this.displayConfig(document.character, document.metadata, document.lines),
      ...(projection ? { projection } : {}),
    };
  }

  private displayConfig(characterName: string, metadata: Record<string, unknown>, lines: StChatLine[]): ChatDisplayDto {
    const character = this.characters.getCharacter(characterName);
    let presetScripts: ReturnType<typeof normalizeRegexScripts> = [];
    if (this.config.contextMode === "bridge" && this.config.activePreset) {
      try {
        const preset = loadPreset(path.join(presetsDir(this.stDataDir), `${this.config.activePreset}.json`));
        presetScripts = normalizeRegexScripts(preset.extensions?.regex_scripts);
      } catch { /* 预设读取错误在生成时报告；不阻断已有聊天的显示。 */ }
    }
    return {
      scripts: [...presetScripts, ...normalizeRegexScripts(character?.extensions.regex_scripts)].filter((script) => !script.disabled),
      char: character?.name ?? characterName, user: this.config.persona.name,
      personaDescription: this.config.persona.description,
      variables: metadata.variables && typeof metadata.variables === "object" && !Array.isArray(metadata.variables)
        ? metadata.variables as Record<string, unknown> : {},
      lastUserMessage: lines.findLast((line) => line.is_user && !line.is_system)?.mes,
    };
  }

  authorNote(chatId: string): AuthorNoteSnapshotDto {
    const document = this.chats.readDocument(chatId);
    if (!document) throw new Error("聊天不存在");
    return { note: readAuthorNote(document.metadata), revision: this.chats.revisionId(chatId), contextMode: this.config.contextMode };
  }

  saveAuthorNote(chatId: string, note: AuthorNoteDto, revision: string): void {
    if (this.isStreaming(chatId)) throw new Error("请先停止生成，再编辑作者注释");
    this.chats.saveAuthorNote(chatId, note, revision);
    this.changed(chatId);
  }

  editMessage(chatId: string, messageId: string, text: string, expectedText: string): void {
    if (this.isStreaming(chatId)) throw new Error("请先停止生成，再编辑消息");
    this.chats.editMessage(chatId, messageId, text, expectedText);
    this.changed(chatId);
  }

  private changed(chatId: string): void {
    const session = this.sessions.get(chatId);
    if (session) {
      const saved = this.chats.readMetadata(chatId)._pitavernEnforcement;
      session.enforcement = validEnforcement(saved) ? structuredClone(saved)
        : { turn: this.chats.readChat(chatId)?.filter((line) => line.is_user).length ?? 0, usedThisTurn: 0, cooldownUntilTurn: 0 };
    }
    const snapshot = this.snapshot(chatId);
    if (snapshot) this.emit({ type: "chat.snapshot", chatId, snapshot });
  }

  selectReply(chatId: string, userMessageId: string, selected: number, revision: string): void {
    if (this.isStreaming(chatId)) throw new Error("请先停止生成，再切换候选回复");
    this.chats.selectReply(chatId, userMessageId, selected, revision);
    this.changed(chatId);
  }

  restoreBackup(chatId: string, backupId: string, revision: string): void {
    if (this.isStreaming(chatId)) throw new Error("请先停止生成，再恢复备份");
    this.chats.restoreBackup(chatId, backupId, revision);
    this.changed(chatId);
  }

  send(chatId: string, text: string): Promise<void> {
    return this.generate(chatId, text);
  }

  regenerate(chatId: string, messageId: string, expectedText: string): Promise<void> {
    return this.generate(chatId, "", { messageId, expectedText });
  }

  /** Both normal sends and regeneration stage state and replies until the entire turn succeeds. */
  private async generate(chatId: string, text: string, replacement?: { messageId: string; expectedText: string }): Promise<void> {
    if (this.isStreaming(chatId)) {
      this.emit({ type: "chat.error", chatId, message: "生成中，请先停止或等待完成" });
      return;
    }
    const session = this.ensureSession(chatId, "");
    session.running = true;
    session.aborted = false;
    session.streamingText = "";
    session.controller = new AbortController();
    session.generation = null;
    const previousEnforcement = structuredClone(session.enforcement);
    let committed = false;
    try {
      const config = structuredClone(this.config);
      const stored = this.chats.readDocument(chatId);
      if (!stored) throw new Error(`聊天不存在: ${chatId}`);
      const regeneration = replacement ? this.chats.prepareRegeneration(chatId, replacement.messageId, replacement.expectedText) : undefined;
      const document = regeneration ? { ...stored, lines: regeneration.history, metadata: regeneration.metadata } : stored;
      const generated: StChatLine[] = [];
      const pendingMetadata = structuredClone(document.metadata);
      const writeMetadata = (patch: Record<string, unknown>) => { Object.assign(pendingMetadata, patch); };
      const character = this.characters.getCharacter(document.character);
      if (!character) throw new Error(`找不到角色卡: ${document.character}`);
      session.character = character.name;
      const models = this.models();
      const model = resolveModel(models, config);
      const textCompletion = model.api === "openai-text-completions";
      if (textCompletion && config.contextMode === "takeover") throw new Error("文本补全接口不能使用依赖工具召回的 Agent 接管模式，请选择简洁或 ST 桥接模式");
      if (textCompletion && config.outputProtocol === "game_tool") throw new Error("文本补全接口不支持 game_tool，请将输出协议设为原生文本流式");
      const variables = structuredClone(document.metadata.variables && typeof document.metadata.variables === "object" && !Array.isArray(document.metadata.variables)
        ? document.metadata.variables as Record<string, unknown> : {});
      const beforeTurn = {
        metadata: stateFields(document.metadata),
        enforcement: structuredClone(session.enforcement),
      };
      const userLine = regeneration?.user ?? this.chats.appendMessage(chatId, {
        name: config.persona.name, is_user: true, is_system: false, mes: text,
        extra: { _pitavernBeforeTurn: beforeTurn },
      });
      const transaction = regeneration ?? this.chats.prepareRegeneration(chatId, String(userLine.extra!.messageId), userLine.mes, false);
      const generation: GenerationRecordDto = {
        id: this.activity.createId(chatId), version: 0, userMessageId: String(userLine.extra?.messageId ?? `line-${document.lines.length}`),
        kind: replacement ? (replyChoices(stored.lines)?.count ? "regenerate" : "retry") : "send",
        provider: model.provider, model: model.id, startedAt: new Date().toISOString(), status: "running", usage: emptyUsage(), tools: [],
      };
      session.generation = generation;
      this.saveActivity(chatId, generation);
      const provider = config.providers.find((item) => item.id === model.provider);
      const contextHooks: ContextHooks = {
        tokenCounter: createTokenCounter(model.id, provider?.models.find((item) => item.id === model.id)?.tokenizer),
        instruct: provider?.instruct,
        onContext: (context) => { generation.context = context; this.saveActivity(chatId, generation); },
      };
      text = userLine.mes;
      if (regeneration) {
        const prior = (userLine.extra?._pitavernBeforeTurn as typeof beforeTurn | undefined)?.enforcement;
        session.enforcement = prior && [prior.turn, prior.usedThisTurn, prior.cooldownUntilTurn].every((n) => Number.isInteger(n) && n >= 0)
          ? structuredClone(prior) : { turn: document.lines.filter((line) => line.is_user).length, usedThisTurn: 0, cooldownUntilTurn: 0 };
      }
      session.enforcement.turn += 1;
      session.enforcement.usedThisTurn = 0;
      if (regeneration) this.emit({ type: "chat.regenerating", chatId });
      else this.emit({ type: "chat.started", chatId, message: chatMessages([userLine])[0] });
      const macroEnv: MacroEnv = {
        char: character.name, user: config.persona.name,
        personaDescription: config.persona.description,
        variables,
        lastUserMessage: text,
      };
      const toolCtx: ToolContext = {
        chatId,
        lines: [...document.lines, userLine],
        worldEntries: this.collectWorldEntries(character, config),
        variables,
        skillsDir: path.join(this.stDataDir, "skills"),
        substitute: (s) => substituteMacros(s, { ...macroEnv, variables: structuredClone(variables) }),
        enforcement: session.enforcement,
        maxRecallsPerTurn: 6,
        recallCooldownTurns: 10,
      };
      let tools = config.toolsEnabled && !textCompletion ? createTavernTools(toolCtx) : [];
      const useProtocol = config.outputProtocol === "game_tool";
      if (config.contextMode === "takeover" && config.takeover.stateProjection) {
        // 状态投影：工具写 chat_metadata.projection，下一轮组装回注 system section
        toolCtx.setState = (projection: string) => {
          writeMetadata({ projection });
          if (!regeneration) this.emit({ type: "chat.projection", chatId, projection });
        };
        tools = [...tools, createSetStateTool(toolCtx)];
      }
      const allTools = useProtocol ? [...tools, ...createProtocolTools()] : tools;
      // 计时效果状态（sticky/cooldown）：从元数据恢复，扫描内更新，组装后回写
      const timedState =
        config.contextMode === "bridge" ? normalizeTimedState(document.metadata.timedWorldInfo) : undefined;
      const previewEnv = { ...macroEnv, variables: structuredClone(variables) };
      const vectorMatches = config.contextMode === "bridge" ? await retrieveVectorEntries(
        config, toolCtx.worldEntries,
        toolCtx.lines.filter((line) => !line.is_system).map((line) => substituteMacros(line.mes, previewEnv)),
        this.stDataDir, session.controller.signal,
      ) : undefined;
      session.controller.signal.throwIfAborted();
      const agent = config.contextMode === "bridge"
        ? this.buildBridgeAgent(chatId, character, model, models, toolCtx, allTools, useProtocol, config, contextHooks, timedState, vectorMatches, document.metadata)
        : config.contextMode === "takeover"
          ? this.buildTakeoverAgent(model, models, toolCtx, allTools, useProtocol, config, { ...document.metadata, variables }, character, contextHooks)
          : createTavernAgent({
              models, model, chatId, thinkingLevel: config.thinkingLevel,
              templateNames: { char: character.name, user: config.persona.name },
              systemPrompt: substituteMacros(buildSystemPrompt(character, config.persona), macroEnv) + this.toolGuidance(tools.length > 0) +
                (useProtocol ? `\n\n${OUTPUT_PROTOCOL_INSTRUCTION}` : ""),
              history: historyToAgentMessages(document.lines.map((line) => ({ ...line, mes: substituteMacros(line.mes, macroEnv) }))), tools: allTools,
              outputProtocol: config.outputProtocol, protocolStrict: config.protocolStrict,
              compression: config.compression,
              ...contextHooks,
              contextAssembly: { mode: "simple", historyMessages: toolCtx.lines.filter((line) => !line.is_system && line.mes.trim()).length,
                omittedHistoryMessages: 0, worldInfoTotal: toolCtx.worldEntries.length,
                worldInfo: toolCtx.worldEntries.slice(0, 200).map((entry) => ({ uid: entry.uid, world: entry.world,
                  label: entry.key.join("、").slice(0, 80) || entry.uid, status: "skipped", reason: "简洁模式不自动注入世界书" })) },
            });
      session.agent = agent;
      this.wireAgent(agent, chatId, useProtocol, generated);
      writeMetadata({ variables, ...(timedState ? { timedWorldInfo: timedState } : {}) });
      if (config.contextMode === "simple") {
        const prompt = substituteMacros(text, macroEnv);
        writeMetadata({ variables });
        await agent.prompt(prompt);
      }
      else await agent.continue();
      if (agent.state.errorMessage && !session.aborted) throw new Error(agent.state.errorMessage);
      if (!session.aborted) {
        if (!generated.some((line) => line.mes.trim())) throw new Error(regeneration ? "模型未返回正文，已保留原回复" : "模型未返回正文，状态未改变，可重试本轮");
        pendingMetadata._pitavernEnforcement = structuredClone(session.enforcement);
        transaction.commit(generated, pendingMetadata);
        committed = true;
        if (!regeneration) for (const line of generated) this.emit({ type: "chat.done", chatId, message: chatMessages([line])[0] });
      }
    } catch (error) {
      if (session.generation && !session.aborted) session.generation.error = error instanceof Error ? error.message : String(error);
      if (!session.aborted) this.emit({ type: "chat.error", chatId, message: error instanceof Error ? error.message : String(error) });
    } finally {
      session.running = false;
      session.agent = null;
      session.controller = null;
      if (!committed) session.enforcement = previousEnforcement;
      if (session.generation) {
        const run = session.generation;
        run.status = committed ? "succeeded" : session.aborted ? "aborted" : "failed";
        run.finishedAt = new Date().toISOString();
        for (const tool of run.tools) if (tool.status === "running") {
          tool.status = "error"; tool.summary = session.aborted ? "本轮已停止" : "本轮已结束";
        }
        try { this.saveActivity(chatId, run); }
        catch (error) { this.emit({ type: "chat.error", chatId, message: (error as Error).message }); }
        finally { session.generation = null; }
      }
      const snapshot = this.snapshot(chatId);
      if (snapshot) this.emit({ type: "chat.snapshot", chatId, snapshot, append: !replacement && committed });
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
    contextHooks: ContextHooks,
    timedState?: import("../context/worldinfo.ts").TimedEffectsState,
    vectorMatches?: ReadonlySet<string>,
    metadata?: Record<string, unknown>,
  ): Agent {
    const presetName = config.activePreset;
    const presetFile = presetName ? path.join(presetsDir(this.stDataDir), `${presetName}.json`) : "";
    if (!presetName || !fs.existsSync(presetFile)) {
      throw new Error(`桥接模式未选择有效预设: ${presetName || "(空)"}。请到设置里选择 OpenAI Settings/ 下的预设`);
    }
    const preset = loadPreset(presetFile);
    const regexScripts = [...normalizeRegexScripts(preset.extensions?.regex_scripts), ...normalizeRegexScripts(character.extensions.regex_scripts)];
    const assembled = assembleBridgeContext({
      preset,
      card: character,
      persona: config.persona,
      chatLines: toolCtx.lines,
      worldEntries: toolCtx.worldEntries,
      regexScripts,
      variables: toolCtx.variables as Record<string, unknown>,
      metadata,
      options: {
        ...config.worldInfo,
        countTokens: contextHooks.tokenCounter?.count,
        vectorMatches,
        ...(timedState ? { timed: timedState, messageCount: toolCtx.lines.length } : {}),
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
      templateNames: { char: character.name, user: config.persona.name },
      messages,
      sampling: assembled.sampling,
      tools,
      outputProtocol: config.outputProtocol,
      protocolStrict: config.protocolStrict,
      compression: config.compression,
      ...contextHooks,
      contextAssembly: { mode: "bridge", historyMessages: assembled.stats.historyMessages, omittedHistoryMessages: 0,
        promptEntries: assembled.stats.promptEntries, absoluteInjections: assembled.stats.absoluteInjections,
        worldInfoTotal: assembled.worldInfo.length, worldInfo: assembled.worldInfo.slice(0, 200) },
    });
  }

  /** 接管模式：sections 化 system + 常驻世界书 + 近 recentTurns 轮历史 + 状态投影回注 */
  private buildTakeoverAgent(
    model: ReturnType<typeof resolveModel>,
    models: Models,
    toolCtx: ToolContext,
    tools: ReturnType<typeof createTavernTools>,
    useProtocol: boolean,
    config: TavernConfig,
    metadata: Record<string, unknown>,
    character: CharacterCard,
    contextHooks: ContextHooks,
  ): Agent {
    const assembled = assembleTakeoverContext({
      card: character,
      persona: config.persona,
      chatLines: toolCtx.lines,
      worldEntries: toolCtx.worldEntries,
      metadata,
      options: {
        recentTurns: config.takeover.recentTurns,
        stateProjection: config.takeover.stateProjection,
        useProtocol,
      },
    });
    return createTavernAgent({
      models,
      model,
      chatId: toolCtx.chatId,
      thinkingLevel: config.thinkingLevel,
      messages: assembled.messages,
      tools,
      outputProtocol: config.outputProtocol,
      protocolStrict: config.protocolStrict,
      compression: config.compression,
      ...contextHooks,
      contextAssembly: { mode: "takeover", historyMessages: assembled.stats.historyMessages,
        omittedHistoryMessages: assembled.stats.droppedMessages, worldInfoTotal: toolCtx.worldEntries.length,
        worldInfo: toolCtx.worldEntries.slice(0, 200).map((entry) => ({ uid: entry.uid, world: entry.world,
          label: entry.key.join("、").slice(0, 80) || entry.uid,
          status: entry.constant && !entry.disabled && entry.content.trim() ? "included" : "skipped",
          reason: entry.disabled ? "已禁用" : !entry.content.trim() ? "内容为空" : entry.constant ? "常驻条目" : "接管模式按需检索" })) },
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
      const saved = this.chats.readMetadata(chatId)._pitavernEnforcement;
      if (validEnforcement(saved)) session.enforcement = structuredClone(saved);
      this.sessions.set(chatId, session);
    }
    return session;
  }

  /** Agent events stream immediately; assistant messages remain staged until the turn commits. */
  private wireAgent(agent: Agent, chatId: string, useProtocol: boolean, generated: StChatLine[]): void {
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
          const run = this.sessions.get(chatId)?.generation;
          if (run) {
            const usage = event.message.usage;
            const amount = (value: number) => Number.isFinite(value) && value >= 0 ? value : 0;
            for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) run.usage[key] += amount(usage[key]);
            run.usage.costTotal += amount(usage.cost.total);
            run.usage.responses++;
            if (usage.totalTokens > 0 || usage.input > 0 || usage.output > 0 || usage.cacheRead > 0 || usage.cacheWrite > 0) run.usage.responsesWithUsage++;
            this.saveActivity(chatId, run);
          }
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
          const line: StChatLine = {
            send_date: new Date().toISOString(),
            name,
            is_user: false,
            is_system: false,
            mes: text,
            extra: {
              messageId: randomUUID(),
              ...(thinking ? { thinking } : {}),
              ...(summary ? { summary } : {}),
              ...(toolCalls.length ? { protocol: "game_tool" } : {}),
            },
          };
          generated.push(line);
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
