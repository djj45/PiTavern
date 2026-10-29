import { readGroup } from "../stdata/groups.ts";
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
import { defaultConfig, saveConfig, seedDataDirs } from "../config.ts";
import { listPresets, presetsDir } from "../context/preset.ts";
import { normalizeWorldFile } from "../context/worldinfo.ts";
import { validateAuthorNote } from "../context/author-note.ts";
import { normalizeInstruct } from "../context/instruct.ts";
import { embedTexts } from "../context/vectors.ts";
import { parseCardFromPng } from "../stdata/png.ts";
import { importCardArchive } from "../stdata/card-import.ts";
import { providerDtoList, buildModels, resolveModel } from "../providers/models.ts";
import { discoverModels, ModelDiscoveryError } from "../providers/discovery.ts";
import type { Models } from "@earendil-works/pi-ai";
import type { CharacterStore } from "../stdata/characters.ts";
import type { ChatStore } from "../stdata/chats.ts";
import type { SessionManager } from "../session/manager.ts";
import { LibraryStore } from "../stdata/library.ts";
import { LibraryBackupStore } from "../stdata/library-backup.ts";
import { attachLibraryBackupJobs, backupControlPath } from "./library-backup-jobs.ts";
import { atomicWrite } from "../stdata/files.ts";

export interface HttpDeps {
  config: TavernConfig;
  modelsRef: { current: Models };
  characters: CharacterStore;
  chats: ChatStore;
  sessions: SessionManager;
  webDistDir: string | null;
  stDataDir: string;
}

