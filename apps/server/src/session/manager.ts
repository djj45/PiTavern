import { executeScript, type ScriptResult } from "../script/interpreter.ts";
import { readGroup, groupSpeakers } from "../stdata/groups.ts";
import { withImportedScenario } from "../stdata/card-import.ts";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Agent } from "@earendil-works/pi-agent-core";
import type { AuthorNoteDto, AuthorNoteSnapshotDto, BranchIndexDto, BranchMetaPatchDto, BranchPathStepDto, ChatDisplayDto, ChatSnapshotDto, GenerationRecordDto, ReasoningLevel, ServerEvent } from "@pitavern/shared";
import { WORLD_STATE_KEY, WORLD_TEMPLATES_KEY } from "@pitavern/shared/world";
import { WorldState, WorldTransaction } from "../world/index.ts";
import { worldDigest } from "../world/digest.ts";
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
import { assembleBridgeIsolated } from "../context/bridge-isolated.ts";
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
import { branchPoints, replyChoices, stateFields, validEnforcement } from "../stdata/replies.ts";
import { greetingCatalog } from "../stdata/greetings.ts";
import { ActivityStore, emptyUsage } from "../stdata/activity.ts";
import { createTokenCounter } from "../context/tokens.ts";
import { globalRegex } from "../stdata/library.ts";

type ContextHooks = Pick<TavernAgentOptions, "tokenCounter" | "instruct" | "onContext">;

/** 单个聊天的运行时：Agent 引用 + 事件转发 + 召回限次冷却计数 */
class ChatSession {
  agent: Agent | null = null;
  character = "";
  running = false;
  staged: StChatLine[] = [];
  streamingText = "";
  aborted = false;
  controller: AbortController | null = null;
  generation: GenerationRecordDto | null = null;
  activityError?: string;
  /** 自动候选分支生成中（用于阻止用户在新回合和分支生成之间插队） */
  autoBranching = false;
  autoStop = false;
  enforcement: RecallEnforcement = { turn: 0, usedThisTurn: 0, cooldownUntilTurn: 0 };
  /** M2: 当前生成轮的世界事务；M3 的工具会在此暂存命令。 */
  worldTransaction: WorldTransaction | null = null;
}

export class SessionManager {
  private readonly sessions = new Map<string, ChatSession>();
  private readonly listeners = new Set<(event: ServerEvent) => void>();
  private readonly activity: ActivityStore;
  private maintenanceMessage: string | null = null;
  private restartRequired = false;

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

  get writeBlocked(): string | null { return this.maintenanceMessage; }

  assertIdle(): void {
    if (this.maintenanceMessage) throw new Error(this.maintenanceMessage);
    if ([...this.sessions.values()].some((session) => session.running)) throw new Error("请先停止所有聊天的生成，再操作资料库");
  }

  beginMaintenance(message: string): () => void {
    this.assertIdle();
    this.maintenanceMessage = message;
    this.emit({ type: "maintenance", message, restartRequired: false });
    return () => {
      if (!this.restartRequired) {
        this.maintenanceMessage = null;
        this.emit({ type: "maintenance", message: "", restartRequired: false });
      }
    };
  }

  requireRestart(): void {
    this.restartRequired = true;
    this.maintenanceMessage = "资料库已恢复，请重启服务后继续";
    this.emit({ type: "maintenance", message: this.maintenanceMessage, restartRequired: true });
  }

  libraryChanged(): void {
    this.characters.invalidate();
    this.invalidateAll();
    this.emit({ type: "library.changed" });
  }

