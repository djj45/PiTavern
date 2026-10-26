import type { ConnectionDto } from "@pitavern/shared";

interface TopBarProps {
  connection: ConnectionDto | null;
  wsConnected: boolean;
  onModelChange: (providerId: string, modelId: string) => void;
  onOpenSettings: () => void;
}

export function TopBar({ connection, wsConnected, onModelChange, onOpenSettings }: TopBarProps) {
  const models =
    connection?.providers.flatMap((p) =>
      p.models.map((m) => ({ providerId: p.id, providerName: p.name, modelId: m.id, modelName: m.name, reasoning: m.reasoning })),
    ) ?? [];
  const currentValue =
    connection && models.some((m) => m.providerId === connection.defaultProvider && m.modelId === connection.defaultModel)
      ? `${connection.defaultProvider}::${connection.defaultModel}`
      : "";

  return (
    <header className="flex h-12 shrink-0 items-center gap-4 border-b border-tavern-border bg-tavern-panel px-4">
      <div className="flex items-center gap-2">
        <span className="text-lg">🍺</span>
        <span className="font-semibold tracking-wide text-tavern-accent">PiTavern</span>
      </div>
      <div className="flex items-center gap-1.5 text-xs text-tavern-dim" title={wsConnected ? "已连接服务" : "服务未连接，自动重试中"}>
        <span className={`inline-block h-2 w-2 rounded-full ${wsConnected ? "bg-emerald-500" : "bg-red-500"}`} />
        {wsConnected ? "在线" : "离线"}
      </div>
      <div className="ml-auto flex items-center gap-2">
        {models.length === 0 ? (
          <span className="text-xs text-tavern-dim">未配置模型</span>
        ) : (
          <select
            className="rounded-md border border-tavern-border bg-tavern-raised px-2 py-1 text-sm text-tavern-text outline-none"
            value={currentValue}
            onChange={(e) => {
              const [providerId, modelId] = e.target.value.split("::");
              onModelChange(providerId, modelId);
            }}
          >
            {models.length > 0 && !currentValue && <option value="">选择模型</option>}
            {models.map((m) => (
              <option key={`${m.providerId}::${m.modelId}`} value={`${m.providerId}::${m.modelId}`}>
                {m.providerName} / {m.modelName}
                {m.reasoning ? " ✦" : ""}
              </option>
            ))}
          </select>
        )}
        <button
          type="button"
          onClick={onOpenSettings}
          className="rounded-md border border-tavern-border bg-tavern-raised px-3 py-1 text-sm text-tavern-text hover:border-tavern-accent-dim"
        >
          设置
        </button>
      </div>
    </header>
  );
}
