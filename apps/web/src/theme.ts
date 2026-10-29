/** 主题预设与可自定义的 CSS 变量；自定义值以内联样式覆盖 body 上的主题变量。 */
export const THEME_LABELS: Record<string, string> = { night: "夜琥珀", grove: "林间绿", light: "羊皮纸" };

export interface ThemePalette {
  bg: string;
  panel: string;
  raised: string;
  border: string;
  accent: string;
  accentDim: string;
  text: string;
  dim: string;
}

export type ThemeKey = keyof ThemePalette;

export const THEME_KEYS: ThemeKey[] = ["bg", "panel", "raised", "border", "accent", "accentDim", "text", "dim"];

export const THEME_VARS: Record<ThemeKey, string> = {
  bg: "--color-tavern-bg",
  panel: "--color-tavern-panel",
  raised: "--color-tavern-raised",
  border: "--color-tavern-border",
  accent: "--color-tavern-accent",
  accentDim: "--color-tavern-accent-dim",
  text: "--color-tavern-text",
  dim: "--color-tavern-dim",
};

export const THEME_PALETTES: Record<string, ThemePalette> = {
  night: { bg: "#14121a", panel: "#1d1a26", raised: "#262233", border: "#35304a", accent: "#d4a24e", accentDim: "#9a7736", text: "#e8e2f0", dim: "#9c93b0" },
  grove: { bg: "#101613", panel: "#16201a", raised: "#1d2b22", border: "#2c4033", accent: "#7fbf8e", accentDim: "#56946a", text: "#e4efe6", dim: "#94ab9b" },
  light: { bg: "#f6f3ec", panel: "#efeae0", raised: "#e6dfd2", border: "#d4c9b4", accent: "#b07d2b", accentDim: "#8a6220", text: "#2d2a24", dim: "#7a7365" },
};

export const THEME_ROWS: { key: ThemeKey; label: string }[] = [
  { key: "bg", label: "背景色" },
  { key: "panel", label: "面板色" },
  { key: "raised", label: "浮起面板" },
  { key: "border", label: "边框色" },
  { key: "accent", label: "强调色" },
  { key: "accentDim", label: "强调暗色" },
  { key: "text", label: "文字色" },
  { key: "dim", label: "次要文字" },
];

export function validHex(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

/** 从 localStorage 读自定义色；未知键和坏值丢弃。 */
export function readCustomColors(raw: string | null): Partial<ThemePalette> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(THEME_KEYS.filter((key) => validHex(parsed[key])).map((key) => [key, parsed[key]])) as Partial<ThemePalette>;
  } catch {
    return {};
  }
}
