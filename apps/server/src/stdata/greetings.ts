import type { GreetingChoicesDto } from "@pitavern/shared";
import type { CharacterCard, StChatLine } from "./types.ts";

function preview(text: string): string {
  return text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
}

/** Read-only catalog, also works with old chats that predate stored opening swipes. */
export function greetingCatalog(lines: StChatLine[], card?: CharacterCard, group = false): {
  lineIndex: number; options: string[]; choices: GreetingChoicesDto;
} | undefined {
  if (group || lines.some((line) => line.is_user && !line.is_system)) return;
  const visible = lines.flatMap((line, lineIndex) => !line.is_system ? [{ line, lineIndex }] : []);
  if (visible.length !== 1 || visible[0].line.is_user || !visible[0].line.mes.trim()) return;
  const { line, lineIndex } = visible[0];
  const saved = line.swipes;
  let options = saved && saved.length > 1 && saved.every((text) => typeof text === "string" && text.trim()) ? [...saved]
    : [card?.firstMes ?? "", ...(card?.alternateGreetings ?? [])].filter((text) => text.trim());
  if (!options.includes(line.mes)) options = [line.mes, ...options];
  if (options.length < 2) return;
  const selected = Number.isInteger(line.swipe_id) && options[line.swipe_id!] === line.mes ? line.swipe_id! : options.indexOf(line.mes);
  // Some cards put a numbered scene index in their default introduction page.
  const titles = new Map<number, string>();
  for (const match of (card?.firstMes ?? "").matchAll(/^\s*(\d+)[.、．)]\s*([^\r\n]+)$/gm)) {
    titles.set(Number(match[1]), match[2].trim().slice(0, 100));
  }
  const labels = options.map((text, index) => {
    if (card?.firstMes && text === card.firstMes) return "默认开场";
    const alternate = card?.alternateGreetings.indexOf(text) ?? -1;
    if (alternate >= 0) return `开局 ${alternate + 1} · ${titles.get(alternate + 1) || preview(text)}`;
    return `${text === line.mes && !saved?.includes(text) ? "当前开场" : `开场 ${index + 1}`} · ${preview(text)}`;
  });
  return { lineIndex, options, choices: { selected, labels } };
}
