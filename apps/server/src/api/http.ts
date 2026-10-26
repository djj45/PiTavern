import fs from "node:fs";
import path from "node:path";
import express, { type Request, type Response } from "express";
import type {
  CharacterDto,
  ChatMessageDto,
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

function chatLinesToDto(lines: import("../stdata/types.ts").StChatLine[], config: TavernConfig): ChatMessageDto[] {
  return lines
    .filter((l) => !l.is_system && l.mes.trim())
    .map((l, i) => ({
      id: `line-${i}`,
      role: (l.is_user ? "user" : "assistant") as ChatMessageDto["role"],
      name: l.is_user ? config.persona.name : l.name,
      text: l.mes,
      sendDate: l.send_date,
    }));
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

  /** 保存连接设置。apiKey 为空字符串表示不变，undefined 表示清除。 */
  app.put("/api/connection", (req, res) => {
    type ProviderInput = ProviderDto & { apiKey?: string };
    const body = req.body as Partial<Omit<ConnectionDto, "providers">> & { providers?: ProviderInput[] };
    // providers 缺省表示只改默认模型/persona 等，不覆盖已存连接（apiKey 空串=不变，undefined=清除）
    if (Array.isArray(body.providers)) config.providers = body.providers.map((p) => {
      const old = config.providers.find((o) => o.id === p.id);
      const apiKey = p.apiKey === "" || p.apiKey === undefined ? old?.apiKey : p.apiKey;
      return {
        id: p.id,
        name: p.name,
        baseUrl: p.baseUrl.replace(/\/+$/, ""),
        apiKey,
        models: p.models.map((m) => ({
          id: m.id,
          name: m.name || m.id,
          reasoning: m.reasoning ?? false,
          contextWindow: m.contextWindow,
          maxTokens: m.maxTokens,
        })),
      };
    });
    if (typeof body.defaultProvider === "string") config.defaultProvider = body.defaultProvider;
    if (typeof body.defaultModel === "string") config.defaultModel = body.defaultModel;
    if (body.persona?.name) config.persona.name = body.persona.name;
    if (typeof body.persona?.description === "string") config.persona.description = body.persona.description;
    if (body.contextMode === "simple" || body.contextMode === "bridge") config.contextMode = body.contextMode;
    if (typeof body.activePreset === "string") config.activePreset = body.activePreset.replace(/\.json$/, "");
    if (Array.isArray(body.activeWorlds)) {
      config.activeWorlds = body.activeWorlds.filter((w): w is string => typeof w === "string").map((w) => w.replace(/\.json$/, ""));
    }
    if (body.worldInfo && typeof body.worldInfo === "object") {
      const wi = body.worldInfo as Partial<ConnectionDto["worldInfo"]>;
      if (typeof wi.scanDepth === "number") config.worldInfo.scanDepth = Math.max(1, Math.min(100, wi.scanDepth));
      if (typeof wi.recursionSteps === "number") config.worldInfo.recursionSteps = Math.max(0, Math.min(10, wi.recursionSteps));
      if (typeof wi.caseSensitive === "boolean") config.worldInfo.caseSensitive = wi.caseSensitive;
      if (typeof wi.matchWholeWords === "boolean") config.worldInfo.matchWholeWords = wi.matchWholeWords;
    }
    if (typeof body.stDataDir === "string" && body.stDataDir.trim() && body.stDataDir.trim() !== config.stDataDir) {
      config.stDataDir = body.stDataDir.trim();
      seedDataDirs(config.stDataDir);
      saveConfig(config);
      // CharacterStore/ChatStore 持有旧目录的绝对路径，需要重启才生效
      res.json({ ok: true, restartRequired: true });
      return;
    }
    saveConfig(config);
    modelsRef.current = buildModels(config);
    sessions.invalidateAll();
    res.json({ ok: true });
  });

  /** 探活：用当前默认模型发 1 token 请求 */
  app.post("/api/connection/test", async (_req, res) => {
    try {
      const model = resolveModel(modelsRef.current, config);
      const stream = modelsRef.current.streamSimple(model, {
        systemPrompt: "You are a connectivity check. Reply with exactly: ok",
        messages: [{ role: "user", content: "ping", timestamp: Date.now() }],
      });
      let sawText = false;
      for await (const event of stream) {
        if (event.type === "text_delta") sawText = true;
        if (event.type === "done" || event.type === "error") break;
      }
      res.json({ ok: sawText, provider: model.provider, model: model.id });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/characters", (_req, res) => {
    res.json(characters.listCharacters().map(characterDto));
  });

  app.get("/api/characters/:name/avatar", (req: Request, res: Response) => {
    const card = characters.getCharacter(String(req.params.name));
    if (!card?.avatarFile) {
      res.status(404).json({ error: "无头像" });
      return;
    }
    res.sendFile(card.avatarFile);
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
    const firstMes = greeting ?? card.firstMes ?? card.alternateGreetings[0] ?? "";
    const meta = chats.createChat(
      card.name,
      firstMes ? { name: card.name, is_user: false, is_system: false, mes: firstMes } : null,
    );
    res.json({ id: meta.id });
  });

  app.get("/api/chats/*splat", (req, res) => {
    // Express 5 通配参数跨斜杠时是数组
    const chatId = (Array.isArray(req.params.splat) ? req.params.splat : [req.params.splat]).join("/");
    const lines = chats.readChat(chatId);
    if (!lines) {
      res.status(404).json({ error: `聊天不存在: ${chatId}` });
      return;
    }
    res.json({ id: chatId, character: lines[0]?.name ?? "", messages: chatLinesToDto(lines, config) });
  });

  app.delete("/api/chats/*splat", (req, res) => {
    const chatId = (Array.isArray(req.params.splat) ? req.params.splat : [req.params.splat]).join("/");
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
