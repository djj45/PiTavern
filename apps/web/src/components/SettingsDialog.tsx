import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_DIALOGUE_PAIRS, type ConnectionDto, type DialoguePairDto, type PresetSummaryDto, type ProviderDto, type ReasoningLevel, type WorldSummaryDto } from "@pitavern/shared";
import { INSTRUCT_TEMPLATES } from "@pitavern/shared";
import { api } from "../api.ts";
import { ModelDiscovery } from "./ModelDiscovery.tsx";

interface SettingsDialogProps {
  connection: ConnectionDto | null;
  onClose: () => void;
  onSaved: (restartRequired?: boolean, silent?: boolean) => void;
  onError: (message: string) => void;
  onNotice?: (message: string) => void;
}

interface EditableProvider extends ProviderDto {
  apiKeyInput: string;
  newModelId: string;
}

interface TestState {
  running: boolean;
  result: string | null;
}

/** 没有模型、没有密钥、地址仍是占位符的连接只是“添加”后的空白草稿，不默认占用界面。 */
function isBlankProvider(provider: ProviderDto & { apiKeyInput?: string }): boolean {
  const url = provider.baseUrl.trim().toLowerCase();
  return provider.models.length === 0 && !provider.hasApiKey && !provider.apiKeyInput?.trim() &&
    ["", "https:", "https://", "http:", "http://"].includes(url);
}

