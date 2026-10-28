import fs from "node:fs";
import path from "node:path";
import express, { type Request, type Response } from "express";
import type {
  CharacterDto,
  ChatSummaryDto,
  ConnectionDto,
  PresetSummaryDto,
  ProviderDto,
  WorldSummaryDto,
} from "@pitavern/shared";
import { PITAVERN_VERSION } from "@pitavern/shared";
import type { TavernConfig } from "../config.ts";
import { saveConfig, seedDataDirs } from "../config.ts";
import { listPresets, presetsDir } from "../context/preset.ts";
import { normalizeWorldFile } from "../context/worldinfo.ts";
import { validateAuthorNote } from "../context/author-note.ts";
import { normalizeInstruct } from "../context/instruct.ts";
import { embedTexts } from "../context/vectors.ts";
import { parseCardFromPng } from "../stdata/png.ts";
import { providerDtoList, buildModels, resolveModel } from "../providers/models.ts";
import type { Models } from "@earendil-works/pi-ai";
import type { CharacterStore } from "../stdata/characters.ts";
import type { ChatStore } from "../stdata/chats.ts";
import type { SessionManager } from "../session/manager.ts";

export interface HttpDeps {
  config: TavernConfig;
  modelsRef: { current: Models };
  characters: CharacterStore;
  chats: ChatStore;
  sessions: SessionManager;
  webDistDir: string | null;
  stDataDir: string;
}

function boundedNumber(value: unknown, label: string, min: number, max: number, integer = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new Error(`${label} 必须是 ${min}～${max} 的${integer ? "整数" : "数值"}`);
  }
  return value;
}

function characterDto(card: import("../stdata/types.ts").CharacterCard): CharacterDto {
  return {
    name: card.name,
    avatarUrl: card.avatarFile ? `/api/characters/${encodeURIComponent(card.name)}/avatar` : "",
    description: card.description,
    personality: card.personality,
    scenario: card.scenario,
    firstMes: card.firstMes,
    alternateGreetings: card.alternateGreetings,
    tags: card.tags,
    creator: card.creator,
  };
}