const REASONING_LEVELS = ["off", "minimal", "low", "medium", "high"] as const;

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
  const library = new LibraryStore(deps.stDataDir);
  const libraryBackups = new LibraryBackupStore(deps.stDataDir);
  app.use("/api", (req, res, next) => {
    if (sessions.writeBlocked && req.path !== "/status" && !backupControlPath(req.path)) return res.status(503).json({ error: sessions.writeBlocked });
    next();
  });
  // Stream uploads before the JSON parser so a whole library never occupies one request buffer.
  app.post("/api/library-backup/preview", async (req, res) => {
    let release: (() => void) | undefined;
    try {
      release = sessions.beginMaintenance("正在校验资料库备份，请稍候");
      res.json(await libraryBackups.preview(req));
    } catch (error) { if (!res.headersSent) res.status(400).json({ error: (error as Error).message }); }
    finally { release?.(); }
  });
  app.use(express.json({ limit: "4mb" }));
  app.use("/api", (req, res, next) => {
    // A maintenance operation may have started while a request body was arriving.
    if (sessions.writeBlocked && req.path !== "/status" && !backupControlPath(req.path)) return res.status(503).json({ error: sessions.writeBlocked });
    next();
  });

  attachLibraryBackupJobs(app, libraryBackups, config, sessions);

  app.get("/api/library", (_req, res) => res.json(library.list()));
  app.get("/api/library/document", (req, res) => {
    try { res.json(library.read(String(req.query.id ?? ""))); }
    catch (error) { res.status(400).json({ error: (error as Error).message }); }
  });
  app.put("/api/library/document", (req, res) => {
    try {
      sessions.assertIdle();
      const { id, revision, data } = req.body ?? {};
      if (typeof id !== "string" || typeof revision !== "string") throw new Error("缺少资料或版本");
      const document = library.save(id, revision, data);
      sessions.libraryChanged();
      res.json(document);
    } catch (error) { res.status(409).json({ error: (error as Error).message }); }
  });
  app.get("/api/library/history", (req, res) => {
    try { res.json(library.history(String(req.query.id ?? ""), typeof req.query.before === "string" ? req.query.before : undefined)); }
    catch (error) { res.status(400).json({ error: (error as Error).message }); }
  });
  app.get("/api/library/history/preview", (req, res) => {
    try { res.json(library.previewHistory(String(req.query.id ?? ""), String(req.query.backupId ?? ""))); }
    catch (error) { res.status(400).json({ error: (error as Error).message }); }
  });
  app.post("/api/library/history/restore", (req, res) => {
    try {
      sessions.assertIdle();
      const { id, backupId, revision } = req.body ?? {};
      if ([id, backupId, revision].some((v) => typeof v !== "string")) throw new Error("历史恢复参数无效");
      const document = library.restoreHistory(id, backupId, revision);
      sessions.libraryChanged(); res.json(document);
    } catch (error) { res.status(409).json({ error: (error as Error).message }); }
  });
  app.post("/api/library/world", (req, res) => {
    try {
      sessions.assertIdle();
      if (typeof req.body?.name !== "string") throw new Error("缺少世界书名称");
      const document = library.createWorld(req.body.name);
      sessions.libraryChanged();
      res.json(document);
    } catch (error) { res.status(400).json({ error: (error as Error).message }); }
  });
  app.get("/api/library-backup/export", async (_req, res) => {
    let release: (() => void) | undefined;
    try {
      release = sessions.beginMaintenance("正在导出资料库备份，请稍候");
      const archive = await libraryBackups.export();
      release(); release = undefined;
      res.download(archive, path.basename(archive), { dotfiles: "allow" }, (error) => {
        if (error && !res.headersSent) res.status(500).json({ error: "备份下载失败，请重新导出" });
      });
    } catch (error) { if (!res.headersSent) res.status(409).json({ error: (error as Error).message }); }
    finally { release?.(); }
  });
  app.post("/api/library-backup/restore", async (req, res) => {
    let release: (() => void) | undefined;
    try {
      if (typeof req.body?.id !== "string") throw new Error("缺少归档预览编号");
      release = sessions.beginMaintenance("正在恢复资料库，请稍候");
      const result = await libraryBackups.restore(req.body.id, config);
      sessions.requireRestart();
      res.json(result);
    } catch (error) { res.status(400).json({ error: (error as Error).message }); }
    finally { release?.(); }
  });
  app.delete("/api/library-backup/preview", (req, res) => {
    libraryBackups.discard(String(req.query.id ?? ""));
    res.json({ ok: true });
  });

  app.get("/api/status", (_req, res) => {
    res.json({ version: PITAVERN_VERSION, stDataDir: config.stDataDir, maintenance: sessions.writeBlocked });
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
      thinkingLevel: config.thinkingLevel,
      outputProtocol: config.outputProtocol,
      protocolStrict: config.protocolStrict,
      compression: config.compression,
      takeover: config.takeover,
      branches: config.branches,
      appearance: config.appearance,
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
          models: p.models.map((m) => {
            if (m.thinkingLevel !== undefined && !REASONING_LEVELS.includes(m.thinkingLevel)) throw new Error("不支持的思考等级");
            return {
              id: m.id,
              name: m.name || m.id,
              reasoning: m.thinkingLevel !== undefined ? m.thinkingLevel !== "off" : (m.reasoning ?? false),
              ...(m.thinkingLevel !== undefined ? { thinkingLevel: m.thinkingLevel } : {}),
              contextWindow: boundedNumber(m.contextWindow ?? 1_000_000, "上下文长度", 1, 10_000_000, true),
              maxTokens: boundedNumber(m.maxTokens ?? 16_384, "最大输出", 1, 10_000_000, true),
              tokenizer: ["auto", "cl100k_base", "o200k_base", "estimate"].includes(m.tokenizer ?? "auto") ? m.tokenizer ?? "auto"
                : (() => { throw new Error("不支持的 token 计数方式"); })(),
            };
          }),
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
      if (typeof body.thinkingLevel === "string") {
        if (!REASONING_LEVELS.includes(body.thinkingLevel as typeof REASONING_LEVELS[number])) throw new Error("不支持的思考强度");
        next.thinkingLevel = body.thinkingLevel as ConnectionDto["thinkingLevel"];
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
      if (body.branches && typeof body.branches === "object") {
        const b = body.branches as Partial<ConnectionDto["branches"]>;
        if (typeof b.autoGenerate === "number") next.branches.autoGenerate = boundedNumber(b.autoGenerate, "自动候选分支数", 0, 4, true);
      }
      if (body.appearance && typeof body.appearance === "object") {
        const a = body.appearance as Partial<ConnectionDto["appearance"]>;
        for (const key of ["speechColor", "dialogueColor"] as const) {
          const value = a[key];
          if (value === undefined) continue;
          if (typeof value !== "string" || (value !== "" && !/^#[0-9a-f]{6}$/i.test(value))) throw new Error("文字颜色必须是 #RRGGBB 或留空");
          next.appearance[key] = value;
        }
        if (a.dialoguePairs !== undefined) {
          if (!Array.isArray(a.dialoguePairs) || a.dialoguePairs.length > 20) throw new Error("对白符号最多 20 组");
          next.appearance.dialoguePairs = a.dialoguePairs.map((pair) => {
            if (!pair || typeof pair.open !== "string" || typeof pair.close !== "string") throw new Error("对白符号参数无效");
            const open = pair.open.trim(), close = pair.close.trim();
            if (!open || !close || open.length > 8 || close.length > 8 || open === close) throw new Error("对白起始/结束符号需为 1–8 个字符且不能相同");
            const color = typeof pair.color === "string" ? pair.color.trim() : "";
            if (color && !/^#[0-9a-f]{6}$/i.test(color)) throw new Error("对白符号颜色必须是 #RRGGBB 或留空");
            return { open, close, ...(color ? { color } : {}) };
          });
        }
        delete (next.appearance as unknown as Record<string, unknown>).thinkingColor;
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

  app.post("/api/connection/models", async (req, res) => {
    const abort = new AbortController();
    const cancel = () => { if (!res.writableEnded) abort.abort(); };
    res.on("close", cancel);
    try {
      const models = await discoverModels(config.providers, req.body, { signal: abort.signal });
      if (!res.destroyed) res.json({ models });
    } catch (error) {
      if (!res.destroyed) res.status(error instanceof ModelDiscoveryError ? error.status : 500)
        .json({ error: error instanceof ModelDiscoveryError ? error.message : "获取模型列表失败" });
    } finally { res.off("close", cancel); }
  });

  /** 探活：用默认模型或指定模型发 1 token 请求 */
  app.post("/api/connection/test", async (req, res) => {
    try {
      const providerId = typeof req.body?.providerId === "string" ? req.body.providerId : "";
      const modelId = typeof req.body?.modelId === "string" ? req.body.modelId : "";
      let model;
      if (providerId && modelId) {
        model = modelsRef.current.getModel(providerId, modelId);
        if (!model) throw new Error(`模型 ${providerId}/${modelId} 不存在`);
      } else {
        model = resolveModel(modelsRef.current, config);
      }
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

  /** 恢复非模型默认配置；连接、密钥、默认模型和数据目录保持不变。 */
  app.post("/api/connection/reset", (_req, res) => {
    try {
      const defaults = defaultConfig();
      const next: TavernConfig = {
        ...defaults,
        port: config.port,
        stDataDir: config.stDataDir,
        providers: structuredClone(config.providers),
        defaultProvider: config.defaultProvider,
        defaultModel: config.defaultModel,
      };
      saveConfig(next);
      Object.assign(config, next);
      modelsRef.current = buildModels(next);
      sessions.invalidateAll();
      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  /** 输入框底部的思考等级：只更新指定模型的默认等级，避免整份 providers 回写。 */
  app.patch("/api/connection/model", (req, res) => {
    try {
      const { providerId, modelId, thinkingLevel } = req.body ?? {};
      if (typeof providerId !== "string" || typeof modelId !== "string" || !REASONING_LEVELS.includes(thinkingLevel)) {
        res.status(400).json({ error: "模型思考等级参数无效" });
        return;
      }
      const next = structuredClone(config);
      const model = next.providers.find((p) => p.id === providerId)?.models.find((m) => m.id === modelId);
      if (!model) {
        res.status(404).json({ error: "模型不存在" });
        return;
      }
      model.thinkingLevel = thinkingLevel;
      model.reasoning = thinkingLevel !== "off";
      saveConfig(next);
      Object.assign(config, next);
      modelsRef.current = buildModels(next);
      sessions.invalidateAll();
      res.json({ ok: true, thinkingLevel });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
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

  /** Import PNG/JSON or bounded CharX/BYAF archives; archives never overwrite existing cards. */
  app.post("/api/import/character", express.raw({ type: "*/*", limit: "24mb" }), async (req, res) => {
    let release: (() => void) | undefined;
    try {
      sessions.assertIdle();
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
      if (/\.(charx|byaf)$/i.test(lower)) {
        release = sessions.beginMaintenance("正在导入角色归档，请稍候");
        const result = await importCardArchive(deps.stDataDir, fileName, body, new Set(characters.listCharacters().map((card) => card.name)), config.persona.name);
        sessions.libraryChanged(); res.json({ ok: true, ...result }); return;
      }
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
        res.status(400).json({ error: "仅支持 .png、.json、.charx 或 .byaf 角色卡" });
        return;
      }
      const target = path.join(deps.stDataDir, "characters", safeName);
      atomicWrite(target, body);
      sessions.libraryChanged();
      res.json({ ok: true, file: safeName });
    } catch (error) { res.status(400).json({ error: (error as Error).message }); }
    finally { release?.(); }
  });

  /** 导入世界书：ST worlds JSON（entries 对象） */
  app.post("/api/import/world", (req, res) => {
    try {
      sessions.assertIdle();
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
      library.importWorld(safeName, data);
      sessions.libraryChanged();
      res.json({ ok: true, name: safeName, entryCount: entries.length });
    } catch (error) { res.status(400).json({ error: (error as Error).message }); }
  });

  app.get("/api/characters/:name/avatar", (req: Request, res: Response) => {
    const card = characters.getCharacter(String(req.params.name));
    if (!card?.avatarFile) {
      res.status(404).json({ error: "无头像" });
      return;
    }
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.sendFile(card.avatarFile, { dotfiles: "allow" });
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

  app.patch("/api/chat/meta", (req, res) => {
    const { chatId, pinned, archived, displayName } = req.body ?? {};
    if (typeof chatId !== "string" ||
        (pinned !== undefined && typeof pinned !== "boolean") ||
        (archived !== undefined && typeof archived !== "boolean") ||
        (displayName !== undefined && displayName !== null && (typeof displayName !== "string" || displayName.trim().length > 100)) ||
        (pinned === undefined && archived === undefined && displayName === undefined)) {
      res.status(400).json({ error: "对话信息参数无效" });
      return;
    }
    try {
      sessions.updateChatMeta(chatId, {
        ...(pinned !== undefined ? { pinned } : {}),
        ...(archived !== undefined ? { archived } : {}),
        ...(displayName !== undefined ? { displayName: typeof displayName === "string" ? displayName.trim() : null } : {}),
      });
      res.json({ ok: true });
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
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

  app.post("/api/chat/greeting", (req, res) => {
    const { chatId, selected, revision } = req.body ?? {};
    if (typeof chatId !== "string" || typeof revision !== "string" || !Number.isInteger(selected)) {
      res.status(400).json({ error: "开场白参数无效" }); return;
    }
    try { sessions.selectGreeting(chatId, selected, revision); res.json({ ok: true }); }
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
      group: m.group,
      title: m.displayName ?? m.id.split("/").pop() ?? m.id,
      messageCount: m.messageCount,
      lastMessage: m.lastMessage,
      updatedAt: m.updatedAt,
      ...(m.displayName ? { displayName: m.displayName } : {}),
      ...(m.pinned ? { pinned: true } : {}),
      ...(m.archived ? { archived: true } : {}),
    }));
    res.json(list);
  });

  app.post("/api/chat/script", async (req, res) => {
    try {
      const { chatId, source, revision } = req.body ?? {};
      if (typeof chatId !== "string" || typeof source !== "string" || typeof revision !== "string") throw new Error("脚本参数无效");
      res.json(await sessions.runScript(chatId, source, revision));
    } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
  });

  app.post("/api/groups", (req, res) => {
    try {
      sessions.assertIdle();
      const group = readGroup({ _pitavernGroup: req.body });
      if (!group) throw new Error("缺少群聊配置");
      for (const name of group.members) if (!characters.getCharacter(name)) throw new Error("角色不存在: " + name);
      const meta = chats.createChat(group.members[0], null, config.persona.name, { _pitavernGroup: group });
      res.json({ id: meta.id });
    } catch (error) { res.status(400).json({ error: (error as Error).message }); }
  });

  app.post("/api/chats", (req, res) => {
    if (sessions.writeBlocked) { res.status(503).json({ error: sessions.writeBlocked }); return; }
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
