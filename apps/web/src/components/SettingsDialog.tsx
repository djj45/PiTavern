import { useEffect, useRef, useState } from "react";
import type { ConnectionDto, PresetSummaryDto, ProviderDto, WorldSummaryDto } from "@pitavern/shared";
import { api } from "../api.ts";

interface SettingsDialogProps {
  connection: ConnectionDto | null;
  onClose: () => void;
  onSaved: (restartRequired?: boolean) => void;
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

export function SettingsDialog({ connection, onClose, onSaved, onError, onNotice }: SettingsDialogProps) {
  const [providers, setProviders] = useState<EditableProvider[]>(() =>
    (connection?.providers ?? []).map((p) => ({ ...p, apiKeyInput: "", newModelId: "" })),
  );
  const [defaultProvider, setDefaultProvider] = useState(connection?.defaultProvider ?? "");
  const [defaultModel, setDefaultModel] = useState(connection?.defaultModel ?? "");
  const [stDataDir, setStDataDir] = useState(connection?.stDataDir ?? "");
  const [personaName, setPersonaName] = useState(connection?.persona.name ?? "");
  const [personaDescription, setPersonaDescription] = useState(connection?.persona.description ?? "");
  const [saving, setSaving] = useState(false);
  const [test, setTest] = useState<TestState>({ running: false, result: null });
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

  const addProvider = () => {
    const id = `relay-${Date.now().toString(36)}`;
    setProviders((list) => [
      ...list,
      { id, name: "新中转", baseUrl: "https://", hasApiKey: false, models: [], apiKeyInput: "", newModelId: "" },
    ]);
  };

  const addModel = (providerId: string) => {
    const provider = providers.find((p) => p.id === providerId);
    const modelId = provider?.newModelId.trim();
    if (!modelId) return;
    updateProvider(providerId, {
      models: [...provider!.models, { id: modelId, name: modelId, reasoning: false, contextWindow: 1_000_000, maxTokens: 16_384 }],
      newModelId: "",
    });
    if (!defaultProvider || !defaultModel) {
      setDefaultProvider(providerId);
      setDefaultModel(modelId);
    }
  };

  const persist = async () => {
    const payload = {
      providers: providers.map((p) => ({
        id: p.id,
        name: p.name,
        baseUrl: p.baseUrl,
        hasApiKey: p.hasApiKey,
        models: p.models,
        // 空串 = 服务端保持原 key 不变；填了新值 = 更新
        apiKey: p.apiKeyInput,
      })),
      defaultProvider,
      defaultModel,
      stDataDir,
      persona: { name: personaName || "旅人", description: personaDescription },
      contextMode,
      activePreset,
      activeWorlds,
      worldInfo: {
        scanDepth,
        recursionSteps,
        caseSensitive: connection?.worldInfo?.caseSensitive ?? false,
        matchWholeWords: connection?.worldInfo?.matchWholeWords ?? true,
      },
      outputProtocol,
      protocolStrict,
      compression: { enabled: compressionEnabled, keepFullTurns },
      takeover: { recentTurns, stateProjection },
    };
    const result = await api.saveConnection(payload);
    onSaved(result.restartRequired);
    return result;
  };

  const save = async () => {
    setSaving(true);
    try {
      await persist();
      onClose();
    } catch (e) {
      onError(`保存失败: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  const runTest = async () => {
    setTest({ running: true, result: null });
    try {
      const saved = await persist();
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

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-xl border border-tavern-border bg-tavern-panel p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-4 text-lg font-semibold text-tavern-accent">设置</h2>

        {/* 模型连接 */}
        <section className="mb-5">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-medium">模型连接（OpenAI 兼容中转 / API）</h3>
            <button type="button" onClick={addProvider} className="rounded-md bg-tavern-raised px-2 py-0.5 text-xs text-tavern-accent hover:bg-tavern-raised/70">
              ＋ 添加
            </button>
          </div>
          {providers.length === 0 && (
            <p className="rounded-md border border-dashed border-tavern-border p-3 text-xs text-tavern-dim">
              还没有连接。添加一个中转（填 baseUrl 与 API Key），再给它加模型（模型 id 需与中转上游一致，如 gemini-2.5-pro）。
            </p>
          )}
          <div className="flex flex-col gap-3">
            {providers.map((p) => (
              <div key={p.id} className="rounded-lg border border-tavern-border bg-tavern-bg p-3">
                <div className="mb-2 grid grid-cols-2 gap-2">
                  <input
                    value={p.name}
                    onChange={(e) => updateProvider(p.id, { name: e.target.value })}
                    placeholder="名称"
                    className="rounded-md border border-tavern-border bg-tavern-raised px-2 py-1.5 text-sm outline-none"
                  />
                  <input
                    value={p.baseUrl}
                    onChange={(e) => updateProvider(p.id, { baseUrl: e.target.value })}
                    placeholder="https://中转域名/v1"
                    className="rounded-md border border-tavern-border bg-tavern-raised px-2 py-1.5 text-sm outline-none"
                  />
                </div>
                <input
                  type="password"
                  value={p.apiKeyInput}
                  onChange={(e) => updateProvider(p.id, { apiKeyInput: e.target.value })}
                  placeholder={p.hasApiKey ? "API Key 已保存（留空保持不变）" : "API Key"}
                  className="mb-2 w-full rounded-md border border-tavern-border bg-tavern-raised px-2 py-1.5 text-sm outline-none"
                />
                <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
                  {p.models.map((m) => {
                    const selected = defaultProvider === p.id && defaultModel === m.id;
                    return (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => {
                          setDefaultProvider(p.id);
                          setDefaultModel(m.id);
                        }}
                        onDoubleClick={() => updateProvider(p.id, { models: p.models.filter((x) => x.id !== m.id) })}
                        title="单击设为默认；双击移除"
                        className={`rounded-full px-2.5 py-0.5 text-xs ${
                          selected ? "bg-tavern-accent text-tavern-bg" : "bg-tavern-raised text-tavern-dim hover:text-tavern-text"
                        }`}
                      >
                        {m.id}
                      </button>
                    );
                  })}
                </div>
                <div className="flex gap-2">
                  <input
                    value={p.newModelId}
                    onChange={(e) => updateProvider(p.id, { newModelId: e.target.value })}
                    onKeyDown={(e) => e.key === "Enter" && addModel(p.id)}
                    placeholder="模型 id，如 gemini-2.5-pro"
                    className="flex-1 rounded-md border border-tavern-border bg-tavern-raised px-2 py-1.5 text-xs outline-none"
                  />
                  <button type="button" onClick={() => addModel(p.id)} className="rounded-md bg-tavern-raised px-2 py-1.5 text-xs text-tavern-accent">
                    加模型
                  </button>
                </div>
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
                  扫描深度
                  <input
                    type="number"
                    min={1}
                    max={100}
                    value={scanDepth}
                    onChange={(e) => setScanDepth(Number(e.target.value) || 1)}
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

        {/* persona 与数据目录 */}
        <section className="mb-5 grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-sm">用户名（persona）</label>
            <input
              value={personaName}
              onChange={(e) => setPersonaName(e.target.value)}
              className="w-full rounded-md border border-tavern-border bg-tavern-bg px-2 py-1.5 text-sm outline-none"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm">用户人设</label>
            <input
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
              value={stDataDir}
              onChange={(e) => setStDataDir(e.target.value)}
              className="w-full rounded-md border border-tavern-border bg-tavern-bg px-2 py-1.5 text-sm outline-none"
            />
          </div>
        </section>

        <div className="flex items-center gap-3 border-t border-tavern-border pt-4">
          <button
            type="button"
            onClick={runTest}
            disabled={saving || test.running || !defaultProvider}
            className="rounded-md border border-tavern-border px-3 py-1.5 text-sm text-tavern-text hover:border-tavern-accent-dim disabled:opacity-40"
          >
            {test.running ? "测试中…" : "保存并测试连通"}
          </button>
          {test.result && <span className={`text-sm ${test.result.startsWith("✓") ? "text-emerald-400" : "text-red-400"}`}>{test.result}</span>}
          <div className="ml-auto flex gap-2">
            <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-tavern-dim hover:text-tavern-text">
              取消
            </button>
            <button type="button" onClick={save} disabled={saving || test.running} className="rounded-md bg-tavern-accent px-4 py-1.5 text-sm font-medium text-tavern-bg">
              {saving ? "保存中…" : "保存"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