export function createHttpApp(deps: HttpDeps): express.Express {
  const { config, modelsRef, characters, chats, sessions } = deps;
  const app = express();
  app.use(express.json({ limit: "4mb" }));

  app.get("/api/status", (_req, res) => {
    res.json({ version: PITAVERN_VERSION, stDataDir: config.stDataDir });
  });

  app.get("/api/connection", (_req, res) => {
    const dto: ConnectionDto = {
      providers: providerDtoList(config),
      defaultProvider: config.defaultProvider,
      defaultModel: config.defaultModel,
      stDataDir: config.stDataDir,
      persona: config.persona,
      contextMode: config.contextMode,
      activePreset: config.activePreset,
      activeWorlds: config.activeWorlds,
      worldInfo: config.worldInfo,
      vectors: config.vectors,
      outputProtocol: config.outputProtocol,
      protocolStrict: config.protocolStrict,
      compression: config.compression,
      takeover: config.takeover,
    };
    res.json(dto);
  });

  app.get("/api/presets", (_req, res) => {
    const list: PresetSummaryDto[] = listPresets(deps.stDataDir);
    res.json(list);
  });

  app.get("/api/worlds", (_req, res) => {
    const worldsRoot = path.join(deps.stDataDir, "worlds");
    const list: WorldSummaryDto[] = [];
    if (fs.existsSync(worldsRoot)) {
      for (const file of fs.readdirSync(worldsRoot).filter((f) => f.endsWith(".json")).sort()) {
        try {
          const entries = normalizeWorldFile(JSON.parse(fs.readFileSync(path.join(worldsRoot, file), "utf8")), file);
          list.push({ name: file.replace(/\.json$/, ""), entryCount: entries.length });
        } catch {
          // 跳过损坏文件
        }
      }
    }
    res.json(list);
  });

  /** 保存连接设置。apiKey 为空字符串或缺省时保持原密钥。 */
  app.put("/api/connection", (req, res) => {
    try {
      const next = structuredClone(config);
      type ProviderInput = ProviderDto & { apiKey?: string };
      const body = req.body as Partial<Omit<ConnectionDto, "providers">> & { providers?: ProviderInput[] };
      // providers 缺省表示只改默认模型/persona 等，不覆盖已存连接（apiKey 空串或缺省=不变）
      if (Array.isArray(body.providers)) next.providers = body.providers.map((p) => {
        const old = next.providers.find((o) => o.id === p.id);
        if (p.apiType !== undefined && p.apiType !== "chat" && p.apiType !== "text") throw new Error("不支持的模型接口类型");
        const apiKey = p.apiKey === "" || p.apiKey === undefined ? old?.apiKey : p.apiKey;
        return {
          id: p.id,
          name: p.name,
          baseUrl: p.baseUrl.replace(/\/+$/, ""),
          apiKey,
          apiType: p.apiType === undefined ? old?.apiType ?? "chat" : p.apiType,
          instruct: p.instruct === undefined ? old?.instruct : normalizeInstruct(p.instruct),
          models: p.models.map((m) => ({
            id: m.id,
            name: m.name || m.id,
            reasoning: m.reasoning ?? false,
            contextWindow: boundedNumber(m.contextWindow ?? 1_000_000, "上下文长度", 1, 10_000_000, true),
            maxTokens: boundedNumber(m.maxTokens ?? 16_384, "最大输出", 1, 10_000_000, true),
            tokenizer: ["auto", "cl100k_base", "o200k_base", "estimate"].includes(m.tokenizer ?? "auto") ? m.tokenizer ?? "auto"
              : (() => { throw new Error("不支持的 token 计数方式"); })(),
          })),
        };
      });
      if (typeof body.defaultProvider === "string") next.defaultProvider = body.defaultProvider;
      if (typeof body.defaultModel === "string") next.defaultModel = body.defaultModel;
      if (body.persona?.name) next.persona.name = body.persona.name;
      if (typeof body.persona?.description === "string") next.persona.description = body.persona.description;
      if (body.contextMode === "simple" || body.contextMode === "bridge" || body.contextMode === "takeover") {
        next.contextMode = body.contextMode;
      }
      if (typeof body.activePreset === "string") next.activePreset = body.activePreset.replace(/\.json$/, "");
      if (Array.isArray(body.activeWorlds)) {
        next.activeWorlds = body.activeWorlds.filter((w): w is string => typeof w === "string").map((w) => w.replace(/\.json$/, ""));
      }
      if (body.worldInfo && typeof body.worldInfo === "object") {
        const wi = body.worldInfo as Partial<ConnectionDto["worldInfo"]>;
        if (typeof wi.scanDepth === "number") next.worldInfo.scanDepth = boundedNumber(wi.scanDepth, "扫描深度", 0, 1000, true);
        if (typeof wi.recursionSteps === "number") next.worldInfo.recursionSteps = Math.max(0, Math.min(10, wi.recursionSteps));
        if (typeof wi.caseSensitive === "boolean") next.worldInfo.caseSensitive = wi.caseSensitive;
        if (typeof wi.matchWholeWords === "boolean") next.worldInfo.matchWholeWords = wi.matchWholeWords;
        if (typeof wi.useGroupScoring === "boolean") next.worldInfo.useGroupScoring = wi.useGroupScoring;
        for (const key of ["minActivations", "minActivationsDepthMax", "budgetTokens"] as const) {
          if (wi[key] !== undefined) next.worldInfo[key] = boundedNumber(wi[key], key, 0, key === "budgetTokens" ? 1000000 : 1000, true);
        }
      }
      if (body.outputProtocol === "native" || body.outputProtocol === "game_tool") next.outputProtocol = body.outputProtocol;
      if (typeof body.protocolStrict === "boolean") next.protocolStrict = body.protocolStrict;
      if (body.compression && typeof body.compression === "object") {
        const c = body.compression as Partial<ConnectionDto["compression"]>;
        if (typeof c.enabled === "boolean") next.compression.enabled = c.enabled;
        if (typeof c.keepFullTurns === "number") next.compression.keepFullTurns = Math.max(1, Math.min(100, c.keepFullTurns));
      }
      if (body.takeover && typeof body.takeover === "object") {
        const t = body.takeover as Partial<ConnectionDto["takeover"]>;
        if (typeof t.recentTurns === "number") next.takeover.recentTurns = Math.max(1, Math.min(50, t.recentTurns));
        if (typeof t.stateProjection === "boolean") next.takeover.stateProjection = t.stateProjection;
      }
      if (body.vectors && typeof body.vectors === "object") {
        const v = body.vectors;
        if (typeof v.enabled === "boolean") next.vectors.enabled = v.enabled;
        if (typeof v.providerId === "string") next.vectors.providerId = v.providerId;
        if (typeof v.model === "string") next.vectors.model = v.model.trim();
        for (const key of ["queryMessages", "maxEntries"] as const) {
          if (v[key] !== undefined) next.vectors[key] = boundedNumber(v[key], key, 1, 100, true);
        }
        if (v.scoreThreshold !== undefined) next.vectors.scoreThreshold = boundedNumber(v.scoreThreshold, "相似度阈值", -1, 1);
      }
      if (next.vectors.enabled && (!next.vectors.model || !next.providers.some((p) => p.id === next.vectors.providerId))) {
        throw new Error("启用向量检索前，请选择有效连接并填写 embedding 模型");
      }
      const activeProvider = next.providers.find((p) => p.id === next.defaultProvider);
      if (activeProvider?.apiType === "text" && (next.contextMode === "takeover" || next.outputProtocol === "game_tool")) {
        throw new Error("文本补全接口仅支持简洁/ST 桥接模式与原生文本输出；Agent 接管和 game_tool 需要聊天补全接口");
      }
      const updatedModels = buildModels(next);
      if (typeof body.stDataDir === "string" && body.stDataDir.trim() && body.stDataDir.trim() !== next.stDataDir) {
        next.stDataDir = body.stDataDir.trim();
        seedDataDirs(next.stDataDir);
        saveConfig(next);
        Object.assign(config, next);
        modelsRef.current = updatedModels;
        sessions.invalidateAll();
        // CharacterStore/ChatStore 持有旧目录的绝对路径，需要重启才生效
        res.json({ ok: true, restartRequired: true });
        return;
      }
      saveConfig(next);
      Object.assign(config, next);
      modelsRef.current = updatedModels;
      sessions.invalidateAll();
      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  /** 探活：用当前默认模型发 1 token 请求 */
  app.post("/api/connection/test", async (_req, res) => {
    try {
      const model = resolveModel(modelsRef.current, config);
      const stream = modelsRef.current.streamSimple(model, {
        systemPrompt: "You are a connectivity check. Reply with exactly: ok",
        messages: [{ role: "user", content: "ping", timestamp: Date.now() }],
      }, { maxTokens: 1, timeoutMs: 15_000 });
      let sawText = false;
      for await (const event of stream) {
        if (event.type === "text_delta") sawText = true;
        if (event.type === "error") throw new Error(event.error.errorMessage ?? "模型返回错误");
        if (event.type === "done") break;
      }
      res.json({ ok: sawText, provider: model.provider, model: model.id });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/vectors/test", async (_req, res) => {
    try {
      const [vector] = await embedTexts(structuredClone(config), ["连通性测试"]);
      res.json({ ok: true, dimensions: vector.length });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/characters", (_req, res) => {
    res.json(characters.listCharacters().map(characterDto));
  });

  /** 导入角色卡：PNG（tEXt 内嵌卡）或导出 JSON；同名文件覆盖 */
  app.post("/api/import/character", express.raw({ type: "*/*", limit: "24mb" }), (req, res) => {
    let fileName: string;
    try {
      fileName = path.basename(decodeURIComponent(String(req.headers["x-file-name"] ?? "card.png")));
    } catch {
      res.status(400).json({ error: "文件名编码无效" });
      return;
    }
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      res.status(400).json({ error: "空文件" });
      return;
    }
    const isPng = body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const lower = fileName.toLowerCase();
    let safeName: string;
    if (isPng && lower.endsWith(".png")) {
      if (!parseCardFromPng(body)) {
        res.status(400).json({ error: "PNG 里没有找到角色卡数据（chara/ccv3）" });
        return;
      }
      safeName = fileName.replace(/[\\/:*?"<>|]/g, "_");
    } else if (lower.endsWith(".json")) {
      try {
        const json = JSON.parse(body.toString("utf8"));
        const data = json?.data && typeof json.data === "object" ? json.data : json;
        if (typeof data?.name !== "string" || !data.name.trim()) {
          res.status(400).json({ error: "JSON 缺少 name 字段（不是有效的角色卡）" });
          return;
        }
      } catch {
        res.status(400).json({ error: "JSON 解析失败" });
        return;
      }
      safeName = fileName.replace(/[\\/:*?"<>|]/g, "_");
    } else {
      res.status(400).json({ error: "仅支持 .png（内嵌卡）或 .json 角色卡" });
      return;
    }
    const target = path.join(deps.stDataDir, "characters", safeName);
    fs.writeFileSync(target, body);
    res.json({ ok: true, file: safeName });
  });

  /** 导入世界书：ST worlds JSON（entries 对象） */
  app.post("/api/import/world", (req, res) => {
    const { name, data } = req.body as { name?: unknown; data?: unknown };
    const safeName = typeof name === "string" && name.trim() ? path.basename(name.trim().replace(/\.json$/, "")).replace(/[\\/:*?"<>|]/g, "_") : "";
    if (!safeName) {
      res.status(400).json({ error: "缺少世界书名称" });
      return;
    }
    const entries = normalizeWorldFile(data, safeName);
    if (entries.length === 0) {
      res.status(400).json({ error: "没有有效条目（需要 entries 对象）" });
      return;
    }
    fs.mkdirSync(path.join(deps.stDataDir, "worlds"), { recursive: true });
    fs.writeFileSync(path.join(deps.stDataDir, "worlds", `${safeName}.json`), JSON.stringify(data, null, 2));
    res.json({ ok: true, name: safeName, entryCount: entries.length });
  });

  app.get("/api/characters/:name/avatar", (req: Request, res: Response) => {
    const card = characters.getCharacter(String(req.params.name));
    if (!card?.avatarFile) {
      res.status(404).json({ error: "无头像" });
      return;
    }
    res.sendFile(card.avatarFile);
  });

  app.get("/api/chat/author-note", (req, res) => {
    try { res.json(sessions.authorNote(String(req.query.chatId ?? ""))); }
    catch (error) { res.status(404).json({ error: (error as Error).message }); }
  });

  app.put("/api/chat/author-note", (req, res) => {
    const { chatId, note, revision } = req.body ?? {};
    if (typeof chatId !== "string" || typeof revision !== "string") return res.status(400).json({ error: "作者注释参数无效" });
    let validated;
    try { validated = validateAuthorNote(note); }
    catch (error) { return res.status(400).json({ error: (error as Error).message }); }
    try {
      sessions.saveAuthorNote(chatId, validated, revision);
      res.json(sessions.authorNote(chatId));
    } catch (error) { res.status(409).json({ error: (error as Error).message }); }
  });

  app.patch("/api/chat/message", (req, res) => {
    const { chatId, messageId, text, expectedText } = req.body ?? {};
    if ([chatId, messageId, text, expectedText].some((value) => typeof value !== "string") || !text.trim() || text.length > 1_000_000) {
      res.status(400).json({ error: "消息参数无效" });
      return;
    }
    try {
      sessions.editMessage(chatId, messageId, text, expectedText);
      res.json({ ok: true });
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/chat/activity", (req, res) => {
    try {
      const chatId = String(req.query.chatId ?? "");
      if (!chats.readDocument(chatId)) return res.status(404).json({ error: "聊天不存在" });
      res.json(sessions.activityPage(chatId, typeof req.query.before === "string" ? req.query.before : undefined));
    } catch (error) { res.status(400).json({ error: (error as Error).message }); }
  });

  app.get("/api/chat/history", (req, res) => {
    const { chatId, revision, before } = req.query;
    if (typeof chatId !== "string" || typeof revision !== "string" || typeof before !== "string" || !/^\d+$/.test(before)) {
      res.status(400).json({ error: "历史分页参数无效" }); return;
    }
    try { res.json(chats.page(chatId, Number(before), revision)); }
    catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : String(error) }); }
  });

  app.post("/api/chat/reply", (req, res) => {
    const { chatId, userMessageId, selected, revision } = req.body ?? {};
    if ([chatId, userMessageId, revision].some((v) => typeof v !== "string") || !Number.isInteger(selected)) {
      res.status(400).json({ error: "候选回复参数无效" }); return;
    }
    try { sessions.selectReply(chatId, userMessageId, selected, revision); res.json({ ok: true }); }
    catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : String(error) }); }
  });

  app.get("/api/chat/backups", (req, res) => {
    if (typeof req.query.chatId !== "string") { res.status(400).json({ error: "聊天参数无效" }); return; }
    try { res.json(chats.backups(req.query.chatId, typeof req.query.before === "string" ? req.query.before : undefined)); }
    catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : String(error) }); }
  });

  app.get("/api/chat/backup", (req, res) => {
    const { chatId, backupId } = req.query;
    if (typeof chatId !== "string" || typeof backupId !== "string") { res.status(400).json({ error: "备份参数无效" }); return; }
    try { res.json(chats.previewBackup(chatId, backupId)); }
    catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : String(error) }); }
  });

  app.post("/api/chat/backup/restore", (req, res) => {
    const { chatId, backupId, revision } = req.body ?? {};
    if ([chatId, backupId, revision].some((v) => typeof v !== "string")) { res.status(400).json({ error: "备份参数无效" }); return; }
    try { sessions.restoreBackup(chatId, backupId, revision); res.json({ ok: true }); }
    catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : String(error) }); }
  });

  app.get("/api/chats", (req, res) => {
    const character = typeof req.query.character === "string" ? req.query.character : undefined;
    const list: ChatSummaryDto[] = chats.listChats(character).map((m) => ({
      id: m.id,
      character: m.character,
      title: m.id.split("/").pop() ?? m.id,
      messageCount: m.messageCount,
      lastMessage: m.lastMessage,
      updatedAt: m.updatedAt,
    }));
    res.json(list);
  });

  app.post("/api/chats", (req, res) => {
    const { character, greeting } = req.body as { character?: string; greeting?: string };
    const card = character ? characters.getCharacter(character) : undefined;
    if (!card) {
      res.status(404).json({ error: `角色不存在: ${character}` });
      return;
    }
    const firstMes = greeting ?? (card.firstMes || card.alternateGreetings[0] || "");
    const meta = chats.createChat(
      card.name,
      firstMes ? { name: card.name, is_user: false, is_system: false, mes: firstMes } : null,
      config.persona.name,
    );
    res.json({ id: meta.id });
  });

  /** 聊天导出：?format=md（Markdown，思维链折叠）| jsonl（ST 原始格式）。需在通配路由前注册 */
  app.get("/api/chats/*splat/export", (req, res) => {
    const chatId = (Array.isArray(req.params.splat) ? req.params.splat : [req.params.splat]).join("/");
    const snapshot = sessions.snapshot(chatId, true);
    if (!snapshot) {
      res.status(404).json({ error: `聊天不存在: ${chatId}` });
      return;
    }
    const file = chats.resolveChatFile(chatId);
    const baseName = (chatId.split("/").pop() ?? "chat").replace(/\.jsonl$/, "");
    const format = req.query.format === "jsonl" ? "jsonl" : "md";
    if (format === "jsonl" && file) {
      res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(`${baseName}.jsonl`)}`);
      res.send(fs.readFileSync(file, "utf8"));
      return;
    }
    const lines: string[] = [`# ${snapshot.character} — ${baseName}`, "", `> PiTavern 导出 · ${new Date().toLocaleString("zh-CN")} · ${snapshot.messages.length} 条消息`, ""];
    for (const message of snapshot.messages) {
      lines.push(`## ${message.name}${message.role === "user" ? "（用户）" : ""}`, "");
      if (message.thinking) {
        lines.push("<details><summary>💭 思考过程</summary>", "", message.thinking, "", "</details>", "");
      }
      lines.push(message.text, "");
    }
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(`${baseName}.md`)}`);
    res.send(lines.join("\n"));
  });

  app.get("/api/chats/*splat", (req, res) => {
    // Express 5 通配参数跨斜杠时是数组
    const chatId = (Array.isArray(req.params.splat) ? req.params.splat : [req.params.splat]).join("/");
    const snapshot = sessions.snapshot(chatId);
    if (!snapshot) {
      res.status(404).json({ error: `聊天不存在: ${chatId}` });
      return;
    }
    res.json(snapshot);
  });

  app.delete("/api/chats/*splat", (req, res) => {
    const chatId = (Array.isArray(req.params.splat) ? req.params.splat : [req.params.splat]).join("/");
    if (sessions.isStreaming(chatId)) {
      res.status(409).json({ error: "请先停止生成，再删除聊天" });
      return;
    }
    res.json({ ok: chats.deleteChat(chatId) });
  });

  if (deps.webDistDir) {
    app.use(express.static(deps.webDistDir));
    app.get(/^\/(?!api\/).*/, (_req, res) => {
      res.sendFile(`${deps.webDistDir}/index.html`);
    });
  }

  return app;
}