export function SettingsDialog({ connection, onClose, onSaved, onError, onNotice }: SettingsDialogProps) {
  const [providers, setProviders] = useState<EditableProvider[]>(() =>
    (connection?.providers ?? []).filter((provider) => !isBlankProvider(provider)).map((p) => ({
      ...p, apiKeyInput: "", newModelId: "",
      models: p.models.map((model) => ({
        ...model,
        // 旧配置只有 reasoning 布尔值；这里把等价的思考等级显式落到表格里。
        thinkingLevel: model.thinkingLevel ?? (model.reasoning ? (connection?.thinkingLevel && connection.thinkingLevel !== "off" ? connection.thinkingLevel : "high") : "off"),
      })),
    })),
  );
  const [defaultProvider, setDefaultProvider] = useState(connection?.defaultProvider ?? "");
  const [defaultModel, setDefaultModel] = useState(connection?.defaultModel ?? "");
  const [stDataDir, setStDataDir] = useState(connection?.stDataDir ?? "");
  const [personaName, setPersonaName] = useState(connection?.persona.name ?? "");
  const [personaDescription, setPersonaDescription] = useState(connection?.persona.description ?? "");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [dirty, setDirty] = useState(false);
  const [restartRequired, setRestartRequired] = useState(false);
  const [ending, setEnding] = useState(false);
  const saving = saveState === "saving";
  const [test, setTest] = useState<TestState>({ running: false, result: null });
  const [modelTests, setModelTests] = useState<Record<string, { state: "running" | "ok" | "error"; error?: string }>>({});
  const [presets, setPresets] = useState<PresetSummaryDto[]>([]);
  const [worlds, setWorlds] = useState<WorldSummaryDto[]>([]);
  const [contextMode, setContextMode] = useState<"simple" | "bridge" | "takeover">(connection?.contextMode ?? "simple");
  const [activePreset, setActivePreset] = useState(connection?.activePreset ?? "");
  const [activeWorlds, setActiveWorlds] = useState<string[]>(connection?.activeWorlds ?? []);
  const [scanDepth, setScanDepth] = useState(connection?.worldInfo?.scanDepth ?? 2);
  const [recursionSteps, setRecursionSteps] = useState(connection?.worldInfo?.recursionSteps ?? 0);
  const [outputProtocol, setOutputProtocol] = useState<"native" | "game_tool">(connection?.outputProtocol ?? "native");
  const [protocolStrict, setProtocolStrict] = useState(connection?.protocolStrict ?? true);
  const [compressionEnabled, setCompressionEnabled] = useState(connection?.compression?.enabled ?? true);
  const [keepFullTurns, setKeepFullTurns] = useState(connection?.compression?.keepFullTurns ?? 6);
  const [recentTurns, setRecentTurns] = useState(connection?.takeover?.recentTurns ?? 3);
  const [stateProjection, setStateProjection] = useState(connection?.takeover?.stateProjection ?? true);
  const [autoGenerate, setAutoGenerate] = useState(connection?.branches?.autoGenerate ?? 0);
  const [speechColor, setSpeechColor] = useState(connection?.appearance?.speechColor ?? "");
  const [dialogueColor, setDialogueColor] = useState(connection?.appearance?.dialogueColor ?? "");
  const [dialoguePairs, setDialoguePairs] = useState<DialoguePairDto[]>(() =>
    (connection?.appearance?.dialoguePairs ?? DEFAULT_DIALOGUE_PAIRS).map((pair) => ({ ...pair })));
  const [minActivations, setMinActivations] = useState(connection?.worldInfo?.minActivations ?? 0);
  const [minActivationsDepthMax, setMinActivationsDepthMax] = useState(connection?.worldInfo?.minActivationsDepthMax ?? 0);
  const [budgetTokens, setBudgetTokens] = useState(connection?.worldInfo?.budgetTokens ?? 0);
  const [useGroupScoring, setUseGroupScoring] = useState(connection?.worldInfo?.useGroupScoring ?? false);
  const [vectors, setVectors] = useState(connection?.vectors ?? { enabled: false, providerId: "", model: "", queryMessages: 2, maxEntries: 5, scoreThreshold: 0.3 });
  const [vectorTest, setVectorTest] = useState<TestState>({ running: false, result: null });
  const [visibleKeys, setVisibleKeys] = useState<Record<string, boolean>>({});
  const [manualFor, setManualFor] = useState<string | null>(null);
  const textCompletion = providers.find((p) => p.id === defaultProvider)?.apiType === "text";

  useEffect(() => {
    if (textCompletion) {
      setContextMode((mode) => mode === "takeover" ? "simple" : mode);
      setOutputProtocol("native");
    }
  }, [textCompletion]);

  useEffect(() => {
    api.presets().then(setPresets).catch(() => setPresets([]));
    api.worlds().then(setWorlds).catch(() => setWorlds([]));
  }, []);

  const worldFileRef = useRef<HTMLInputElement>(null);
  const importWorld = async (file: File) => {
    try {
      const data = JSON.parse(await file.text());
      const name = file.name.replace(/\.json$/i, "");
      const result = await api.importWorld(name, data);
      setWorlds(await api.worlds());
      setActiveWorlds((list) => (list.includes(result.name) ? list : [...list, result.name]));
      onNotice?.(`已导入世界书 ${result.name}（${result.entryCount} 条）`);
    } catch (e) {
      onNotice?.(`导入失败: ${(e as Error).message}`);
    }
  };

  const updateProvider = (id: string, patch: Partial<EditableProvider>) => {
    setProviders((list) => list.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  };

  const updateModel = (providerId: string, modelId: string, patch: Partial<ProviderDto["models"][number]>) => {
    setProviders((list) => list.map((p) => p.id !== providerId ? p : {
      ...p, models: p.models.map((model) => model.id === modelId ? { ...model, ...patch } : model),
    }));
  };

  const removeModel = (providerId: string, modelId: string) => {
    const provider = providers.find((p) => p.id === providerId);
    const next = provider?.models.find((model) => model.id !== modelId);
    setProviders((list) => list.map((p) => p.id !== providerId ? p : { ...p, models: p.models.filter((model) => model.id !== modelId) }));
    if (defaultProvider === providerId && defaultModel === modelId) {
      setDefaultProvider(next ? providerId : "");
      setDefaultModel(next?.id ?? "");
    }
  };

  const setModelThinkingLevel = (providerId: string, modelId: string, thinkingLevel: ReasoningLevel) => {
    updateModel(providerId, modelId, { thinkingLevel, reasoning: thinkingLevel !== "off" });
  };

  const addProvider = () => {
    const id = `relay-${Date.now().toString(36)}`;
    setProviders((list) => [
      ...list,
      { id, name: "新中转", baseUrl: "https://", hasApiKey: false, models: [], apiKeyInput: "", newModelId: "" },
    ]);
  };

  const addModel = (providerId: string, discovered?: { id: string; name: string }) => {
    const provider = providers.find((p) => p.id === providerId);
    const modelId = discovered?.id ?? provider?.newModelId.trim();
    if (!provider || !modelId) return;
    setProviders((list) => list.map((p) => p.id !== providerId ? p : {
      ...p,
      models: p.models.some((model) => model.id === modelId) ? p.models : [
        ...p.models, { id: modelId, name: discovered?.name ?? modelId, reasoning: false, thinkingLevel: "off" as ReasoningLevel, contextWindow: 1_000_000, maxTokens: 16_384 },
      ],
      newModelId: "",
    }));
    if (!defaultProvider || !defaultModel) {
      setDefaultProvider(providerId);
      setDefaultModel(modelId);
    }
  };

  const persist = async (silent = false) => {
    // 未配置任何内容的“添加”草稿不落库，也不占默认模型。
    const keptProviders = providers.filter((provider) => !isBlankProvider(provider));
    const selectedProvider = keptProviders.find((provider) => provider.id === defaultProvider) ?? keptProviders[0];
    const selectedModel = selectedProvider?.models.find((model) => model.id === defaultModel) ?? selectedProvider?.models[0];
    const payload = {
      providers: keptProviders.map((p) => ({
        id: p.id,
        name: p.name,
        baseUrl: p.baseUrl,
        hasApiKey: p.hasApiKey,
        apiType: p.apiType ?? "chat",
        ...(p.instruct ? { instruct: p.instruct } : {}),
        models: p.models,
        // 空串 = 服务端保持原 key 不变；填了新值 = 更新
        apiKey: p.apiKeyInput,
      })),
      defaultProvider: selectedProvider?.id ?? "",
      defaultModel: selectedModel?.id ?? "",
      stDataDir,
      persona: { name: personaName || "旅人", description: personaDescription },
      contextMode,
      activePreset,
      activeWorlds,
      worldInfo: {
        scanDepth,
        recursionSteps,
        minActivations,
        minActivationsDepthMax,
        budgetTokens,
        caseSensitive: connection?.worldInfo?.caseSensitive ?? false,
        matchWholeWords: connection?.worldInfo?.matchWholeWords ?? true,
        useGroupScoring,
      },
      vectors,
      outputProtocol,
      protocolStrict,
      compression: { enabled: compressionEnabled, keepFullTurns },
      takeover: { recentTurns, stateProjection },
      branches: { autoGenerate },
      appearance: {
        speechColor,
        dialogueColor,
        dialoguePairs: dialoguePairs.map((pair) => ({
          open: pair.open.trim(), close: pair.close.trim(), ...(pair.color ? { color: pair.color } : {}),
        })).filter((pair) => pair.open && pair.close),
      },
    };
    const result = await api.saveConnection(payload);
    onSaved(result.restartRequired, silent);
    return result;
  };

  const initialConnection = useRef<ConnectionDto | null>(connection);
  const initialized = useRef(false);
  const closing = useRef(false);
  const mounted = useRef(true);
  const dirtyRef = useRef(false);
  const changeSeq = useRef(0);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const persistRef = useRef(persist);
  persistRef.current = persist;
  const onSavedRef = useRef(onSaved); onSavedRef.current = onSaved;
  const onErrorRef = useRef(onError); onErrorRef.current = onError;
  const onNoticeRef = useRef(onNotice); onNoticeRef.current = onNotice;
  const onCloseRef = useRef(onClose); onCloseRef.current = onClose;

  useEffect(() => () => { mounted.current = false; clearTimeout(saveTimer.current); }, []);

  const enqueueSave = useCallback((silent: boolean) => {
    const sequence = changeSeq.current;
    const run = saveQueue.current.then(async () => {
      if (!mounted.current) return { restartRequired: false };
      setSaveState("saving");
      try {
        const result = await persistRef.current(silent);
        if (!mounted.current) return result;
        if (changeSeq.current === sequence) {
          dirtyRef.current = false;
          setDirty(false);
          setSaveState("saved");
        } else {
          setSaveState("idle");
        }
        if (result.restartRequired) setRestartRequired(true);
        return result;
      } catch (error) {
        if (mounted.current) setSaveState("error");
        if (silent) onErrorRef.current(`自动保存失败: ${(error as Error).message}`);
        throw error;
      }
    });
    saveQueue.current = run.then(() => undefined, () => undefined);
    return run;
  }, []);

  const autoSaveKey = JSON.stringify({
    providers, defaultProvider, defaultModel, stDataDir, personaName, personaDescription, contextMode, activePreset, activeWorlds,
    scanDepth, recursionSteps, outputProtocol, protocolStrict, compressionEnabled, keepFullTurns, recentTurns, stateProjection,
    autoGenerate, minActivations, minActivationsDepthMax, budgetTokens, useGroupScoring, vectors, speechColor, dialogueColor, dialoguePairs,
  });
  useEffect(() => {
    if (!initialized.current) { initialized.current = true; return; }
    if (closing.current) return;
    changeSeq.current += 1;
    dirtyRef.current = true;
    setDirty(true);
    setSaveState("idle");
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { void enqueueSave(true).catch(() => undefined); }, 700);
    return () => clearTimeout(saveTimer.current);
  }, [autoSaveKey, enqueueSave]);

  const flushAndClose = async () => {
    if (closing.current) return;
    closing.current = true;
    clearTimeout(saveTimer.current);
    try {
      while (dirtyRef.current) await enqueueSave(true);
      onCloseRef.current();
    } catch {
      closing.current = false;
    }
  };

  const snapshotPayload = (value: ConnectionDto) => ({
    providers: value.providers.map((p) => ({
      id: p.id, name: p.name, baseUrl: p.baseUrl, hasApiKey: p.hasApiKey, apiType: p.apiType,
      ...(p.instruct ? { instruct: p.instruct } : {}), models: p.models.map((model) => ({ ...model })),
    })),
    defaultProvider: value.defaultProvider,
    defaultModel: value.defaultModel,
    stDataDir: value.stDataDir,
    persona: value.persona,
    contextMode: value.contextMode,
    activePreset: value.activePreset,
    activeWorlds: value.activeWorlds,
    worldInfo: value.worldInfo,
    vectors: value.vectors,
    outputProtocol: value.outputProtocol,
    protocolStrict: value.protocolStrict,
    compression: value.compression,
    takeover: value.takeover,
    branches: value.branches,
    appearance: value.appearance,
  });

  const discardChanges = async () => {
    if (closing.current) return;
    closing.current = true;
    setEnding(true);
    clearTimeout(saveTimer.current);
    try {
      await saveQueue.current;
      const initial = initialConnection.current;
      const result = initial ? await api.saveConnection(snapshotPayload(initial)) : { restartRequired: false };
      onSavedRef.current(result.restartRequired, true);
      onNoticeRef.current?.("已放弃本次更改");
      onCloseRef.current();
    } catch (e) {
      closing.current = false;
      setEnding(false);
      onErrorRef.current(`放弃更改失败: ${(e as Error).message}`);
    }
  };

  const resetDefaults = async () => {
    if (closing.current) return;
    closing.current = true;
    setEnding(true);
    clearTimeout(saveTimer.current);
    try {
      await saveQueue.current;
      await api.resetConnectionDefaults();
      onSavedRef.current(false, true);
      onNoticeRef.current?.("已恢复默认配置（模型配置除外）");
      onCloseRef.current();
    } catch (e) {
      closing.current = false;
      setEnding(false);
      onErrorRef.current(`恢复默认配置失败: ${(e as Error).message}`);
    }
  };

  const runTest = async () => {
    setTest({ running: true, result: null });
    try {
      const saved = await enqueueSave(false);
      if (saved.restartRequired) {
        setTest({ running: false, result: "数据目录已更改，请重启服务后再测试" });
        return;
      }
      const result = await api.testConnection();
      setTest({
        running: false,
        result: result.ok ? `✓ 连通（${result.provider}/${result.model}）` : `✗ ${result.error ?? "无输出"}`,
      });
    } catch (e) {
      setTest({ running: false, result: `✗ ${(e as Error).message}` });
    }
  };

  const testModel = async (providerId: string, modelId: string) => {
    const key = providerId + "::" + modelId;
    setModelTests((previous) => ({ ...previous, [key]: { state: "running" } }));
    try {
      await enqueueSave(true);
      const result = await api.testConnection({ providerId, modelId });
      setModelTests((previous) => ({ ...previous, [key]: result.ok ? { state: "ok" } : { state: "error", error: result.error } }));
    } catch (e) {
      setModelTests((previous) => ({ ...previous, [key]: { state: "error", error: (e as Error).message } }));
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4" onClick={() => void flushAndClose()}>
      <div
        role="dialog" aria-label="设置" aria-modal="true"
        className="max-h-[88vh] w-full max-w-5xl overflow-y-auto rounded-xl border border-tavern-border bg-tavern-panel p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-tavern-accent">设置</h2>
          <button type="button" aria-label="关闭设置" onClick={() => void flushAndClose()}
            className="rounded-md px-2 py-1 text-tavern-dim hover:text-tavern-text">✕</button>
        </div>

        {/* 模型连接 */}
        <section className="mb-5">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-medium">模型连接（OpenAI 兼容中转 / API）</h3>
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" onClick={() => void runTest()} disabled={saving || test.running || vectorTest.running || !defaultProvider}
                className="rounded-md border border-tavern-border px-3 py-1.5 text-xs text-tavern-text hover:border-tavern-accent-dim disabled:opacity-40">
                {test.running ? "测试中…" : "测试连通"}
              </button>
              <button type="button" onClick={addProvider} className="rounded-md bg-tavern-raised px-2 py-1.5 text-xs text-tavern-accent hover:bg-tavern-raised/70">
                ＋ 添加
              </button>
            </div>
          </div>
          {test.result && <p role="status" className={"mb-2 text-xs " + (test.result.startsWith("✓") ? "text-emerald-400" : "text-red-400")}>{test.result}</p>}
          {providers.length === 0 && (
            <p className="rounded-md border border-dashed border-tavern-border p-3 text-xs text-tavern-dim">
              还没有连接。添加中转并填写接口地址与 API Key，然后获取模型列表，或手动填写上游的模型 ID。
            </p>
          )}
          <div className="flex flex-col gap-3">
            {providers.map((p) => (
              <div key={p.id} role="group" aria-label={"模型连接：" + p.name} className="min-w-0 rounded-xl border border-tavern-border bg-tavern-bg p-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="min-w-0 text-xs text-tavern-dim">名称 <span className="text-red-400">*</span>
                    <input aria-label="连接名称" value={p.name} onChange={(e) => updateProvider(p.id, { name: e.target.value })} placeholder="例如：OpenAI 官方"
                      className="mt-1 w-full rounded-md border border-tavern-border bg-tavern-raised px-2.5 py-2 text-sm text-tavern-text outline-none focus:border-tavern-accent-dim" />
                  </label>
                  <label className="min-w-0 text-xs text-tavern-dim">接口类型
                    <select aria-label={p.name + "接口类型"} value={p.apiType ?? "chat"} onChange={(e) => updateProvider(p.id, { apiType: e.target.value as "chat" | "text" })}
                      className="mt-1 w-full rounded-md border border-tavern-border bg-tavern-raised px-2.5 py-2 text-sm text-tavern-text outline-none">
                      <option value="chat">聊天补全（支持工具）</option>
                      <option value="text">文本补全（OpenAI 兼容）</option>
                    </select>
                  </label>
                  <label className="min-w-0 text-xs text-tavern-dim sm:col-span-2">API Key <span className="text-red-400">*</span>
                    <div className="relative mt-1">
                      <input aria-label="API Key" type={visibleKeys[p.id] ? "text" : "password"} value={p.apiKeyInput}
                        onChange={(e) => updateProvider(p.id, { apiKeyInput: e.target.value })}
                        placeholder={p.hasApiKey ? "API Key 已保存（留空保持不变）" : "API Key"}
                        className="w-full rounded-md border border-tavern-border bg-tavern-raised px-2.5 py-2 pr-10 text-sm text-tavern-text outline-none focus:border-tavern-accent-dim" />
                      <button type="button" onClick={() => setVisibleKeys((old) => ({ ...old, [p.id]: !old[p.id] }))}
                        aria-label={visibleKeys[p.id] ? "隐藏 API Key" : "显示 API Key"}
                        className="absolute right-1 top-1/2 -translate-y-1/2 rounded px-2 py-1 text-sm text-tavern-dim hover:text-tavern-text">
                        👁
                      </button>
                    </div>
                  </label>
                  <label className="min-w-0 text-xs text-tavern-dim sm:col-span-2">API 请求地址 <span className="text-red-400">*</span>
                    <input aria-label="接口地址" value={p.baseUrl} onChange={(e) => updateProvider(p.id, { baseUrl: e.target.value })} placeholder="https://api.example.com/v1"
                      className="mt-1 w-full rounded-md border border-tavern-border bg-tavern-raised px-2.5 py-2 text-sm text-tavern-text outline-none focus:border-tavern-accent-dim" />
                    <span className="mt-1 block text-[11px] text-tavern-dim">OpenAI 兼容地址，例如 https://中转域名/v1；填到 /v1 为止。</span>
                  </label>
                </div>
                {p.apiType === "text" && (
                  <div className="mt-3 rounded-lg border border-tavern-border bg-tavern-panel/40 p-3 text-xs">
                    <div className="flex flex-wrap items-center gap-2">
                      <label>Instruct 模板
                        <select aria-label={p.name + "Instruct 模板"} value={Object.entries(INSTRUCT_TEMPLATES).find(([, value]) => JSON.stringify(value) === JSON.stringify(p.instruct ?? INSTRUCT_TEMPLATES.ChatML))?.[0] ?? "custom"}
                          onChange={(e) => { if (INSTRUCT_TEMPLATES[e.target.value]) updateProvider(p.id, { instruct: INSTRUCT_TEMPLATES[e.target.value] }); }}
                          className="ml-2 rounded border border-tavern-border bg-tavern-raised px-2 py-1">
                          {Object.keys(INSTRUCT_TEMPLATES).map((name) => <option key={name}>{name}</option>)}
                          <option value="custom" disabled>{p.instruct?.name ?? "自定义"}</option>
                        </select>
                      </label>
                      <label className="cursor-pointer text-tavern-accent">导入 ST instruct JSON
                        <input type="file" accept=".json" className="sr-only" onChange={async (e) => {
                          const file = e.target.files?.[0]; e.target.value = "";
                          if (!file) return;
                          try {
                            const value = JSON.parse(await file.text());
                            if (typeof value?.input_sequence !== "string" || typeof value?.output_sequence !== "string") throw new Error("请选择 instruct 预设，需包含 input_sequence 和 output_sequence");
                            updateProvider(p.id, { instruct: { ...value, name: value.name || file.name.replace(/\.json$/i, "") } });
                            onNotice?.("模板已载入，保存后生效");
                          } catch (error) { onError((error as Error).message); }
                        }} />
                      </label>
                    </div>
                    <details className="mt-2 text-tavern-dim"><summary>查看模板</summary>
                      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(p.instruct ?? INSTRUCT_TEMPLATES.ChatML, null, 2)}</pre>
                    </details>
                  </div>
                )}

                <div className="mt-4 flex flex-wrap items-end justify-between gap-2">
                  <div>
                    <h4 className="text-sm font-medium">模型列表</h4>
                    <p className="mt-0.5 text-[11px] leading-5 text-tavern-dim">思考等级保持「关闭」按普通模型使用；官方 API 的推理模型可选低/中/高。中转站通常保持关闭。</p>
                  </div>
                  <button type="button" onClick={() => setManualFor((old) => old === p.id ? null : p.id)}
                    className="rounded-md border border-tavern-border px-3 py-1.5 text-xs text-tavern-accent hover:border-tavern-accent-dim">
                    ＋ 手动添加
                  </button>
                </div>

                {manualFor === p.id && (
                  <div className="mt-2 flex flex-wrap gap-2 rounded-lg border border-dashed border-tavern-border p-2">
                    <input aria-label="手动模型 ID" value={p.newModelId} onChange={(e) => updateProvider(p.id, { newModelId: e.target.value })}
                      onKeyDown={(e) => e.key === "Enter" && addModel(p.id)} placeholder="输入上游模型 ID，如 gpt-6.1-sol-max"
                      className="min-w-0 flex-1 rounded-md border border-tavern-border bg-tavern-raised px-2 py-1.5 text-xs outline-none" />
                    <button type="button" onClick={() => { addModel(p.id); setManualFor(null); }}
                      className="rounded-md bg-tavern-raised px-3 py-1.5 text-xs text-tavern-accent">添加模型</button>
                  </div>
                )}

                <ModelDiscovery provider={p} onAdd={(model) => addModel(p.id, model)} />
                {p.models.length === 0 ? (
                  <p className="mt-2 rounded-lg border border-dashed border-tavern-border px-3 py-4 text-xs text-tavern-dim">还没有模型。点上方「获取模型列表」，或使用「手动添加」。</p>
                ) : (
                  <div className="mt-2 overflow-x-auto rounded-lg border border-tavern-border">
                    <table className="w-full min-w-[900px] border-collapse text-xs">
                      <thead className="bg-tavern-raised/60 text-tavern-dim">
                        <tr>
                          <th className="w-12 px-2 py-2 text-left font-medium">默认</th>
                          <th className="px-2 py-2 text-left font-medium">菜单显示名</th>
                          <th className="px-2 py-2 text-left font-medium">实际请求模型</th>
                          <th className="w-28 px-2 py-2 text-left font-medium">上下文窗口</th>
                          <th className="w-24 px-2 py-2 text-left font-medium">最大输出</th>
                          <th className="w-24 px-2 py-2 text-left font-medium">思考等级</th>
                          <th className="w-28 px-2 py-2 text-left font-medium">Token 计数</th>
                          <th className="w-14 px-2 py-2 text-center font-medium">测试</th>
                          <th className="w-10 px-2 py-2" />
                        </tr>
                      </thead>
                      <tbody>
                        {p.models.map((model) => {
                          const isDefault = defaultProvider === p.id && defaultModel === model.id;
                          const testState = modelTests[p.id + "::" + model.id];
                          return (
                            <tr key={model.id} className="border-t border-tavern-border/70 align-top">
                              <td className="px-2 py-2 align-middle">
                                <input type="radio" name={"default-model-" + p.id} aria-label={"设为默认模型：" + model.id} checked={isDefault}
                                  onChange={() => { setDefaultProvider(p.id); setDefaultModel(model.id); }} className="accent-tavern-accent" />
                              </td>
                              <td className="px-2 py-2">
                                <input aria-label={"模型显示名：" + model.id} value={model.name}
                                  onChange={(e) => updateModel(p.id, model.id, { name: e.target.value })}
                                  className="w-full rounded border border-tavern-border bg-tavern-raised px-1.5 py-1 text-xs text-tavern-text" />
                              </td>
                              <td className="px-2 py-2">
                                <input aria-label={"请求模型 ID：" + model.id} value={model.id}
                                  onChange={(e) => { const next = e.target.value; const wasDefault = defaultProvider === p.id && defaultModel === model.id; updateModel(p.id, model.id, { id: next }); if (wasDefault) setDefaultModel(next); }}
                                  className="w-full rounded border border-tavern-border bg-tavern-raised px-1.5 py-1 font-mono text-xs text-tavern-text" />
                              </td>
                              <td className="px-2 py-2">
                                <input type="number" min={1} max={10000000} aria-label={"模型上下文长度：" + model.id} value={model.contextWindow}
                                  onChange={(e) => updateModel(p.id, model.id, { contextWindow: Number(e.target.value) })}
                                  className="w-full rounded border border-tavern-border bg-tavern-raised px-1.5 py-1 text-xs text-tavern-text" />
                              </td>
                              <td className="px-2 py-2">
                                <input type="number" min={1} max={10000000} aria-label={"模型最大输出：" + model.id} value={model.maxTokens}
                                  onChange={(e) => updateModel(p.id, model.id, { maxTokens: Number(e.target.value) })}
                                  className="w-full rounded border border-tavern-border bg-tavern-raised px-1.5 py-1 text-xs text-tavern-text" />
                              </td>
                              <td className="px-2 py-2">
                                <select aria-label={"思考等级：" + model.id} value={model.thinkingLevel ?? "off"}
                                  onChange={(e) => setModelThinkingLevel(p.id, model.id, e.target.value as ReasoningLevel)}
                                  className="w-full rounded border border-tavern-border bg-tavern-raised px-1 py-1 text-xs text-tavern-text">
                                  <option value="off">关闭</option><option value="minimal">最低</option><option value="low">低</option>
                                  <option value="medium">中</option><option value="high">高</option>
                                </select>
                              </td>
                              <td className="px-2 py-2">
                                <select aria-label={"Token 计数方式：" + model.id} value={model.tokenizer ?? "auto"}
                                  onChange={(e) => updateModel(p.id, model.id, { tokenizer: e.target.value as NonNullable<typeof model.tokenizer> })}
                                  className="w-full rounded border border-tavern-border bg-tavern-raised px-1 py-1 text-xs text-tavern-text">
                                  <option value="auto">自动</option><option value="o200k_base">o200k</option>
                                  <option value="cl100k_base">cl100k</option><option value="estimate">估算</option>
                                </select>
                              </td>
                              <td className="px-2 py-2 text-center align-middle">
                                <button type="button" disabled={testState?.state === "running"}
                                  aria-label={"测试模型：" + model.id + (testState?.state === "error" && testState.error ? "，失败：" + testState.error : "")}
                                  onClick={() => void testModel(p.id, model.id)}
                                  className={"rounded px-1.5 py-1 text-sm leading-none transition-colors disabled:opacity-50 " + (testState?.state === "ok"
                                    ? "text-emerald-400"
                                    : testState?.state === "error"
                                      ? "text-red-400"
                                      : "text-tavern-dim hover:text-tavern-accent")}>
                                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor" aria-hidden="true">
                                    <path d="M13 2 4.5 13H11l-1 9L19 11h-6.5L13 2Z" />
                                  </svg>
                                </button>
                              </td>
                              <td className="px-2 py-2 text-right">
                                <button type="button" aria-label={"删除模型：" + model.id} onClick={() => removeModel(p.id, model.id)}
                                  className="rounded px-1.5 py-1 text-tavern-dim hover:bg-red-500/10 hover:text-red-400">🗑</button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>

        {/* 对话上下文 */}
        <section className="mb-5">
          <h3 className="mb-2 text-sm font-medium">对话上下文</h3>
          <div className="mb-2 flex flex-col gap-2 sm:flex-row">
            <button
              type="button"
              onClick={() => setContextMode("simple")}
              className={`flex-1 rounded-md border px-3 py-2 text-left text-sm ${
                contextMode === "simple" ? "border-tavern-accent bg-tavern-accent/10" : "border-tavern-border bg-tavern-bg"
              }`}
            >
              内置简洁组装
              <span className="block text-xs text-tavern-dim">人物卡三件套 + 基础扮演规则</span>
            </button>
            <button
              type="button"
              onClick={() => setContextMode("bridge")}
              className={`flex-1 rounded-md border px-3 py-2 text-left text-sm ${
                contextMode === "bridge" ? "border-tavern-accent bg-tavern-accent/10" : "border-tavern-border bg-tavern-bg"
              }`}
            >
              ST 预设桥接
              <span className="block text-xs text-tavern-dim">prompt_order + 宏 + 世界书 + 提示词正则</span>
            </button>
            <button
              type="button"
              onClick={() => setContextMode("takeover")}
              disabled={textCompletion}
              className={`flex-1 rounded-md border px-3 py-2 text-left text-sm ${
                contextMode === "takeover" ? "border-tavern-accent bg-tavern-accent/10" : "border-tavern-border bg-tavern-bg"
              }`}
            >
              Agent 接管
              <span className="block text-xs text-tavern-dim">仅常驻世界书注入 + 近 N 轮历史，其余全靠工具召回</span>
            </button>
          </div>
          {contextMode === "takeover" && (
            <div className="flex flex-wrap items-center gap-4 rounded-lg border border-tavern-border bg-tavern-bg p-3 text-xs text-tavern-dim">
              <label className="flex items-center gap-1.5">
                保留全文轮数
                <input
                  type="number"
                  min={1}
                  max={50}
                  value={recentTurns}
                  onChange={(e) => setRecentTurns(Number(e.target.value) || 3)}
                  className="w-16 rounded border border-tavern-border bg-tavern-raised px-1.5 py-0.5 text-tavern-text"
                />
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={stateProjection} onChange={(e) => setStateProjection(e.target.checked)} />
                状态投影（tavern_set_state 每轮结算现场快照）
              </label>
            </div>
          )}
          {contextMode === "bridge" && (
            <div className="rounded-lg border border-tavern-border bg-tavern-bg p-3">
              <label className="mb-1 block text-xs text-tavern-dim">预设（OpenAI Settings/ 目录）</label>
              <select
                value={activePreset}
                onChange={(e) => setActivePreset(e.target.value)}
                className="mb-2 w-full rounded-md border border-tavern-border bg-tavern-raised px-2 py-1.5 text-sm outline-none"
              >
                <option value="">（未选择）</option>
                {presets.map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name}（{p.orderCount}/{p.promptCount} 条）
                  </option>
                ))}
              </select>
              <div className="flex items-center gap-4 text-xs text-tavern-dim">
                <label className="flex items-center gap-1.5">
                  扫描深度（0 不扫描聊天）
                  <input
                    type="number"
                    min={0}
                    max={1000}
                    value={scanDepth}
                    onChange={(e) => setScanDepth(Number(e.target.value) || 0)}
                    className="w-16 rounded border border-tavern-border bg-tavern-raised px-1.5 py-0.5 text-tavern-text"
                  />
                </label>
                <label className="flex items-center gap-1.5">
                  递归步数
                  <input
                    type="number"
                    min={0}
                    max={10}
                    value={recursionSteps}
                    onChange={(e) => setRecursionSteps(Number(e.target.value) || 0)}
                    className="w-16 rounded border border-tavern-border bg-tavern-raised px-1.5 py-0.5 text-tavern-text"
                  />
                </label>
              </div>
            </div>
          )}
          <div className="mt-3 rounded-lg border border-tavern-border bg-tavern-bg p-3">
            <label className="mb-1 flex items-center gap-2 text-xs text-tavern-dim">
              全局世界书（卡内书与卡片引用世界自动生效）
              <button
                type="button"
                aria-label="导入世界书"
                onClick={() => worldFileRef.current?.click()}
                className="ml-auto rounded border border-tavern-border px-1.5 py-0.5 hover:border-tavern-accent-dim hover:text-tavern-text"
              >
                ＋ 导入
              </button>
              <input
                ref={worldFileRef}
                type="file"
                accept=".json"
                hidden
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void importWorld(file);
                  e.target.value = "";
                }}
              />
            </label>
            {worlds.length === 0 ? (
              <p className="mb-2 text-xs text-tavern-dim">worlds/ 目录暂无世界书文件</p>
            ) : (
              <div className="mb-2 flex flex-wrap gap-1.5">
                {worlds.map((w) => {
                  const on = activeWorlds.includes(w.name);
                  return (
                    <button
                      key={w.name}
                      type="button"
                      onClick={() => setActiveWorlds((list) => (on ? list.filter((x) => x !== w.name) : [...list, w.name]))}
                      className={`rounded-full px-2.5 py-0.5 text-xs ${on ? "bg-tavern-accent text-tavern-bg" : "bg-tavern-raised text-tavern-dim hover:text-tavern-text"}`}
                    >
                      {w.name}（{w.entryCount}）
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </section>

        {/* 输出协议与压缩 */}
        <section className="mb-5 rounded-lg border border-tavern-border bg-tavern-bg p-3">
          <h3 className="mb-2 text-sm font-medium">世界书检索（ST 桥接模式）</h3>
          <label className="mb-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={useGroupScoring}
            onChange={(event) => setUseGroupScoring(event.target.checked)} />分组优先选择关键词命中更多的条目（条目设置可覆盖）</label>
          <div className="mb-3 flex flex-wrap gap-3 text-xs text-tavern-dim">
            {[
              { label: "最少激活数（0 关闭）", value: minActivations, set: setMinActivations, max: 1000 },
              { label: "最大扫描深度（0 到历史末尾）", value: minActivationsDepthMax, set: setMinActivationsDepthMax, max: 1000 },
              { label: "Token 预算（0 不单独限制）", value: budgetTokens, set: setBudgetTokens, max: 1000000 },
            ].map((field) => <label key={field.label} className="flex items-center gap-2">{field.label}
              <input aria-label={field.label} type="number" min={0} max={field.max} value={field.value} onChange={(e) => field.set(Number(e.target.value))}
                className="w-20 rounded border border-tavern-border bg-tavern-raised px-2 py-1 text-tavern-text" />
            </label>)}
          </div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={vectors.enabled} onChange={(e) => setVectors({ ...vectors, enabled: e.target.checked })} />启用向量世界书</label>
          <p className="my-2 text-xs text-tavern-dim">检索标记为 vectorized 的条目；会将候选条目和最近对话发送给所选 embedding 服务。首次使用建立本地索引，修改条目或模型后自动更新。</p>
          {vectors.enabled && <div className="grid gap-2 sm:grid-cols-2">
            <label className="text-xs">向量连接<select aria-label="向量连接" value={vectors.providerId} onChange={(e) => setVectors({ ...vectors, providerId: e.target.value })}
              className="mt-1 w-full rounded border border-tavern-border bg-tavern-raised px-2 py-1.5">
              <option value="">请选择连接</option>{providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select></label>
            <label className="text-xs">Embedding 模型<input aria-label="Embedding 模型" value={vectors.model} onChange={(e) => setVectors({ ...vectors, model: e.target.value })}
              placeholder="填写服务支持的向量模型 ID" className="mt-1 w-full rounded border border-tavern-border bg-tavern-raised px-2 py-1.5" /></label>
            {([
              ["queryMessages", "查询使用最近消息数", 1, 100, 1], ["maxEntries", "最多召回条目", 1, 100, 1], ["scoreThreshold", "相似度阈值", -1, 1, 0.05],
            ] as const).map(([key, label, min, max, step]) => <label key={key} className="text-xs">{label}
              <input aria-label={label} type="number" min={min} max={max} step={step} value={vectors[key]} onChange={(e) => setVectors({ ...vectors, [key]: Number(e.target.value) })}
                className="ml-2 w-20 rounded border border-tavern-border bg-tavern-raised px-2 py-1" />
            </label>)}
            <button type="button" disabled={saving || test.running || vectorTest.running} className="rounded border border-tavern-border px-2 py-1 text-xs disabled:opacity-40" onClick={async () => {
              setVectorTest({ running: true, result: null });
              try {
                await enqueueSave(false); const result = await api.testVectors();
                setVectorTest({ running: false, result: `✓ 连接成功（${result.dimensions} 维）` });
              } catch (error) { setVectorTest({ running: false, result: `✗ ${(error as Error).message}` }); }
            }}>{vectorTest.running ? "测试中…" : "保存并测试向量连接"}</button>
            {vectorTest.result && <p className="text-xs sm:col-span-2">{vectorTest.result}</p>}
          </div>}
        </section>
        {textCompletion && <p className="mb-4 rounded border border-tavern-border p-3 text-xs text-tavern-dim">当前使用文本补全：仅支持简洁/ST 桥接模式与原生文本输出，工具调用已停用。Instruct 模板应与模型匹配。</p>}
        <section className="mb-5">
          <h3 className="mb-2 text-sm font-medium">输出协议与历史压缩</h3>
          <div className="mb-2 flex flex-col gap-2 sm:flex-row">
            <button
              type="button"
              onClick={() => setOutputProtocol("native")}
              className={`flex-1 rounded-md border px-3 py-2 text-left text-sm ${
                outputProtocol === "native" ? "border-tavern-accent bg-tavern-accent/10" : "border-tavern-border bg-tavern-bg"
              }`}
            >
              原生文本流式
              <span className="block text-xs text-tavern-dim">直接输出正文，最简单</span>
            </button>
            <button
              type="button"
              onClick={() => setOutputProtocol("game_tool")}
              disabled={textCompletion}
              className={`flex-1 rounded-md border px-3 py-2 text-left text-sm ${
                outputProtocol === "game_tool" ? "border-tavern-accent bg-tavern-accent/10" : "border-tavern-border bg-tavern-bg"
              }`}
            >
              强制工具防截断
              <span className="block text-xs text-tavern-dim">正文必须走 game_content 工具（原生 function calling 取代伪 JSON 预填）</span>
            </button>
          </div>
          {outputProtocol === "game_tool" && (
            <label className="mb-2 flex items-center gap-2 text-xs text-tavern-dim">
              <input type="checkbox" checked={protocolStrict} onChange={(e) => setProtocolStrict(e.target.checked)} />
              向中转透传 tool_choice=required（部分中转不兼容时关闭）
            </label>
          )}
          <div className="flex flex-wrap items-center gap-4 rounded-lg border border-tavern-border bg-tavern-bg p-3 text-xs text-tavern-dim">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={compressionEnabled} onChange={(e) => setCompressionEnabled(e.target.checked)} />
              历史压缩（超上下文预算时：旧轮摘要折叠为 |用户|/|游戏剧情| 块）
            </label>
            <label className="flex items-center gap-1.5">
              保留全文轮数
              <input
                type="number"
                min={1}
                max={100}
                value={keepFullTurns}
                onChange={(e) => setKeepFullTurns(Number(e.target.value) || 6)}
                className="w-16 rounded border border-tavern-border bg-tavern-raised px-1.5 py-0.5 text-tavern-text"
              />
            </label>
          </div>
        </section>

        {/* 多分支 */}
        <section className="mb-5 rounded-lg border border-tavern-border bg-tavern-bg p-3">
          <h3 className="mb-2 text-sm font-medium">剧情分支与自动候选</h3>
          <label className="flex flex-wrap items-center gap-2 text-sm">
            每次正常回复后自动追加
            <select aria-label="自动候选分支数" value={autoGenerate}
              onChange={(e) => setAutoGenerate(Number(e.target.value))}
              className="rounded border border-tavern-border bg-tavern-raised px-2 py-1 text-tavern-text">
              <option value={0}>关闭</option>
              {[1, 2, 3, 4].map((count) => <option key={count} value={count}>{count} 个额外候选</option>)}
            </select>
          </label>
          <p className="mt-2 text-xs leading-5 text-tavern-dim">
            开启后，每次回复成功会自动再生成指定数量的替代走向，并保留为可切换的分支；每多一个候选就多一次模型调用，会额外消耗 token/费用。
            生成过程中可以随时停止。历史分支会保留后续剧情，可以回到任意分叉点切换到另一条路线继续写。
          </p>
        </section>

        {/* 聊天配色 */}
        <section className="mb-5 rounded-lg border border-tavern-border bg-tavern-bg p-3">
          <h3 className="mb-2 text-sm font-medium">聊天配色</h3>
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <span className="w-24">角色回复</span>
              <input type="color" aria-label="角色回复颜色" value={speechColor || "#e8e2f0"} onChange={(event) => setSpeechColor(event.target.value)}
                className="h-8 w-12 cursor-pointer rounded border border-tavern-border bg-tavern-raised" />
              <span className="text-xs text-tavern-dim">{speechColor || "未自定义"}</span>
              <button type="button" onClick={() => setSpeechColor("")} className="rounded border border-tavern-border px-2 py-1 text-xs text-tavern-dim hover:text-tavern-text">跟随主题</button>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <span className="w-24">默认对白</span>
              <input type="color" aria-label="对白颜色" value={dialogueColor || "#d4a24e"} onChange={(event) => setDialogueColor(event.target.value)}
                className="h-8 w-12 cursor-pointer rounded border border-tavern-border bg-tavern-raised" />
              <span className="text-xs text-tavern-dim">{dialogueColor || "未自定义"}</span>
              <button type="button" onClick={() => setDialogueColor("")} className="rounded border border-tavern-border px-2 py-1 text-xs text-tavern-dim hover:text-tavern-text">跟随强调色</button>
            </div>
          </div>
          <div className="mt-3">
            <div className="flex items-center justify-between">
              <span className="text-sm">对白符号</span>
              <button type="button" onClick={() => setDialoguePairs((pairs) => [...pairs, { open: "『", close: "』" }])}
                className="rounded border border-tavern-border px-2 py-1 text-xs text-tavern-accent hover:border-tavern-accent-dim">＋ 添加符号</button>
            </div>
            <div className="mt-1.5 flex flex-col gap-1.5">
              {dialoguePairs.map((pair, index) => (
                <div key={index} className="flex flex-wrap items-center gap-2">
                  <input aria-label={"对白起始符号 " + (index + 1)} value={pair.open} maxLength={8}
                    onChange={(event) => setDialoguePairs((pairs) => pairs.map((item, itemIndex) => itemIndex === index ? { ...item, open: event.target.value } : item))}
                    className="w-16 rounded border border-tavern-border bg-tavern-raised px-2 py-1 text-sm text-tavern-text" />
                  <span className="text-xs text-tavern-dim">至</span>
                  <input aria-label={"对白结束符号 " + (index + 1)} value={pair.close} maxLength={8}
                    onChange={(event) => setDialoguePairs((pairs) => pairs.map((item, itemIndex) => itemIndex === index ? { ...item, close: event.target.value } : item))}
                    className="w-16 rounded border border-tavern-border bg-tavern-raised px-2 py-1 text-sm text-tavern-text" />
                  <input type="color" aria-label={"对白符号颜色 " + (index + 1)} value={pair.color || dialogueColor || "#d4a24e"}
                    onChange={(event) => setDialoguePairs((pairs) => pairs.map((item, itemIndex) => itemIndex === index ? { ...item, color: event.target.value } : item))}
                    className="h-8 w-12 cursor-pointer rounded border border-tavern-border bg-tavern-raised" />
                  <button type="button" aria-label={"清除对白符号颜色 " + (index + 1)} title="跟随默认对白颜色"
                    onClick={() => setDialoguePairs((pairs) => pairs.map((item, itemIndex) => itemIndex === index ? { ...item, color: undefined } : item))}
                    className="rounded border border-tavern-border px-2 py-1 text-xs text-tavern-dim hover:text-tavern-text">默认</button>
                  <button type="button" aria-label={"删除对白符号 " + (index + 1)} onClick={() => setDialoguePairs((pairs) => pairs.filter((_, itemIndex) => itemIndex !== index))}
                    className="rounded border border-tavern-border px-2 py-1 text-xs text-tavern-dim hover:text-red-400">删除</button>
                </div>
              ))}
              {dialoguePairs.length === 0 && <p className="text-xs text-tavern-dim">还没有符号对；添加后才会给对白上色。</p>}
            </div>
          </div>
          <p className="mt-2 text-xs leading-5 text-tavern-dim">
            默认「」和“”；两个符号之间（含符号）使用对白颜色。每组符号可单独设色，点「默认」跟随默认对白颜色/强调色。符号支持自定义，最多 20 组。思考文字不再单独设色。
          </p>
        </section>

        {/* persona 与数据目录 */}
        <section className="mb-5 grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-sm">用户名（persona）</label>
            <input
              aria-label="用户名"
              value={personaName}
              onChange={(e) => setPersonaName(e.target.value)}
              className="w-full rounded-md border border-tavern-border bg-tavern-bg px-2 py-1.5 text-sm outline-none"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm">用户人设</label>
            <input
              aria-label="用户人设"
              value={personaDescription}
              onChange={(e) => setPersonaDescription(e.target.value)}
              placeholder="一句话人设，可选"
              className="w-full rounded-md border border-tavern-border bg-tavern-bg px-2 py-1.5 text-sm outline-none"
            />
          </div>
          <div className="col-span-2">
            <label className="mb-1 block text-sm">
              ST 数据目录 <span className="text-xs text-tavern-dim">（可指向现有 SillyTavern 的 data/default-user，改后需重启）</span>
            </label>
            <input
              aria-label="ST 数据目录"
              value={stDataDir}
              onChange={(e) => setStDataDir(e.target.value)}
              className="w-full rounded-md border border-tavern-border bg-tavern-bg px-2 py-1.5 text-sm outline-none"
            />
          </div>
        </section>

        <div className="flex flex-wrap items-center gap-3 border-t border-tavern-border pt-4">
          <p role="status" className="text-xs text-tavern-dim">
            {saveState === "saving" ? "正在自动保存…" : saveState === "error" ? "自动保存失败，请检查错误提示"
              : dirty ? "等待自动保存…" : restartRequired ? "已自动保存；数据目录更改需重启服务后生效"
                : saveState === "saved" ? "已自动保存" : "更改会自动保存"}
          </p>
          <div className="ml-auto flex flex-wrap justify-end gap-2">
            <button type="button" onClick={() => void resetDefaults()} disabled={ending || test.running || vectorTest.running}
              title="保留模型连接、API Key、默认模型和数据目录"
              className="rounded-md border border-tavern-border px-3 py-1.5 text-sm text-tavern-text hover:border-tavern-accent-dim disabled:opacity-40">
              恢复默认配置（模型配置除外）
            </button>
            <button type="button" onClick={() => void discardChanges()} disabled={ending || test.running || vectorTest.running}
              className="rounded-md border border-tavern-border px-3 py-1.5 text-sm text-tavern-dim hover:border-red-400 hover:text-red-400 disabled:opacity-40">
              放弃本次更改
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
