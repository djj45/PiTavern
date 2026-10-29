import { useEffect, useRef, useState } from "react";
import type { DiscoveredModelDto, ProviderDto } from "@pitavern/shared";
import { api } from "../api.ts";

interface ModelDiscoveryProps {
  provider: ProviderDto & { apiKeyInput: string };
  onAdd: (model: DiscoveredModelDto) => void;
}

export function ModelDiscovery({ provider, onAdd }: ModelDiscoveryProps) {
  const [models, setModels] = useState<DiscoveredModelDto[] | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const request = useRef<AbortController | null>(null);

  useEffect(() => {
    setModels(null); setRunning(false); setError(""); setSearch(""); setSelectedId("");
    return () => { request.current?.abort(); request.current = null; };
  }, [provider.id, provider.baseUrl, provider.apiKeyInput]);

  const cancel = () => {
    request.current?.abort(); request.current = null; setRunning(false);
  };
  const discover = async () => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setRunning(true); setError(""); setModels(null); setSearch(""); setSelectedId("");
    try {
      const result = await api.discoverModels({ providerId: provider.id, baseUrl: provider.baseUrl, apiKey: provider.apiKeyInput }, controller.signal);
      if (!controller.signal.aborted && request.current === controller) setModels(result.models);
    } catch (cause) {
      if (!controller.signal.aborted && request.current === controller) setError((cause as Error).message);
    } finally {
      if (request.current === controller) { request.current = null; setRunning(false); }
    }
  };
  const query = search.trim().toLowerCase();
  const matches = (models ?? []).filter((model) => (model.id + " " + model.name).toLowerCase().includes(query));
  const visible = matches.slice(0, 200);
  const selected = models?.find((model) => model.id === selectedId);
  const added = new Set(provider.models.map((model) => model.id));

  return <div className="mt-2 min-w-0 text-xs">
    <div className="flex items-center gap-2">
      <button type="button" disabled={running} onClick={() => void discover()}
        className="rounded-md bg-tavern-raised px-2 py-1.5 text-tavern-accent disabled:opacity-50">
        {running ? "获取中…" : "获取模型列表"}
      </button>
      {running && <button type="button" onClick={cancel} className="text-tavern-dim">取消获取</button>}
    </div>
    {error && <p role="alert" className="mt-2 break-words text-red-400">{error}</p>}
    {models !== null && <div className="mt-2 min-w-0 rounded-md border border-tavern-border p-2">
      <p role="status" className="mb-2 text-tavern-dim">{models.length
        ? `已获取 ${models.length} 个模型，请选择后添加，添加后自动保存。`
        : "服务返回的模型列表为空，可手动添加模型。"}</p>
      {models.length > 0 && <>
        <input aria-label="搜索可用模型" value={search} onChange={(event) => { setSearch(event.target.value); setSelectedId(""); }}
          placeholder="搜索模型 ID 或名称" className="mb-2 w-full min-w-0 rounded border border-tavern-border bg-tavern-raised px-2 py-1.5" />
        <div className="flex min-w-0 gap-2">
          <select aria-label="可用模型" value={selectedId} onChange={(event) => setSelectedId(event.target.value)}
            className="min-w-0 flex-1 rounded border border-tavern-border bg-tavern-raised px-2 py-1.5">
            <option value="">{matches.length ? "请选择模型" : "没有匹配的模型"}</option>
            {visible.map((model) => <option key={model.id} value={model.id} disabled={added.has(model.id)}>
              {model.id}{model.name !== model.id ? ` · ${model.name}` : ""}{added.has(model.id) ? "（已添加）" : ""}
            </option>)}
          </select>
          <button type="button" disabled={!selected || added.has(selected.id)}
            onClick={() => { if (selected) { onAdd(selected); setSelectedId(""); } }}
            className="shrink-0 rounded bg-tavern-raised px-2 py-1.5 text-tavern-accent disabled:opacity-50">添加所选模型</button>
        </div>
        {matches.length > visible.length && <p className="mt-1 text-tavern-dim">当前显示前 200 项，请搜索缩小范围。</p>}
        <p className="mt-2 text-tavern-dim">列表可能包含非聊天模型；添加后请核对模型用途、上下文长度和输出上限。</p>
      </>}
    </div>}
  </div>;
}