  abort(chatId: string): boolean {
    const session = this.sessions.get(chatId);
    if (!session) return false;
    if (session.autoBranching) session.autoStop = true;
    if (!session.running) return session.autoStop;
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
    const branches = branchPoints(document.lines);
    const greetings = greetingCatalog(document.lines, this.characters.getCharacter(document.character), !!readGroup(document.metadata));
    let activity: ChatSnapshotDto["activity"];
    let activityError = session?.activityError;
    try { activity = this.activitySnapshot(chatId); }
    catch (cause) { activityError = "生成记录读取失败：" + (cause instanceof Error ? cause.message : String(cause)); }
    return {
      id: chatId, character: document.character, messages: full ? chatMessages(document.lines) : messages,
      ...(!full ? { page } : {}),
      ...(choices ? { replyChoices: choices } : {}),
      ...(branches.length ? { branchChoices: branches } : {}),
      ...(greetings ? { greetingChoices: greetings.choices } : {}),
      running: session?.running ?? false, streamingText: session?.streamingText ?? "",
      ...(session?.running && session.generation?.startedAt ? { generationStartedAt: session.generation.startedAt } : {}),
      activity, activityError,
      memberDisplays: Object.fromEntries((readGroup(document.metadata)?.members ?? []).map((name) => [name, this.displayConfig(name, document.metadata, document.lines)])),
      group: readGroup(document.metadata), streamingCharacter: session?.character,
      stagedMessages: chatMessages(session?.staged ?? []),
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
    let globals: ReturnType<typeof normalizeRegexScripts> = [];
    try { globals = globalRegex(this.stDataDir); } catch { /* 报错留给生成流程，已有消息仍可查看。 */ }
    return {
      scripts: [...globals, ...presetScripts, ...normalizeRegexScripts(character?.extensions.regex_scripts)].filter((script) => !script.disabled),
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
    if (this.writeBlocked) throw new Error(this.writeBlocked);
    if (this.isStreaming(chatId)) throw new Error("请先停止生成，再编辑作者注释");
    this.chats.saveAuthorNote(chatId, note, revision);
    this.changed(chatId);
  }

  editMessage(chatId: string, messageId: string, text: string, expectedText: string): void {
    if (this.writeBlocked) throw new Error(this.writeBlocked);
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

  /** 侧栏菜单：置顶/归档/重命名；写入聊天元数据并刷新侧栏摘要。 */
  updateChatMeta(chatId: string, patch: { pinned?: boolean; archived?: boolean; displayName?: string | null }): void {
    if (this.writeBlocked) throw new Error(this.writeBlocked);
    if (this.isStreaming(chatId)) throw new Error("请先停止生成，再修改对话信息");
    this.chats.updateChatMeta(chatId, patch);
    this.changed(chatId);
  }

  selectGreeting(chatId: string, selected: number, revision: string): void {
    if (this.writeBlocked) throw new Error(this.writeBlocked);
    if (this.isStreaming(chatId)) throw new Error("请先停止生成，再切换开场白");
    const document = this.chats.readDocument(chatId);
    if (!document) throw new Error("聊天不存在");
    this.chats.selectGreeting(chatId, selected, revision, this.characters.getCharacter(document.character));
    this.changed(chatId);
  }

  selectReply(chatId: string, userMessageId: string, selected: number, revision: string): void {
    if (this.writeBlocked) throw new Error(this.writeBlocked);
    if (this.isStreaming(chatId)) throw new Error("请先停止生成，再切换候选回复");
    if (this.sessions.get(chatId)?.autoBranching) throw new Error("正在自动生成候选分支，请稍候或点击停止");
    this.chats.selectReply(chatId, userMessageId, selected, revision);
    this.changed(chatId);
  }

  branchIndex(chatId: string): BranchIndexDto {
    const before = this.chats.revisionId(chatId);
    const index = this.chats.branchIndex(chatId);
    if (this.chats.revisionId(chatId) !== before) this.changed(chatId);
    return index;
  }

  branchPreview(chatId: string, nodeId: string, offset: number, limit: number) {
    const before = this.chats.revisionId(chatId);
    const preview = this.chats.branchPreview(chatId, nodeId, offset, limit);
    if (this.chats.revisionId(chatId) !== before) this.changed(chatId);
    return preview;
  }

  searchBranches(chatId: string, query: string, cursor?: number, limit?: number) {
    const before = this.chats.revisionId(chatId);
    const result = this.chats.searchBranches(chatId, query, cursor, limit);
    if (this.chats.revisionId(chatId) !== before) this.changed(chatId);
    return result;
  }

  switchBranchPath(chatId: string, steps: BranchPathStepDto[], revision: string): BranchIndexDto {
    if (this.writeBlocked) throw new Error(this.writeBlocked);
    if (this.isStreaming(chatId)) throw new Error("请先停止生成，再切换路线");
    if (this.sessions.get(chatId)?.autoBranching) throw new Error("正在自动生成候选分支，请稍候或点击停止");
    const index = this.chats.selectReplyPath(chatId, steps, revision);
    this.changed(chatId);
    return index;
  }

  updateBranchMeta(chatId: string, nodeId: string, patch: BranchMetaPatchDto, revision: string): BranchIndexDto {
    if (this.writeBlocked) throw new Error(this.writeBlocked);
    if (this.isStreaming(chatId)) throw new Error("请先停止生成，再修改路线");
    const index = this.chats.updateBranchMeta(chatId, nodeId, patch, revision);
    this.changed(chatId);
    return index;
  }

  updateBranchMetas(chatId: string, nodeIds: string[], patch: BranchMetaPatchDto, revision: string): BranchIndexDto {
    if (this.writeBlocked) throw new Error(this.writeBlocked);
    if (this.isStreaming(chatId)) throw new Error("请先停止生成，再批量修改路线");
    const index = this.chats.updateBranchMetas(chatId, nodeIds, patch, revision);
    this.changed(chatId);
    return index;
  }

  restoreBackup(chatId: string, backupId: string, revision: string): void {
    if (this.writeBlocked) throw new Error(this.writeBlocked);
    if (this.isStreaming(chatId)) throw new Error("请先停止生成，再恢复备份");
    this.chats.restoreBackup(chatId, backupId, revision);
    this.changed(chatId);
  }

  async runScript(chatId: string, source: string, revision: string): Promise<ScriptResult> {
    if (this.writeBlocked) throw new Error(this.writeBlocked);
    if (this.isStreaming(chatId)) throw new Error("请先停止生成或脚本");
    const session = this.ensureSession(chatId, "");
    const document = this.chats.readDocument(chatId);
    if (!document) throw new Error("聊天不存在");
    const transaction = this.chats.prepareScript(chatId, revision);
    const variables = transaction.metadata.variables && typeof transaction.metadata.variables === "object" && !Array.isArray(transaction.metadata.variables)
      ? transaction.metadata.variables as Record<string, unknown> : {};
    transaction.metadata.variables = variables;
    const group = readGroup(transaction.metadata), config = structuredClone(this.config);
    session.running = true; session.aborted = false; session.streamingText = ""; session.staged = [];
    session.controller = new AbortController();
    const controller = session.controller;
    let scriptCommitted = false;
    const timer = setTimeout(() => { session.aborted = true; controller.abort(new Error("脚本执行超过 60 秒")); session.agent?.abort(); }, 60_000);
    try {
      this.changed(chatId);
      const result = await executeScript(source, {
        char: document.character, user: config.persona.name, personaDescription: config.persona.description,
        members: group?.members, variables, lines: transaction.lines, signal: controller.signal,
        generate: async (prompt, raw, name) => {
          controller.signal.throwIfAborted();
          const base = this.characters.getCharacter(name); if (!base) throw new Error("角色不存在: " + name);
          const actor = withImportedScenario(base, transaction.metadata), models = this.models(), model = resolveModel(models, config);
          const generation = session.generation ?? {
            id: this.activity.createId(chatId), version: 0, userMessageId: "script-" + randomUUID(), kind: "script" as const,
            provider: model.provider, model: model.id, startedAt: new Date().toISOString(), status: "running" as const, usage: emptyUsage(), tools: [],
          };
          session.generation = generation; this.saveActivity(chatId, generation);
          const provider = config.providers.find((item) => item.id === model.provider);
          const hooks: ContextHooks = { tokenCounter: createTokenCounter(model.id, provider?.models.find((m) => m.id === model.id)?.tokenizer), instruct: provider?.instruct, onContext: (context) => { generation.context = context; this.saveActivity(chatId, generation); } };
          const env: MacroEnv = { char: name, user: config.persona.name, personaDescription: config.persona.description, variables,
            lastUserMessage: transaction.lines.findLast((line) => line.is_user)?.mes };
          const lines = transaction.lines.map((line) => group && !line.is_system ? { ...line, mes: "[" + line.name + "]: " + line.mes } : line);
          if (prompt !== undefined) lines.push({ name: config.persona.name, mes: prompt, is_user: true, is_system: false, send_date: new Date().toISOString() });
          if (prompt === undefined) lines.push({ name: config.persona.name, mes: "请 " + name + " 接着发言。", is_user: true, is_system: false, send_date: new Date().toISOString() });
          const character = group ? { ...actor, description: actor.description + "\n本次只扮演 " + name + "，其他群聊成员：" + group.members.join("、") } : actor;
          const toolCtx: ToolContext = { chatId, lines, worldEntries: this.collectWorldEntries(character, config), variables,
            skillsDir: path.join(this.stDataDir, "skills"), substitute: (s) => substituteMacros(s, env),
            enforcement: structuredClone(session.enforcement), maxRecallsPerTurn: 0, recallCooldownTurns: 0 };
          const agent = !raw && config.contextMode === "bridge"
            ? await this.buildBridgeAgent(chatId, character, model, models, toolCtx, [], false, config, hooks, undefined, undefined, transaction.metadata, controller.signal)
            : !raw && config.contextMode === "takeover"
              ? this.buildTakeoverAgent(model, models, toolCtx, [], false, config, transaction.metadata, character, hooks)
              : createTavernAgent({ models, model, chatId, templateNames: { char: name, user: config.persona.name },
                  systemPrompt: raw ? "" : substituteMacros(buildSystemPrompt(character, config.persona), env),
                  history: raw ? [] : historyToAgentMessages(lines.map((line) => ({ ...line, mes: substituteMacros(line.mes, env) }))),
                  thinkingLevel: this.thinkingLevelFor(config, model.provider, model.id), outputProtocol: "native", protocolStrict: false, ...hooks });
          session.agent = agent; session.character = name;
          agent.subscribe((event) => {
            if (event.type !== "message_end" || event.message.role !== "assistant") return;
            const usage = event.message.usage, amount = (n: number) => Number.isFinite(n) && n >= 0 ? n : 0;
            for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) generation.usage[key] += amount(usage[key]);
            generation.usage.costTotal += amount(usage.cost.total); generation.usage.responses++;
            if (usage.totalTokens > 0 || usage.input > 0 || usage.output > 0) generation.usage.responsesWithUsage++;
            this.saveActivity(chatId, generation);
          });
          if (raw) await agent.prompt(substituteMacros(prompt ?? "", env)); else await agent.continue();
          controller.signal.throwIfAborted();
          if (agent.state.errorMessage) throw new Error(agent.state.errorMessage);
          const answer = agent.state.messages.findLast((message) => message.role === "assistant");
          const output = answer?.role === "assistant" ? answer.content.filter((part) => part.type === "text").map((part) => part.type === "text" ? part.text : "").join("") : "";
          if (!output.trim()) throw new Error("脚本模型未返回正文");
          return output;
        },
      });
      controller.signal.throwIfAborted();
      transaction.commit(); scriptCommitted = true; return result;
    } catch (cause) {
      const error = controller.signal.aborted ? new Error("脚本已停止，所有更改已撤回") : cause;
      if (session.generation) session.generation.error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      if (session.generation) {
        const run = session.generation;
        run.status = scriptCommitted ? "succeeded" : controller.signal.aborted ? "aborted" : "failed"; run.finishedAt = new Date().toISOString();
        try { this.saveActivity(chatId, run); } catch (cause) { session.activityError = "脚本生成记录保存失败: " + (cause as Error).message; }
        session.generation = null;
      }
      clearTimeout(timer); session.running = false; session.agent = null; session.controller = null;
      this.changed(chatId); this.emit({ type: "chat.finished", chatId });
    }
  }

  send(chatId: string, text: string, speakers?: string[]): Promise<void> {
    return this.generate(chatId, text, undefined, speakers);
  }

  regenerate(chatId: string, messageId: string, expectedText: string, instruction?: string): Promise<void> {
    return this.generate(chatId, "", { messageId, expectedText }, undefined, instruction);
  }

  /** Both normal sends and regeneration stage state and replies until the entire turn succeeds. */
  private async generate(chatId: string, text: string, replacement?: { messageId: string; expectedText: string }, requestedSpeakers?: string[], instruction?: string): Promise<void> {
    if (this.writeBlocked) {
      this.emit({ type: "chat.error", chatId, message: this.writeBlocked });
      return;
    }
    if (this.isStreaming(chatId)) {
      this.emit({ type: "chat.error", chatId, message: "生成中，请先停止或等待完成" });
      return;
    }
    if (this.sessions.get(chatId)?.autoBranching && !replacement) {
      this.emit({ type: "chat.error", chatId, message: "正在自动生成候选分支，请稍候或点击停止" });
      return;
    }
    const session = this.ensureSession(chatId, "");
    session.running = true;
    session.aborted = false;
    session.streamingText = "";
    session.staged = [];
    session.controller = new AbortController();
    session.generation = null;
    const previousEnforcement = structuredClone(session.enforcement);
    let committed = false;
    let autoCount = 0;
    try {
      const config = structuredClone(this.config);
      if (!replacement) autoCount = config.branches.autoGenerate;
      const stored = this.chats.readDocument(chatId);
      if (!stored) throw new Error(`聊天不存在: ${chatId}`);
      const regeneration = replacement ? this.chats.prepareRegeneration(chatId, replacement.messageId, replacement.expectedText) : undefined;
      const document = regeneration ? { ...stored, lines: regeneration.history, metadata: regeneration.metadata } : stored;
      const generated: StChatLine[] = [];
      const pendingMetadata = structuredClone(document.metadata);
      const writeMetadata = (patch: Record<string, unknown>) => { Object.assign(pendingMetadata, patch); };
      const speakers = groupSpeakers(document.metadata, document.character,
        regeneration ? regeneration.user.extra?._pitavernSpeakers as string[] | undefined : requestedSpeakers);
      const actors = speakers.map((name) => {
        const card = this.characters.getCharacter(name);
        if (!card) throw new Error("找不到群聊角色卡: " + name);
        return withImportedScenario(card, document.metadata);
      });
      const group = readGroup(document.metadata);
      const models = this.models();
      const model = resolveModel(models, config);
      const textCompletion = model.api === "openai-text-completions";
      if (textCompletion && config.contextMode === "takeover") throw new Error("文本补全接口不能使用依赖工具召回的 Agent 接管模式，请选择简洁或 ST 桥接模式");
      if (textCompletion && config.outputProtocol === "game_tool") throw new Error("文本补全接口不支持 game_tool，请将输出协议设为原生文本流式");
      const worldSnapshot = document.metadata[WORLD_STATE_KEY];
      const worldToolsAvailable = config.toolsEnabled && !textCompletion;
      const worldReadOnly = !worldToolsAvailable;
      const worldState = worldSnapshot
        ? new WorldState(worldSnapshot, document.metadata[WORLD_TEMPLATES_KEY], worldReadOnly
          ? { mode: "read-only", reason: textCompletion ? "文本补全模型没有普通工具，世界仅可查看" : "工具已关闭，世界仅可查看" }
          : { mode: "enabled" })
        : null;
      const worldTransaction = worldState
        ? new WorldTransaction(worldState, document.lines.filter((line) => line.is_user && !line.is_system).length + 1)
        : null;
      const worldGuidance = worldState
        ? (worldState.capability.mode === "enabled" ? "enabled" as const : "read-only" as const)
        : undefined;
      session.worldTransaction = worldTransaction;
      const variables = structuredClone(document.metadata.variables && typeof document.metadata.variables === "object" && !Array.isArray(document.metadata.variables)
        ? document.metadata.variables as Record<string, unknown> : {});
      const beforeTurn = {
        metadata: stateFields(document.metadata),
        enforcement: structuredClone(session.enforcement),
      };
      const userLine = regeneration?.user ?? this.chats.appendMessage(chatId, {
        name: config.persona.name, is_user: true, is_system: false, mes: text,
        extra: { _pitavernBeforeTurn: beforeTurn, ...(group ? { _pitavernSpeakers: speakers } : {}) },
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
      if (regeneration) this.emit({ type: "chat.regenerating", chatId, startedAt: generation.startedAt });
      else this.emit({ type: "chat.started", chatId, message: chatMessages([userLine])[0], startedAt: generation.startedAt });
      const sharedTimedState = config.contextMode === "bridge" ? normalizeTimedState(document.metadata.timedWorldInfo) : undefined;
      for (const originalActor of actors) {
        session.controller.signal.throwIfAborted();
        const character = group ? { ...originalActor, description: originalActor.description +
          "\n群聊成员：" + group.members.join("、") + "。历史消息以发言者名字标记。你本次只扮演 " + originalActor.name + "，不要替其他成员或用户发言。" } : originalActor;
        session.character = character.name;
        session.streamingText = "";
        session.staged = generated;
        this.emit({ type: "chat.speaker", chatId, character: character.name, stagedMessages: chatMessages(generated) });
        const history = [...document.lines, userLine, ...generated].map((line) => group && !line.is_system
          ? { ...line, mes: "[" + line.name + "]: " + line.mes } : line);
        const generatedBefore = generated.length;
        const macroEnv: MacroEnv = {
          char: character.name, user: config.persona.name,
          personaDescription: config.persona.description,
          variables,
          lastUserMessage: text,
        };
        // 群聊每个发言者重新读取事务工作副本：前一位角色的 staged 命令应进入下一位的 Digest。
        const worldDigestText = worldState && worldTransaction
          ? worldDigest(worldTransaction.snapshot, worldState.template, worldState.capability, { toolsAvailable: worldToolsAvailable })
          : "";
        const toolCtx: ToolContext = {
          chatId,
          lines: history,
          worldEntries: this.collectWorldEntries(character, config),
          variables,
          skillsDir: path.join(this.stDataDir, "skills"),
          substitute: (s) => substituteMacros(s, { ...macroEnv, variables: structuredClone(variables) }),
          enforcement: session.enforcement,
          maxRecallsPerTurn: 6,
          recallCooldownTurns: 10,
          world: worldState && worldTransaction ? { state: worldState, transaction: worldTransaction } : undefined,
          worldDigest: worldDigestText,
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
        const timedState = sharedTimedState;
        const previewEnv = { ...macroEnv, variables: structuredClone(variables) };
        const vectorMatches = config.contextMode === "bridge" ? await retrieveVectorEntries(
          config, toolCtx.worldEntries,
          toolCtx.lines.filter((line) => !line.is_system).map((line) => substituteMacros(line.mes, previewEnv)),
          this.stDataDir, session.controller.signal,
        ) : undefined;
        session.controller.signal.throwIfAborted();
        const agent = config.contextMode === "bridge"
          ? await this.buildBridgeAgent(chatId, character, model, models, toolCtx, allTools, useProtocol, config, contextHooks, timedState, vectorMatches, pendingMetadata, session.controller.signal, instruction)
          : config.contextMode === "takeover"
            ? this.buildTakeoverAgent(model, models, toolCtx, allTools, useProtocol, config, { ...pendingMetadata, variables }, character, contextHooks, instruction)
            : createTavernAgent({
                models, model, chatId, thinkingLevel: this.thinkingLevelFor(config, model.provider, model.id),
                templateNames: { char: character.name, user: config.persona.name },
                systemPrompt: substituteMacros(buildSystemPrompt(character, config.persona), macroEnv) + this.toolGuidance(tools.length > 0, worldGuidance) +
                  (worldDigestText ? `\n\n${worldDigestText}` : "") +
                  (useProtocol ? `\n\n${OUTPUT_PROTOCOL_INSTRUCTION}` : "") + this.instructionBlock(instruction),
                history: historyToAgentMessages((group ? history : document.lines).map((line) => ({ ...line, mes: substituteMacros(line.mes, macroEnv) }))), tools: allTools,
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
        if (group) await agent.prompt("请 " + character.name + " 接着发言。");
        else if (config.contextMode === "simple") {
          const prompt = substituteMacros(text, macroEnv);
          writeMetadata({ variables });
          await agent.prompt(prompt);
        }
        else await agent.continue();
        if (agent.state.errorMessage && !session.aborted) throw new Error(agent.state.errorMessage);
        if (!session.aborted && !generated.slice(generatedBefore).some((line) => line.mes.trim())) throw new Error(character.name + " 未返回正文，本轮全部回复已撤回");
        if (session.aborted) break;
      }
      if (!session.aborted) {
        if (!generated.some((line) => line.mes.trim())) throw new Error(regeneration ? "模型未返回正文，已保留原回复" : "模型未返回正文，状态未改变，可重试本轮");
        pendingMetadata._pitavernEnforcement = structuredClone(session.enforcement);
        if (worldTransaction) pendingMetadata[WORLD_STATE_KEY] = worldTransaction.commit();
        transaction.commit(generated, pendingMetadata);
        committed = true;
        if (!regeneration) for (const line of generated) this.emit({ type: "chat.done", chatId, message: chatMessages([line])[0] });
      }
    } catch (error) {
      if (session.generation && !session.aborted) session.generation.error = error instanceof Error ? error.message : String(error);
      if (!session.aborted) this.emit({ type: "chat.error", chatId, message: error instanceof Error ? error.message : String(error) });
    } finally {
      session.staged = [];
      session.streamingText = "";
      session.running = false;
      session.agent = null;
      session.controller = null;
      if (session.worldTransaction?.status === "open") session.worldTransaction.discard();
      session.worldTransaction = null;
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
      // 自动多分支：首条回复成功后，后台再生成若干候选；每次都是独立、可停止的生成。
      if (autoCount > 0 && committed && !session.aborted && !this.writeBlocked) void this.autoAlternatives(chatId, autoCount);
    }
  }

  /** 成功回复后自动追加候选分支；用户点击停止会中止整个循环。 */
  private async autoAlternatives(chatId: string, total: number): Promise<void> {
    const session = this.sessions.get(chatId);
    if (!session || session.running) return;
    session.autoBranching = true;
    session.autoStop = false;
    try {
      for (let done = 0; done < total; done++) {
        if (this.writeBlocked || session.autoStop || this.sessions.get(chatId) !== session) break;
        const snapshot = this.snapshot(chatId);
        const last = snapshot?.messages.at(-1);
        if (!snapshot || !last || last.role !== "assistant") break;
        const before = snapshot.replyChoices?.count ?? 0;
        await this.generate(chatId, "", { messageId: last.id, expectedText: last.text });
        if (session.autoStop || session.aborted) break;
        const after = this.snapshot(chatId)?.replyChoices?.count ?? 0;
        if (after <= before) break;
      }
    } catch (error) {
      this.emit({ type: "chat.error", chatId, message: "自动候选分支失败: " + (error instanceof Error ? error.message : String(error)) });
    } finally {
      session.autoBranching = false;
      session.autoStop = false;
      const snapshot = this.snapshot(chatId);
      if (snapshot) this.emit({ type: "chat.snapshot", chatId, snapshot });
    }
  }

  /** 仅本次生成生效的“换条路线”要求。 */
  private instructionBlock(instruction?: string): string {
    if (!instruction) return "";
    return `\n\n### 本次生成的方向要求（仅本次生效，不要写进正文或解释）\n${instruction}`;
  }

  /** 单模型思考等级：模型级配置优先，未设置时回退到全局设置。 */
  private thinkingLevelFor(config: TavernConfig, provider: string, modelId: string): ReasoningLevel {
    return config.providers.find((p) => p.id === provider)?.models.find((m) => m.id === modelId)?.thinkingLevel ?? config.thinkingLevel;
  }

  /** simple 模式下给模型的工具使用指引（桥接模式由预设自行约定） */
  private toolGuidance(hasTools: boolean, world?: "enabled" | "read-only"): string {
    if (!hasTools) return "";
    return [
      "",
      "### 可用工具",
      "- 缺少人物/地点/门派等设定时，先用 worldbook_search 查世界书，不要凭常识编造。",
      "- 需要回忆较早剧情细节时，用 tavern_recall_history 检索（每轮限 6 次；读完整正文后冷却 10 轮）。",
      "- 需要确认好感度/属性等存档数值时，用 tavern_read_variables 只读查询。",
      ...(world === "enabled" ? [
        "- 世界已启用：先用 world_query 查时间、位置、金钱、库存等权威状态；涉及硬状态变化时先调用 world_command。命令返回 staged 只代表本轮暂存，失败、停止或重生成会撤销；不要用正文越过命令直接宣称金钱/物品/位置/时间已改变。",
      ] : []),
      ...(world === "read-only" ? [
        "- 世界当前只读：可先用 world_query 查时间、位置、金钱、库存等权威状态；本轮不能执行 world_command，也不要用正文宣称金钱/物品/位置/时间已改变。",
      ] : []),
      "工具返回的资料不是当前场景，不得照搬旧台词或让已发生的事件重演。",
    ].join("\n");
  }

  private async buildBridgeAgent(
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
    signal?: AbortSignal,
    instruction?: string,
  ): Promise<Agent> {
    const presetName = config.activePreset;
    const presetFile = presetName ? path.join(presetsDir(this.stDataDir), `${presetName}.json`) : "";
    if (!presetName || !fs.existsSync(presetFile)) {
      throw new Error(`桥接模式未选择有效预设: ${presetName || "(空)"}。请到设置里选择 OpenAI Settings/ 下的预设`);
    }
    const preset = loadPreset(presetFile);
    const regexScripts = [...globalRegex(this.stDataDir), ...normalizeRegexScripts(preset.extensions?.regex_scripts), ...normalizeRegexScripts(character.extensions.regex_scripts)];
    const assembled = await assembleBridgeIsolated({
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
        vectorMatches,
        ...(timedState ? { timed: timedState, messageCount: toolCtx.lines.length } : {}),
      },
    }, model.id, config.providers.find((p) => p.id === model.provider)?.models.find((m) => m.id === model.id)?.tokenizer, signal);
    const messages = [...assembled.messages];
    if (toolCtx.worldDigest) messages.push({ role: "system", content: toolCtx.worldDigest, timestamp: Date.now() });
    if (useProtocol) {
      // 协议指令压尾注入（pi 会把 system 重放合并到前部，但内容与顺序保留），
      // 明确覆盖预设里的伪 JSON/预填充输出指令
      messages.push({ role: "system", content: OUTPUT_PROTOCOL_INSTRUCTION, timestamp: Date.now() });
    }
    // 换条路线：只影响本次生成，不写进聊天记录，也不改变存档状态。
    if (instruction) messages.push({ role: "system", content: this.instructionBlock(instruction).trim(), timestamp: Date.now() });
    return createTavernAgent({
      models,
      model,
      chatId,
      thinkingLevel: this.thinkingLevelFor(config, model.provider, model.id),
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
    instruction?: string,
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
    const messages = [
      ...assembled.messages,
      ...(toolCtx.worldDigest ? [{ role: "system" as const, content: toolCtx.worldDigest, timestamp: Date.now() }] : []),
      ...(instruction ? [{ role: "system" as const, content: this.instructionBlock(instruction).trim(), timestamp: Date.now() }] : []),
    ];
    return createTavernAgent({
      models,
      model,
      chatId: toolCtx.chatId,
      thinkingLevel: this.thinkingLevelFor(config, model.provider, model.id),
      messages,
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
