import type { ConnectionDto } from "@pitavern/shared";

interface TopBarProps {
  connection: ConnectionDto | null;
  wsConnected: boolean;
  onModelChange: (providerId: string, modelId: string) => void;
  onOpenSettings: () => void;
  onOpenLibrary: () => void;
  panelOpen: boolean;
  onTogglePanel: () => void;
  theme: string;
  onCycleTheme: () => void;
  onToggleNav: () => void;
}

const THEME_LABELS: Record<string, string> = { night: "夜琥珀", grove: "林间绿", light: "羊皮纸" };

export function TopBar({
  connection,
  wsConnected,
  onModelChange,
  onOpenSettings,
  onOpenLibrary,
  panelOpen,
  onTogglePanel,
  theme,
  onCycleTheme,
  onToggleNav,
}: TopBarProps) {
  const models =
    connection?.providers.flatMap((p) =>
      p.models.map((m) => ({ providerId: p.id, providerName: p.name, modelId: m.id, modelName: m.name, reasoning: m.reasoning })),
    ) ?? [];
  const currentValue =
    connection && models.some((m) => m.providerId === connection.defaultProvider && m.modelId === connection.defaultModel)
      ? `${connection.defaultProvider}::${connection.defaultModel}`
      : "";

  return (
    <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-tavern-border bg-tavern-panel px-3 py-2 sm:h-12 sm:flex-nowrap sm:px-4 sm:py-0">
      <button
        type="button"
        aria-label="菜单"
        onClick={onToggleNav}
        className="shrink-0 rounded-md border border-tavern-border px-2 py-1 text-sm text-tavern-text md:hidden"
      >
        ☰
      </button>
      <div className="flex shrink-0 items-center gap-2">
        <span className="text-lg">🍺</span>
        <span className="font-semibold tracking-wide text-tavern-accent">PiTavern</span>
      </div>
      <div className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs text-tavern-dim" title={wsConnected ? "已连接服务" : "服务未连接，自动重试中"}>
        <span className={`inline-block h-2 w-2 rounded-full ${wsConnected ? "bg-emerald-500" : "bg-red-500"}`} />
        {wsConnected ? "在线" : "离线"}
      </div>
      <div className="flex w-full min-w-0 items-center gap-2 sm:ml-auto sm:w-auto sm:flex-1 sm:justify-end">
        {models.length === 0 ? (
          <span className="min-w-0 flex-1 text-xs text-tavern-dim sm:flex-none">未配置模型</span>
        ) : (
          <select
            aria-label="当前模型"
            className="min-w-0 flex-1 rounded-md border border-tavern-border bg-tavern-raised px-2 py-1 text-sm text-tavern-text outline-none sm:max-w-xs"
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
          onClick={onCycleTheme}
          aria-label="切换主题"
          title={`主题：${THEME_LABELS[theme] ?? theme}（点击切换）`}
          className="shrink-0 rounded-md border border-tavern-border bg-tavern-raised px-2.5 py-1 text-sm text-tavern-text hover:border-tavern-accent-dim"
        >
          🎨
        </button>
        <button
          type="button"
          onClick={onTogglePanel}
          aria-label="工具活动与用量面板"
          title="工具活动与用量面板"
          className={`shrink-0 rounded-md border px-2.5 py-1 text-sm ${
            panelOpen ? "border-tavern-accent-dim text-tavern-accent" : "border-tavern-border bg-tavern-raised text-tavern-text hover:border-tavern-accent-dim"
          }`}
        >
          📊
        </button>
        <button type="button" onClick={onOpenLibrary} className="shrink-0 whitespace-nowrap rounded-md border border-tavern-border bg-tavern-raised px-3 py-1 text-sm text-tavern-text hover:border-tavern-accent-dim">资料库</button>
        <button
          type="button"
          onClick={onOpenSettings}
          className="shrink-0 whitespace-nowrap rounded-md border border-tavern-border bg-tavern-raised px-3 py-1 text-sm text-tavern-text hover:border-tavern-accent-dim"
        >
          设置
        </button>
      </div>
    </header>
  );
}
