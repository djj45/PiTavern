import { useEffect, useRef, useState, type ReactNode } from "react";
import { THEME_LABELS, THEME_PALETTES, THEME_ROWS, type ThemeKey, type ThemePalette } from "../theme.ts";

interface TopBarProps {
  wsConnected: boolean;
  onOpenSettings: () => void;
  onOpenLibrary: () => void;
  panelOpen: boolean;
  onTogglePanel: () => void;
  theme: string;
  customColors: Partial<ThemePalette>;
  onSelectTheme: (theme: string) => void;
  onColorChange: (key: ThemeKey, value: string) => void;
  onResetColors: () => void;
  onToggleNav: () => void;
}

function Hint({ label, children }: { label: string; children: ReactNode }) {
  return <div className="group relative shrink-0">
    {children}
    <span role="tooltip" className="pointer-events-none absolute right-0 top-full z-[60] mt-1 hidden whitespace-nowrap rounded-md border border-tavern-border bg-tavern-raised px-2 py-1 text-[11px] font-normal text-tavern-text shadow-lg group-hover:block group-focus-within:block">
      {label}
    </span>
  </div>;
}

export function TopBar({
  wsConnected,
  onOpenSettings,
  onOpenLibrary,
  panelOpen,
  onTogglePanel,
  theme,
  customColors,
  onSelectTheme,
  onColorChange,
  onResetColors,
  onToggleNav,
}: TopBarProps) {
  const [themeOpen, setThemeOpen] = useState(false);
  const themeRef = useRef<HTMLDivElement>(null);
  const palette = { ...(THEME_PALETTES[theme] ?? THEME_PALETTES.night), ...customColors };
  const hasCustom = Object.keys(customColors).length > 0;

  useEffect(() => {
    if (!themeOpen) return;
    const closeOnPointer = (event: PointerEvent) => {
      if (!themeRef.current?.contains(event.target as Node)) setThemeOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setThemeOpen(false);
    };
    document.addEventListener("pointerdown", closeOnPointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [themeOpen]);

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
        <span className={"inline-block h-2 w-2 rounded-full " + (wsConnected ? "bg-emerald-500" : "bg-red-500")} />
        {wsConnected ? "在线" : "离线"}
      </div>
      <div className="flex w-full min-w-0 flex-wrap items-center justify-end gap-2 sm:ml-auto sm:w-auto sm:flex-1">
        <div ref={themeRef} className="group relative shrink-0">
          <button
            type="button"
            onClick={() => setThemeOpen((value) => !value)}
            aria-label="主题与配色"
            aria-expanded={themeOpen}
            className="shrink-0 whitespace-nowrap rounded-md border border-tavern-border bg-tavern-raised px-3 py-1 text-sm text-tavern-text hover:border-tavern-accent-dim"
          >
            主题
          </button>
          {!themeOpen && <span role="tooltip" className="pointer-events-none absolute right-0 top-full z-[60] mt-1 hidden whitespace-nowrap rounded-md border border-tavern-border bg-tavern-raised px-2 py-1 text-[11px] font-normal text-tavern-text shadow-lg group-hover:block group-focus-within:block">主题与配色</span>}
          {themeOpen && (
            <div role="dialog" aria-label="主题与配色"
              className="absolute right-0 top-full z-50 mt-2 w-80 max-w-[calc(100vw-1rem)] rounded-xl border border-tavern-border bg-tavern-panel p-3 text-xs shadow-2xl">
              <p className="mb-2 font-medium text-tavern-text">主题</p>
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(THEME_LABELS).map(([key, label]) => (
                  <button key={key} type="button" aria-pressed={theme === key}
                    onClick={() => onSelectTheme(key)}
                    className={"rounded-md border px-2.5 py-1.5 " + (theme === key
                      ? "border-tavern-accent bg-tavern-accent/15 text-tavern-accent"
                      : "border-tavern-border bg-tavern-bg text-tavern-dim hover:text-tavern-text")}>
                    {label}
                  </button>
                ))}
              </div>
              <div className="my-3 flex items-center justify-between">
                <span className="font-medium text-tavern-text">自由配色</span>
                <span className="text-tavern-dim">{hasCustom ? "已自定义" : "跟随预设"}</span>
              </div>
              <div className="flex flex-col gap-1.5">
                {THEME_ROWS.map(({ key, label }) => (
                  <label key={key} className="flex items-center gap-2">
                    <span className="w-16 shrink-0 text-tavern-dim">{label}</span>
                    <input type="color" aria-label={label} value={palette[key]}
                      onChange={(event) => onColorChange(key, event.target.value)}
                      className="h-6 w-9 cursor-pointer rounded border border-tavern-border bg-tavern-raised p-0" />
                    <span className="font-mono text-[10px] text-tavern-dim">{palette[key]}</span>
                  </label>
                ))}
              </div>
              <div className="mt-3 flex items-center justify-between border-t border-tavern-border pt-2">
                <span className="text-[10px] leading-4 text-tavern-dim">自定义颜色会覆盖预设，刷新后保留。</span>
                <button type="button" onClick={onResetColors} disabled={!hasCustom}
                  className="shrink-0 rounded border border-tavern-border px-2 py-1 text-tavern-dim hover:text-tavern-text disabled:opacity-40">
                  跟随预设
                </button>
              </div>
            </div>
          )}
        </div>
        <Hint label="用量与工具调用统计">
          <button
            type="button"
            onClick={onTogglePanel}
            aria-label="统计"
            className={"shrink-0 whitespace-nowrap rounded-md border px-3 py-1 text-sm " + (panelOpen
              ? "border-tavern-accent-dim bg-tavern-raised text-tavern-accent"
              : "border-tavern-border bg-tavern-raised text-tavern-text hover:border-tavern-accent-dim")}
          >
            统计
          </button>
        </Hint>
        <Hint label="世界书、正则脚本、备份与迁移等">
          <button type="button" onClick={onOpenLibrary} className="shrink-0 whitespace-nowrap rounded-md border border-tavern-border bg-tavern-raised px-3 py-1 text-sm text-tavern-text hover:border-tavern-accent-dim">资料</button>
        </Hint>
        <Hint label="模型连接与运行设置">
          <button
            type="button"
            onClick={onOpenSettings}
            className="shrink-0 whitespace-nowrap rounded-md border border-tavern-border bg-tavern-raised px-3 py-1 text-sm text-tavern-text hover:border-tavern-accent-dim"
          >
            设置
          </button>
        </Hint>
      </div>
    </header>
  );
}
